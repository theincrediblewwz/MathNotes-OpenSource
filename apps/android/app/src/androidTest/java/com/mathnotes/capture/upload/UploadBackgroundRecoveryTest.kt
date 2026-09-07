package com.mathnotes.capture.upload

import android.app.ForegroundServiceStartNotAllowedException
import android.content.Context
import android.os.SystemClock
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import androidx.work.ForegroundUpdater
import androidx.work.ListenableWorker
import androidx.work.WorkerFactory
import androidx.work.WorkerParameters
import androidx.work.impl.utils.futures.SettableFuture
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.workDataOf
import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.pairing.PairingStore
import com.mathnotes.capture.storage.CaptureEntity
import com.mathnotes.capture.storage.CaptureRepository
import com.mathnotes.capture.storage.CaptureState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
@SdkSuppress(minSdkVersion = 31)
class UploadBackgroundRecoveryTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val repository = CaptureRepository(context)
    private lateinit var server: MockWebServer
    private val captures = mutableListOf<CaptureEntity>()

    @Before fun start() { server = MockWebServer().apply { start() } }
    @After fun finish() = runBlocking {
        server.shutdown()
        captures.forEach { original ->
            repository.find(original.captureId)?.let { repository.deleteQueueTask(it) }
        }
    }

    @Test fun foregroundDenialStillUploadsAndStoresTheActualReceipt() = runBlocking {
        server.enqueue(accepted())
        val capture = capture()
        val worker = worker(capture, connected(), ExecutionException(ForegroundServiceStartNotAllowedException("background")))
        assertEquals(ListenableWorker.Result.success(), worker.doWork())
        val uploaded = repository.find(capture.captureId)!!
        assertEquals(CaptureState.UPLOADED, uploaded.state)
        assertEquals("background_receipt", uploaded.remoteUploadId)
        assertEquals(1, uploaded.attemptCount)
        assertTrue(File(uploaded.localPath).isFile)
        val request = server.takeRequest(2, TimeUnit.SECONDS)!!
        assertEquals("/api/v1/uploads", request.path)
        assertTrue(request.body.readUtf8().contains("processed-background-material"))
    }

    @Test fun offlineWakeupsPreserveAllAutomaticAttemptsAndTheMaterial() = runBlocking {
        val capture = capture()
        repeat(8) {
            val worker = worker(capture, UploadRuntime(hasConnectedNetwork = { false }, armOfflineWake = {}), AssertionError("must not promote"))
            assertEquals(ListenableWorker.Result.retry(), worker.doWork())
        }
        val pending = repository.find(capture.captureId)!!
        assertEquals(CaptureState.PENDING, pending.state)
        assertEquals(0, pending.attemptCount)
        assertEquals(0, server.requestCount)
        assertTrue(File(pending.localPath).isFile)
    }

    @Test fun deniedForegroundBudgetCancelsTheSocketAndPreservesARetryableCapture() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val cancelled = CountDownLatch(1)
        val client = OkHttpClient.Builder().eventListener(object : EventListener() {
            override fun callFailed(call: Call, ioe: IOException) { if (call.isCanceled()) cancelled.countDown() }
        }).build()
        val capture = capture()
        val runtime = UploadRuntime(hasConnectedNetwork = { true }, backgroundBudgetMillis = 700,
            transport = { OkHttpUploadTransport(client) })
        val started = SystemClock.elapsedRealtime()
        val result = worker(capture, runtime).doWork()
        assertEquals(ListenableWorker.Result.retry(), result)
        assertTrue("short injected budget must finish", SystemClock.elapsedRealtime() - started < 5_000)
        assertTrue("timeout must cancel the actual OkHttp call", cancelled.await(2, TimeUnit.SECONDS))
        val retryable = repository.find(capture.captureId)!!
        assertEquals(CaptureState.RETRYABLE, retryable.state)
        assertEquals(1, retryable.attemptCount)
        assertNotNull(retryable.nextAttemptAt)
        assertTrue(File(retryable.localPath).isFile)
        assertEquals(1, server.requestCount)
    }

    @Test fun externalCancellationRemainsCancellationAndPreservesThePhoto() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val capture = capture()
        val task = async { worker(capture, connected()).doWork() }
        assertNotNull(withContext(Dispatchers.IO) { server.takeRequest(3, TimeUnit.SECONDS) })
        task.cancelAndJoin()
        assertTrue(task.isCancelled)
        val paused = repository.find(capture.captureId)!!
        assertEquals(CaptureState.PAUSED, paused.state)
        assertTrue(File(paused.localPath).isFile)
    }

    @Test fun deadlineStillCancelsAfterHeadersArriveWhileTheReceiptBodyIsDelayed() = runBlocking {
        server.enqueue(accepted().setBodyDelay(5, TimeUnit.SECONDS))
        val headersArrived = CountDownLatch(1)
        val cancelled = CountDownLatch(1)
        val client = OkHttpClient.Builder().eventListener(object : EventListener() {
            override fun responseHeadersEnd(call: Call, response: okhttp3.Response) { headersArrived.countDown() }
            override fun callFailed(call: Call, ioe: IOException) { if (call.isCanceled()) cancelled.countDown() }
        }).build()
        val capture = capture()
        val runtime = UploadRuntime(hasConnectedNetwork = { true }, backgroundBudgetMillis = 700,
            transport = { OkHttpUploadTransport(client) })
        val started = SystemClock.elapsedRealtime()
        assertEquals(ListenableWorker.Result.retry(), worker(capture, runtime).doWork())
        assertTrue("headers must arrive before the timeout", headersArrived.await(1, TimeUnit.SECONDS))
        assertTrue("slow body must not hold the worker beyond its budget", SystemClock.elapsedRealtime() - started < 3_000)
        assertTrue("the body read must be cancelled on the actual call", cancelled.await(1, TimeUnit.SECONDS))
        val retryable = repository.find(capture.captureId)!!
        assertEquals(CaptureState.RETRYABLE, retryable.state)
        assertEquals(1, retryable.attemptCount)
        assertTrue(File(retryable.localPath).isFile)
    }

    @Test fun unrelatedForegroundSecurityFailuresAreNotSwallowedOrMarkedUploading() = runBlocking {
        val capture = capture()
        val failure = SecurityException("missing declaration")
        try {
            worker(capture, connected(), failure).doWork()
            fail("SecurityException must propagate")
        } catch (caught: SecurityException) { assertSame(failure, caught) }
        val pending = repository.find(capture.captureId)!!
        assertEquals(CaptureState.PENDING, pending.state)
        assertEquals(0, pending.attemptCount)
        assertEquals(0, server.requestCount)
    }

    @Test fun cancellationDuringForegroundPromotionIsNotConvertedToAnUpload() = runBlocking {
        val capture = capture()
        try {
            worker(capture, connected(), CancellationException("cancelled")).doWork()
            fail("CancellationException must propagate")
        } catch (_: CancellationException) { }
        assertEquals(0, repository.find(capture.captureId)!!.attemptCount)
        assertEquals(0, server.requestCount)
    }

    private fun connected() = UploadRuntime(hasConnectedNetwork = { true })
    private suspend fun capture(): CaptureEntity {
        val pairing = PairingConfig(version = 1, host = server.hostName, port = server.port,
            token = "background-test-token", notebookId = "background_test", sessionId = "synthetic", transport = "private_http")
        PairingStore(context).save(pairing)
        val source = File(context.cacheDir, "background-${System.nanoTime()}.jpg")
            .apply { writeText("processed-background-material") }
        return repository.commitCapturedFile(source, pairing).also(captures::add)
    }

    private fun worker(capture: CaptureEntity, runtime: UploadRuntime,
        failure: Throwable = ForegroundServiceStartNotAllowedException("background")): UploadWorker =
        TestListenableWorkerBuilder<UploadWorker>(context,
            inputData = workDataOf(UploadWorker.CAPTURE_ID to capture.captureId))
            .setWorkerFactory(object : WorkerFactory() {
                override fun createWorker(appContext: Context, workerClassName: String, workerParameters: WorkerParameters): ListenableWorker =
                    UploadWorker(appContext, workerParameters, runtime)
            })
            .setForegroundUpdater(ForegroundUpdater { _, _, _ -> SettableFuture.create<Void>().apply { setException(failure) } })
            .build()

    private fun accepted() = MockResponse().setResponseCode(202).setBody(
        """{"uploadId":"background_receipt","duplicate":false,"imageBlockId":"0010","recognitionJobId":"mock_job","recognitionStatus":"pending"}""")
}
