package com.mathnotes.capture

import android.graphics.Bitmap
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.SystemClock
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.util.Base64
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.BackoffPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.workDataOf
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
import com.mathnotes.capture.upload.UploadWorker
import com.mathnotes.capture.upload.hasConnectedUploadNetwork
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject
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
        val readiness = awaitRebootWorkReadiness(capture.captureId)
        File(context.filesDir, "e2e-reboot-before.json").writeText(readiness.toString(2), Charsets.UTF_8)
    }

    /** Remain inside instrumentation until this capture's real scheduler and receiver are ready. */
    private suspend fun awaitRebootWorkReadiness(captureId: String): JSONObject {
        val manager = WorkManager.getInstance(context)
        val scheduler = context.getSystemService(JobScheduler::class.java)
        val receiver = ComponentName(context, "androidx.work.impl.background.systemalarm.RescheduleReceiver")
        val deadline = SystemClock.elapsedRealtime() + 10_000
        var observed = JSONObject()
        while (SystemClock.elapsedRealtime() < deadline) {
            val work = manager.getWorkInfosForUniqueWork(UploadScheduler.workName(captureId))
                .get(5, TimeUnit.SECONDS).singleOrNull { !it.state.isFinished }
            val job = work?.let { expected -> scheduler.allPendingJobs.firstOrNull {
                it.service.className == "androidx.work.impl.background.systemjob.SystemJobService" &&
                    it.extras.getString("EXTRA_WORK_SPEC_ID") == expected.id.toString()
            } }
            val receiverSetting = context.packageManager.getComponentEnabledSetting(receiver)
            observed = JSONObject().put("captureId", captureId).put("workName", UploadScheduler.workName(captureId))
                .put("workSpecId", work?.id?.toString() ?: JSONObject.NULL)
                .put("workState", work?.state?.name ?: JSONObject.NULL)
                .put("jobId", job?.id ?: JSONObject.NULL)
                .put("requiresNetwork", job?.requiredNetwork != null)
                .put("receiverSetting", receiverSetting)
                .put("receiverEnabled", receiverSetting == PackageManager.COMPONENT_ENABLED_STATE_ENABLED)
                .put("observedAtEpochMs", System.currentTimeMillis())
            if (work?.state == WorkInfo.State.ENQUEUED && job != null &&
                receiverSetting == PackageManager.COMPONENT_ENABLED_STATE_ENABLED) return observed
            delay(100)
        }
        File(context.filesDir, "e2e-reboot-before.json").writeText(observed.toString(2), Charsets.UTF_8)
        error("The precise reboot capture did not reach scheduler/receiver readiness: $observed")
    }

    @Test
    fun verifiesDelayedUploadCompletedAfterDeviceReboot() = runBlocking {
        val marker = context.getSharedPreferences(REBOOT_MARKER, android.content.Context.MODE_PRIVATE)
        val captureId = marker.getString(REBOOT_CAPTURE_ID, null) ?: error("Missing reboot capture marker")
        val localPath = marker.getString(REBOOT_LOCAL_PATH, null) ?: error("Missing reboot path marker")
        val uploaded = awaitState(captureId, CaptureState.UPLOADED)

        assertEquals(202, uploaded.lastHttpStatus)
        assertTrue(File(localPath).isFile)
        File(context.filesDir, "e2e-reboot-after.json").writeText(JSONObject()
            .put("captureId", captureId).put("state", uploaded.state).put("attemptCount", uploaded.attemptCount)
            .put("uploadId", uploaded.remoteUploadId).put("recognitionJobId", uploaded.remoteRecognitionJobId)
            .put("materialRetained", File(localPath).isFile).put("observedAtEpochMs", System.currentTimeMillis())
            .toString(2), Charsets.UTF_8)
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
        val deadline = SystemClock.elapsedRealtime() + 30_000
        var observed = false
        while (SystemClock.elapsedRealtime() < deadline) {
            val capture = repository.find(captureId) ?: error("Capture disappeared: $captureId")
            if (capture.state == expected) return capture
            if (capture.state in terminalStates && capture.state != expected) {
                error("Capture stopped in ${capture.state}: ${capture.lastError}")
            }
            if (!observed && SystemClock.elapsedRealtime() > deadline - 29_000) {
                recordUploadScheduling(captureId, "waiting")
                observed = true
            }
            delay(100)
        }
        recordUploadScheduling(captureId, "timeout")
        error("Capture $captureId did not reach $expected")
    }

    @Test
    fun seedsOfflineUploadWithRealLongWorkManagerBackoff() = runBlocking {
        repeat(100) { if (!hasConnectedUploadNetwork(context)) return@repeat else delay(100) }
        assertTrue("The task emulator must actually be offline", !hasConnectedUploadNetwork(context))
        val cycle = requiredArg("networkCycle")
        val pairing = pairing()
        pairingStore.save(pairing)
        // Adjacent hash colors can quantize to identical JPEG bytes and correctly deduplicate.
        val capture = createCapture(pairing, if (cycle == "1") "network-first-cycle" else "network-second-cycle")
        assertTrue("Every network fixture must differ after JPEG compression", repository.captures.first()
            .none { it.captureId != capture.captureId && it.sha256 == capture.sha256 })
        val request = OneTimeWorkRequestBuilder<UploadWorker>()
            .setInputData(workDataOf(UploadWorker.CAPTURE_ID to capture.captureId))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.HOURS).build()
        WorkManager.getInstance(context).enqueueUniqueWork(UploadScheduler.workName(capture.captureId), ExistingWorkPolicy.REPLACE, request)
            .result.get(10, TimeUnit.SECONDS)
        var info: WorkInfo? = null
        repeat(100) {
            info = WorkManager.getInstance(context).getWorkInfoById(request.id).get()
            if (info?.state == WorkInfo.State.ENQUEUED && info!!.runAttemptCount >= 1) return@repeat
            delay(100)
        }
        assertEquals(WorkInfo.State.ENQUEUED, info?.state)
        assertEquals(1, info?.runAttemptCount)
        assertTrue("Must have a real long retry scheduled", info!!.nextScheduleTimeMillis > System.currentTimeMillis() + 30 * 60_000)
        assertEquals(0, repository.find(capture.captureId)!!.attemptCount)
        val generation = context.getSharedPreferences("upload_network_wake", Context.MODE_PRIVATE).getString("generation", null)
        assertNotNull("The real offline worker must register its system PendingIntent", generation)
        context.getSharedPreferences("e2e_network", Context.MODE_PRIVATE).edit()
            .putString("capture_$cycle", capture.captureId).commit()
        File(context.filesDir, "e2e-network-before-$cycle.json").writeText(JSONObject()
            .put("captureId", capture.captureId).put("workSpecId", request.id.toString())
            .put("sha256", capture.sha256)
            .put("workState", info!!.state.name).put("workAttempts", info!!.runAttemptCount)
            .put("captureAttempts", 0).put("nextScheduledAt", info!!.nextScheduleTimeMillis)
            .put("observedAt", System.currentTimeMillis()).put("connected", hasConnectedUploadNetwork(context))
            .put("generation", generation).toString(2), Charsets.UTF_8)
    }

    @Test
    fun verifiesUploadWokenByTheRealNetworkAfterProcessExit() = runBlocking {
        val cycle = requiredArg("networkCycle")
        val captureId = context.getSharedPreferences("e2e_network", Context.MODE_PRIVATE).getString("capture_$cycle", null)!!
        val capture = awaitState(captureId, CaptureState.UPLOADED)
        assertEquals(1, capture.attemptCount)
        assertNotNull(capture.remoteUploadId)
        assertTrue(File(capture.localPath).isFile)
        val work = WorkManager.getInstance(context).getWorkInfosForUniqueWork(UploadScheduler.workName(captureId)).get()
        assertEquals(1, work.count { it.state == WorkInfo.State.SUCCEEDED })
        File(context.filesDir, "e2e-network-after-$cycle.json").writeText(JSONObject()
            .put("captureId", captureId).put("state", capture.state).put("attemptCount", capture.attemptCount)
            .put("uploadId", capture.remoteUploadId).put("materialRetained", File(capture.localPath).isFile)
            .put("observedAt", System.currentTimeMillis()).toString(2), Charsets.UTF_8)
    }

    @Suppress("DEPRECATION")
    private suspend fun recordUploadScheduling(captureId: String, phase: String) {
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        val capabilities = connectivity.activeNetwork?.let(connectivity::getNetworkCapabilities)
        val work = WorkManager.getInstance(context).getWorkInfosForUniqueWork(UploadScheduler.workName(captureId))
            .get(5, TimeUnit.SECONDS).firstOrNull()
        val job = context.getSystemService(JobScheduler::class.java).allPendingJobs.firstOrNull {
            it.extras.getString("EXTRA_WORK_SPEC_ID") == work?.id?.toString()
        }
        val capture = repository.find(captureId)
        val probe = PairingVerifier().verify(pairing())
        val observed = JSONObject().put("phase", phase).put("captureId", captureId)
            .put("observedAtEpochMs", System.currentTimeMillis())
            .put("captureState", capture?.state).put("captureAttempts", capture?.attemptCount)
            .put("workSpecId", work?.id?.toString()).put("workState", work?.state?.name)
            .put("runAttemptCount", work?.runAttemptCount).put("jobId", job?.id)
            .put("requiredNetwork", job?.requiredNetwork?.toString())
            .put("connected", connectivity.activeNetworkInfo?.isConnected == true)
            .put("validated", capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true)
            .put("pairingProbe", probe.javaClass.simpleName)
        File(context.filesDir, "e2e-upload-scheduling.jsonl").appendText("$observed\n", Charsets.UTF_8)
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
