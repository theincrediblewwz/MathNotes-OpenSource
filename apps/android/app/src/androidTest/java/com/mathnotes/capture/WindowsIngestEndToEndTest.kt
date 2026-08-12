package com.mathnotes.capture

import android.graphics.Bitmap
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.core.content.FileProvider
import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.pairing.PairingCredentialKind
import com.mathnotes.capture.pairing.PairingParseResult
import com.mathnotes.capture.pairing.PairingStore
import com.mathnotes.capture.pairing.PairingTarget
import com.mathnotes.capture.pairing.PairingVerificationResult
import com.mathnotes.capture.pairing.PairingVerifier
import com.mathnotes.capture.companion.CompanionApiClient
import com.mathnotes.capture.companion.CompanionAssetStore
import com.mathnotes.capture.companion.CompanionDatabase
import com.mathnotes.capture.companion.CompanionContentStore
import com.mathnotes.capture.companion.CompanionRepository
import com.mathnotes.capture.storage.CaptureEntity
import com.mathnotes.capture.storage.CaptureRepository
import com.mathnotes.capture.storage.CaptureState
import com.mathnotes.capture.upload.UploadScheduler
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class WindowsIngestEndToEndTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val repository = CaptureRepository(context)
    private val scheduler = UploadScheduler(context)
    private val pairingStore = PairingStore(context)
    private val args = InstrumentationRegistry.getArguments()

    @Before
    fun requireExternalEndpointArguments() {
        assumeTrue("Run through npm run test:android-windows-e2e", !args.getString("ingestHost").isNullOrBlank())
    }

    @Test
    fun uploadsToWindowsAndReusesTheDurableReceipt() = runBlocking {
        val pairing = pairing()
        pairingStore.save(pairing)
        val capture = createCapture(pairing, "first")

        scheduler.enqueue(capture.captureId, replace = true)
        val first = awaitState(capture.captureId, CaptureState.UPLOADED)
        assertEquals(202, first.lastHttpStatus)
        assertNotNull(first.remoteUploadId)
        assertNotNull(first.remoteRecognitionJobId)

        assertTrue(repository.prepareManualRetry(capture.captureId, pairing))
        scheduler.enqueue(capture.captureId, replace = true)
        val duplicate = awaitState(capture.captureId, CaptureState.UPLOADED)
        assertEquals(200, duplicate.lastHttpStatus)
        assertEquals(first.remoteUploadId, duplicate.remoteUploadId)
        assertEquals(first.remoteRecognitionJobId, duplicate.remoteRecognitionJobId)
        assertTrue(File(duplicate.localPath).isFile)
    }

    @Test
    fun uploadsPdfToWindowsWithoutStartingRecognition() = runBlocking {
        val pairing = pairing()
        pairingStore.save(pairing)
        val source = File(context.filesDir, "documents/e2e-${System.nanoTime()}.pdf").apply {
            parentFile?.mkdirs()
            writeBytes(minimalPdf())
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", source)
        val capture = repository.importPdf(uri, pairing)

        scheduler.enqueue(capture.captureId, replace = true)
        val uploaded = awaitState(capture.captureId, CaptureState.UPLOADED)

        assertEquals(202, uploaded.lastHttpStatus)
        assertNotNull(uploaded.remoteUploadId)
        assertEquals(null, uploaded.remoteRecognitionJobId)
        assertTrue(File(uploaded.localPath).isFile)
    }

    @Test
    fun preservesThePhotoWhenTheWindowsEndpointIsInterrupted() = runBlocking {
        val pairing = pairing()
        pairingStore.save(pairing)
        val capture = createCapture(pairing, "interrupted")

        scheduler.enqueue(capture.captureId, replace = true)
        val retryable = awaitState(capture.captureId, CaptureState.RETRYABLE)
        assertTrue(File(retryable.localPath).isFile)
        scheduler.cancel(capture.captureId)
        repository.markCancelled(capture.captureId)
        assertEquals(CaptureState.PAUSED, repository.find(capture.captureId)?.state)
    }

    @Test
    fun uploadsAfterTheWindowsServerRestarts() = runBlocking {
        val pairing = pairing()
        pairingStore.save(pairing)
        val capture = createCapture(pairing, "after-restart")

        scheduler.enqueue(capture.captureId, replace = true)
        val uploaded = awaitState(capture.captureId, CaptureState.UPLOADED)
        assertEquals(202, uploaded.lastHttpStatus)
        assertTrue(File(uploaded.localPath).isFile)
    }

    @Test
    fun blocksAnInvalidPairingTokenWithoutDeletingThePhoto() = runBlocking {
        val valid = pairing()
        val invalid = valid.copy(token = "invalid-token-123456789")
        pairingStore.save(invalid)
        val capture = createCapture(invalid, "bad-token")

        scheduler.enqueue(capture.captureId, replace = true)
        val blocked = awaitState(capture.captureId, CaptureState.BLOCKED_AUTH)
        assertEquals(401, blocked.lastHttpStatus)
        assertTrue(File(blocked.localPath).isFile)
    }

    @Test
    fun verifiesPairingWithoutCreatingContent() = runBlocking {
        repeat(30) {
            if (PairingVerifier().verify(pairing()) is PairingVerificationResult.Verified) return@runBlocking
            delay(200)
        }
        assertTrue(PairingVerifier().verify(pairing()) is PairingVerificationResult.Verified)
    }

    @Test
    fun exchangesOneTimeChallengeForDeviceCredential() = runBlocking {
        val pairingPayload = String(
            Base64.decode(requiredArg("devicePairingPayloadB64"), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING),
            Charsets.UTF_8
        )
        val parsed = PairingConfig.parse(pairingPayload)
        assertTrue(parsed is PairingParseResult.Success)
        val challenge = (parsed as PairingParseResult.Success).config
        assertEquals(PairingCredentialKind.CHALLENGE, challenge.credentialKind)

        val verified = PairingVerifier(deviceLabel = "Android E2E device").verify(challenge)
        assertTrue(verified is PairingVerificationResult.Verified)
        val config = (verified as PairingVerificationResult.Verified).config
        assertEquals(PairingCredentialKind.DEVICE, config.credentialKind)
        assertTrue(config.deviceId.isNotBlank())
        assertTrue(config.token.isNotBlank())
        assertTrue(pairingStore.save(config))
    }

    @Test
    fun rejectsRevokedDeviceCredential() = runBlocking {
        val stored = pairingStore.load() ?: error("Missing exchanged device credential")
        assertEquals(PairingCredentialKind.DEVICE, stored.credentialKind)
        assertTrue(PairingVerifier().verify(stored) is PairingVerificationResult.Unauthorized)
    }

    @Test
    fun syncsTheWindowsCompanionSnapshotAndAssetOnAndroid() = runBlocking {
        val pairing = pairing()
        val target = PairingTarget(pairing.notebookId, pairing.sessionId, pairing.targetTitle)
        val assetStore = CompanionAssetStore(context)
        val contentStore = CompanionContentStore(context)
        val repository = CompanionRepository(
            CompanionDatabase.get(context).sessionDao(),
            CompanionApiClient(assetStore = assetStore, contentStore = contentStore),
            contentStore = contentStore
        )

        repository.refresh(pairing, target)

        val cached = repository.sessions(pairing).first().single {
            it.notebookId == target.notebookId && it.sessionId == target.sessionId
        }
        assertTrue(cached.markdown.contains("Android companion asset probe"))
        assertTrue(cached.html.contains("mathnotes-companion-asset://"))
        val snapshot = CompanionApiClient(assetStore = assetStore, contentStore = contentStore)
            .fetchSession(pairing, target)
        val asset = snapshot.assets.single { it.path.endsWith("companion-probe.png") }
        assertEquals(3L * 1024L * 1024L, assetStore.read(pairing, target, asset.id)?.file?.length())
    }

    @Test
    fun seedsDelayedUploadForDeviceReboot() = runBlocking {
        val pairing = pairing()
        pairingStore.save(pairing)
        val capture = createCapture(pairing, "device-reboot")
        context.getSharedPreferences(REBOOT_MARKER, android.content.Context.MODE_PRIVATE)
            .edit()
            .putString(REBOOT_CAPTURE_ID, capture.captureId)
            .putString(REBOOT_LOCAL_PATH, capture.localPath)
            .commit()

        scheduler.enqueue(capture.captureId, replace = true, initialDelayMillis = 45_000)
            .result
            .get(10, TimeUnit.SECONDS)
        assertEquals(CaptureState.PENDING, repository.find(capture.captureId)?.state)
    }

    @Test
    fun verifiesDelayedUploadCompletedAfterDeviceReboot() = runBlocking {
        val marker = context.getSharedPreferences(REBOOT_MARKER, android.content.Context.MODE_PRIVATE)
        val captureId = marker.getString(REBOOT_CAPTURE_ID, null) ?: error("Missing reboot capture marker")
        val localPath = marker.getString(REBOOT_LOCAL_PATH, null) ?: error("Missing reboot path marker")
        val uploaded = awaitState(captureId, CaptureState.UPLOADED)

        assertEquals(202, uploaded.lastHttpStatus)
        assertTrue(File(localPath).isFile)
    }

    private suspend fun createCapture(pairing: PairingConfig, label: String): CaptureEntity {
        val file = repository.createOutputFile().apply {
            outputStream().use { output ->
                val bitmap = Bitmap.createBitmap(24, 24, Bitmap.Config.ARGB_8888)
                bitmap.eraseColor(0xff000000.toInt() or (label.hashCode() and 0x00ffffff))
                check(bitmap.compress(Bitmap.CompressFormat.JPEG, 92, output))
                bitmap.recycle()
            }
        }
        check(file.length() > 0) { "JPEG fixture was not written for $label" }
        return repository.commitCapturedFile(file, pairing)
    }

    private suspend fun awaitState(captureId: String, expected: String): CaptureEntity {
        repeat(300) {
            val capture = repository.find(captureId) ?: error("Capture disappeared: $captureId")
            if (capture.state == expected) return capture
            if (capture.state in terminalStates && capture.state != expected) {
                error("Capture stopped in ${capture.state}: ${capture.lastError}")
            }
            delay(100)
        }
        error("Capture $captureId did not reach $expected")
    }

    private fun pairing(): PairingConfig = PairingConfig(
        version = 1,
        host = requiredArg("ingestHost"),
        port = requiredArg("ingestPort").toInt(),
        token = requiredArg("ingestToken"),
        notebookId = requiredArg("notebookId"),
        sessionId = requiredArg("sessionId"),
        transport = "private_http"
    )

    private fun requiredArg(name: String): String =
        args.getString(name)?.takeIf { it.isNotBlank() } ?: error("Missing instrumentation argument: $name")

    private fun minimalPdf(): ByteArray {
        val objects = listOf(
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R >>",
            "<< /Length 0 >>\nstream\n\nendstream"
        )
        val body = StringBuilder("%PDF-1.4\n")
        val offsets = mutableListOf<Int>()
        objects.forEachIndexed { index, obj ->
            offsets += body.toString().toByteArray(Charsets.US_ASCII).size
            body.append("${index + 1} 0 obj\n$obj\nendobj\n")
        }
        val xrefOffset = body.toString().toByteArray(Charsets.US_ASCII).size
        body.append("xref\n0 ${objects.size + 1}\n0000000000 65535 f \n")
        offsets.forEach { offset -> body.append(offset.toString().padStart(10, '0')).append(" 00000 n \n") }
        body.append("trailer\n<< /Size ${objects.size + 1} /Root 1 0 R >>\nstartxref\n$xrefOffset\n%%EOF\n")
        return body.toString().toByteArray(Charsets.US_ASCII)
    }

    companion object {
        private const val REBOOT_MARKER = "android_reboot_acceptance"
        private const val REBOOT_CAPTURE_ID = "capture_id"
        private const val REBOOT_LOCAL_PATH = "local_path"
        private val terminalStates = setOf(
            CaptureState.UPLOADED,
            CaptureState.PAUSED,
            CaptureState.BLOCKED_AUTH,
            CaptureState.FAILED_PERMANENT
        )
    }
}
