package com.mathnotes.capture

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.core.content.FileProvider
import androidx.work.WorkManager
import androidx.work.workDataOf
import androidx.work.testing.TestListenableWorkerBuilder
import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.pairing.PairingStore
import com.mathnotes.capture.storage.CaptureState
import com.mathnotes.capture.storage.CaptureRepository
import com.mathnotes.capture.upload.OkHttpUploadTransport
import com.mathnotes.capture.upload.UploadOutcome
import com.mathnotes.capture.upload.UploadRecovery
import com.mathnotes.capture.upload.UploadScheduler
import com.mathnotes.capture.upload.UploadWorker
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class UploadTransportTest {
    private lateinit var server: MockWebServer

    @Before
    fun startServer() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun stopServer() {
        server.shutdown()
    }

    @Test
    fun sendsTheWindowsMultipartContractAndParsesTheDurableReceipt() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(202).setBody(
                """{"uploadId":"upload_test","duplicate":false,"imageBlockId":"0009","recognitionJobId":"recognition_0009","recognitionStatus":"pending"}"""
            )
        )
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val pairing = pairing()
        val file = File(context.cacheDir, "upload-contract-${System.nanoTime()}.jpg").apply {
            writeBytes("jpeg-contract-bytes".toByteArray())
        }
        val capture = CaptureRepository(context).commitCapturedFile(file, pairing, 1_782_000_000_000L)
        File(File(capture.localPath).parentFile, "${File(capture.localPath).nameWithoutExtension}.annotation.json").writeText(
            """{"version":1,"sourceAsset":"blackboard.jpg","sourceSha256":"${"a".repeat(64)}","outputAsset":"edited.png","outputMimeType":"image/png","operations":[],"createdAt":"2026-07-15T00:00:00.000Z"}"""
        )

        val outcome = OkHttpUploadTransport().upload(capture, pairing)
        assertTrue(outcome is UploadOutcome.Accepted)
        assertEquals("upload_test", (outcome as UploadOutcome.Accepted).receipt.uploadId)

        val request = server.takeRequest()
        assertEquals("/api/v1/uploads", request.path)
        assertEquals("Bearer test-token-123456", request.getHeader("Authorization"))
        val multipart = request.body.readUtf8()
        listOf("notebookId", "sessionId", "captureId", "deviceId", "createdAt", "sha256", "materialType", "sourceName", "material", "imageTransform").forEach {
            assertTrue("missing multipart field $it", multipart.contains("name=\"$it\""))
        }
        assertTrue(multipart.contains(capture.captureId))
        assertTrue(multipart.contains(capture.sha256))
        assertTrue(multipart.contains("jpeg-contract-bytes"))
    }

    @Test
    fun sendsPdfThroughTheSameMaterialContractWithoutAnImageBlockReceipt() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(202).setBody(
                """{"uploadId":"pdf_upload","materialType":"pdf","duplicate":false,"pageCount":2}"""
            )
        )
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val source = File(context.filesDir, "documents/source-${System.nanoTime()}.pdf").apply {
            parentFile?.mkdirs()
            writeBytes("%PDF-1.4\npdf-contract\n%%EOF".toByteArray())
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", source)
        val capture = CaptureRepository(context).importPdf(uri, pairing(), 1_782_000_000_001L)

        val outcome = OkHttpUploadTransport().upload(capture, pairing())
        assertTrue(outcome is UploadOutcome.Accepted)
        val receipt = (outcome as UploadOutcome.Accepted).receipt
        assertEquals("pdf", receipt.materialType)
        assertEquals(null, receipt.imageBlockId)

        val multipart = server.takeRequest().body.readUtf8()
        assertTrue(multipart.contains("name=\"materialType\""))
        assertTrue(multipart.contains("pdf"))
        assertTrue(multipart.contains("name=\"material\""))
        assertTrue(multipart.contains("application/pdf"))
        assertTrue(multipart.contains("pdf-contract"))

        source.delete()
        File(capture.localPath).delete()
        Unit
    }

    @Test
    fun recoverySchedulesOneDurableWorkerAndStoresTheWindowsReceipt() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(202).setBody(
                """{"uploadId":"upload_worker","duplicate":false,"imageBlockId":"0010","recognitionJobId":"recognition_0010","recognitionStatus":"pending"}"""
            )
        )
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val pairing = pairing()
        PairingStore(context).save(pairing)
        val repository = CaptureRepository(context)
        val file = File(context.cacheDir, "upload-worker-${System.nanoTime()}.jpg").apply {
            writeBytes("worker-jpeg-bytes".toByteArray())
        }
        val capture = repository.commitCapturedFile(file, pairing)
        repository.markFailure(
            capture.captureId,
            CaptureState.RETRYABLE,
            null,
            "test keeps scheduled work from racing the explicit worker",
            System.currentTimeMillis() + 60_000
        )
        val recovery = UploadRecovery(repository, UploadScheduler(context))

        recovery.enqueueOutstanding()
        recovery.enqueueOutstanding()

        delay(250)
        val workManager = WorkManager.getInstance(context)
        val scheduled = workManager
            .getWorkInfosForUniqueWork(UploadScheduler.workName(capture.captureId))
            .get()
        assertEquals(1, scheduled.size)
        workManager.cancelUniqueWork(UploadScheduler.workName(capture.captureId)).result.get()

        val worker = TestListenableWorkerBuilder<UploadWorker>(
            context = context,
            inputData = workDataOf(UploadWorker.CAPTURE_ID to capture.captureId)
        ).build()
        worker.doWork()

        val uploaded = repository.find(capture.captureId) ?: error("capture disappeared")
        assertEquals(CaptureState.UPLOADED, uploaded.state)
        assertEquals("upload_worker", uploaded.remoteUploadId)
        assertEquals("recognition_0010", uploaded.remoteRecognitionJobId)
        assertEquals(1, server.requestCount)
        assertTrue(PairingStore(context).clear())
        Unit
    }

    private fun pairing(): PairingConfig = PairingConfig(
        version = 1,
        host = server.hostName,
        port = server.port,
        token = "test-token-123456",
        notebookId = "functional_analysis",
        sessionId = "lecture",
        transport = "private_http"
    )
}
