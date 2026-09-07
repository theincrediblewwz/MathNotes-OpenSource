package com.mathnotes.capture.upload

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.ForegroundUpdater
import androidx.work.ListenableWorker
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.impl.utils.futures.SettableFuture
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.workDataOf
import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.pairing.PairingStore
import com.mathnotes.capture.storage.CaptureEntity
import com.mathnotes.capture.storage.CaptureRepository
import com.mathnotes.capture.storage.CaptureState
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class UploadNetworkRecoveryTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val repository = CaptureRepository(context)
    private val manager = WorkManager.getInstance(context)
    private val scheduler = UploadScheduler(context)
    private val captures = mutableListOf<CaptureEntity>()
    private lateinit var server: MockWebServer

    @Before fun start() {
        PairingStore(context).clear()
        OfflineNetworkWake.disarm(context)
        manager.cancelUniqueWork(NetworkRecoveryWorker.WORK_NAME).result.get()
        server = MockWebServer().apply { start() }
    }
    @After fun finish() = runBlocking {
        OfflineNetworkWake.disarm(context)
        manager.cancelUniqueWork(NetworkRecoveryWorker.WORK_NAME).result.get()
        captures.forEach {
            scheduler.cancel(it.captureId).result.get()
            repository.markCancelled(it.captureId)
            repository.find(it.captureId)?.let { item -> repository.deleteQueueTask(item) }
        }
        PairingStore(context).clear()
        server.shutdown()
    }

    @Test fun cancellationWhileWaitingOnTheMutexDoesNotPauseOrConsumeAnAttempt() = runBlocking {
        val capture = capture()
        UploadQueueLock.mutex.lock()
        try {
            val task = async { worker(capture).doWork() }
            delay(80)
            task.cancelAndJoin()
            val retained = repository.find(capture.captureId)!!
            assertEquals(CaptureState.PENDING, retained.state)
            assertEquals(0, retained.attemptCount)
        } finally { UploadQueueLock.mutex.unlock() }
        assertEquals(0, server.requestCount)
    }

    @Test fun workerWaitingForTheMutexRereadsPauseAndFutureAttemptBeforeUploading() = runBlocking {
        val paused = capture()
        val delayed = capture()
        val due = System.currentTimeMillis() + 60_000
        UploadQueueLock.mutex.lock()
        val pauseTask = async { worker(paused).doWork() }
        val delayedTask = async { worker(delayed).doWork() }
        try {
            delay(80)
            repository.markCancelled(paused.captureId)
            repository.markFailure(delayed.captureId, CaptureState.RETRYABLE, 503, "actual server backoff", due)
        } finally { UploadQueueLock.mutex.unlock() }
        assertEquals(ListenableWorker.Result.success(), pauseTask.await())
        assertEquals(ListenableWorker.Result.retry(), delayedTask.await())
        assertEquals(CaptureState.PAUSED, repository.find(paused.captureId)!!.state)
        assertEquals(due, repository.find(delayed.captureId)!!.nextAttemptAt)
        assertEquals(0, repository.find(delayed.captureId)!!.attemptCount)
        assertEquals(0, server.requestCount)
    }

    @Test fun pauseDuringForegroundPromotionPreventsAttemptAndLatePauseCannotOverwriteReceipt() = runBlocking {
        val paused = capture()
        val updater = ForegroundUpdater { _, _, _ ->
            runBlocking { repository.markCancelled(paused.captureId) }
            SettableFuture.create<Void>().apply { set(null) }
        }
        assertEquals(ListenableWorker.Result.success(), worker(paused, updater).doWork())
        assertEquals(CaptureState.PAUSED, repository.find(paused.captureId)!!.state)
        assertEquals(0, repository.find(paused.captureId)!!.attemptCount)
        assertEquals(0, server.requestCount)

        server.enqueue(accepted())
        val completed = capture()
        worker(completed).doWork()
        UploadPauseReceiver.pendingIntent(context, completed.captureId).send()
        delay(250)
        repository.markFailure(completed.captureId, CaptureState.RETRYABLE, 500, "late failure", null)
        val uploaded = repository.find(completed.captureId)!!
        assertEquals(CaptureState.UPLOADED, uploaded.state)
        assertEquals("network_receipt", uploaded.remoteUploadId)
        assertEquals(1, server.requestCount)
    }

    @Test fun recoveryRespectsDueTimeMaxAttemptsAndMissingPairing() = runBlocking {
        val delayed = capture()
        val exhausted = capture()
        repository.markFailure(delayed.captureId, CaptureState.RETRYABLE, 503, "backoff", System.currentTimeMillis() + 60_000)
        repeat(UploadPolicy.MAX_AUTOMATIC_ATTEMPTS) { assertNotNull(repository.markAttemptStarted(exhausted.captureId)) }
        scheduler.enqueue(delayed.captureId, initialDelayMillis = 60_000).result.get()
        recoverQueuedUploads(context)
        val current = repository.find(delayed.captureId)!!
        val info = manager.getWorkInfosForUniqueWork(UploadScheduler.workName(delayed.captureId)).get().single { !it.state.isFinished }
        assertTrue(info.nextScheduleTimeMillis >= current.nextAttemptAt!! - 100)
        assertTrue(manager.getWorkInfosForUniqueWork(UploadScheduler.workName(exhausted.captureId)).get().isEmpty())
        assertEquals(0, server.requestCount)
        PairingStore(context).clear()
        scheduler.cancel(delayed.captureId).result.get()
        recoverQueuedUploads(context)
        assertTrue(manager.getWorkInfosForUniqueWork(UploadScheduler.workName(delayed.captureId)).get().all { it.state.isFinished })
    }

    @Test fun recoveryTimeoutDoesNotCancelTheUploadHoldingTheMutex() = runBlocking {
        server.enqueue(accepted().setBodyDelay(500, TimeUnit.MILLISECONDS))
        val capture = capture()
        val task = async { worker(capture).doWork() }
        withTimeout(3_000) { while (server.requestCount == 0) delay(10) }
        assertNull(recoverQueuedUploads(context, budgetMillis = 50))
        assertEquals(ListenableWorker.Result.success(), task.await())
        assertEquals(CaptureState.UPLOADED, repository.find(capture.captureId)!!.state)
        assertEquals(1, server.requestCount)
    }

    @Test fun immediateRealNetworkNotificationReplacesOnlyTheRunningRecoveryWorker() = runBlocking {
        server.enqueue(accepted())
        val capture = capture()
        scheduler.enqueue(capture.captureId, initialDelayMillis = 3_600_000).result.get()
        UploadQueueLock.mutex.lock()
        try {
            NetworkRecoveryWorker.enqueue(context).result.get()
            val old = awaitRecovery { it.state == WorkInfo.State.RUNNING }
            assertTrue(OfflineNetworkWake.arm(context)) // Already online: platform delivers the real PI immediately.
            val replacement = awaitRecovery { it.id != old.id && !it.state.isFinished }
            assertNotEquals(old.id, replacement.id)
            assertEquals(0, server.requestCount)
            assertEquals(0, repository.find(capture.captureId)!!.attemptCount)
        } finally { UploadQueueLock.mutex.unlock() }
        repeat(100) {
            if (repository.find(capture.captureId)!!.state == CaptureState.UPLOADED) return@repeat
            delay(100)
        }
        assertEquals(CaptureState.UPLOADED, repository.find(capture.captureId)!!.state)
        assertEquals(1, server.requestCount)
    }

    private suspend fun awaitRecovery(predicate: (WorkInfo) -> Boolean): WorkInfo {
        repeat(100) {
            manager.getWorkInfosForUniqueWork(NetworkRecoveryWorker.WORK_NAME).get().firstOrNull(predicate)?.let { return it }
            delay(50)
        }
        error("Recovery did not reach expected state")
    }
    private suspend fun capture(): CaptureEntity {
        val pairing = PairingConfig(version = 1, host = server.hostName, port = server.port,
            token = "network-test-token", notebookId = "network_test", sessionId = "synthetic", transport = "private_http")
        PairingStore(context).save(pairing)
        return repository.commitCapturedFile(File(context.cacheDir, "network-${System.nanoTime()}.jpg").apply {
            writeText("processed-network-material")
        }, pairing).also(captures::add)
    }
    private fun worker(capture: CaptureEntity, updater: ForegroundUpdater? = null): UploadWorker {
        val builder = TestListenableWorkerBuilder<UploadWorker>(context, inputData = workDataOf(UploadWorker.CAPTURE_ID to capture.captureId))
        if (updater != null) builder.setForegroundUpdater(updater)
        return builder.build()
    }
    private fun accepted() = MockResponse().setResponseCode(202).setBody(
        """{"uploadId":"network_receipt","duplicate":false,"imageBlockId":"0010","recognitionJobId":"mock_job","recognitionStatus":"pending"}""")
}
