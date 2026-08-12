package com.mathnotes.capture

import androidx.room.Room
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.storage.CaptureRepository
import com.mathnotes.capture.storage.CaptureSource
import com.mathnotes.capture.storage.CaptureState
import com.mathnotes.capture.storage.MathNotesDatabase
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CaptureRepositoryTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var database: MathNotesDatabase

    @Before
    fun setUp() {
        database = Room.inMemoryDatabaseBuilder(context, MathNotesDatabase::class.java).build()
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun fileIsHashedAndQueuedBeforeItCanBeRemoved() {
        runBlocking {
            val repository = CaptureRepository(context, database.captureDao())
            val file = repository.createOutputFile(1_234).apply { writeBytes("real-jpeg-bytes".toByteArray()) }
            val pairing = PairingConfig(
                1,
                "192.168.137.1",
                43424,
                "0123456789abcdef",
                "functional_analysis",
                "lecture",
                "private_http"
            )

            val capture = repository.commitCapturedFile(file, pairing, 5_678)

            assertEquals(CaptureState.PENDING, capture.state)
            assertEquals(file.length(), capture.byteLength)
            assertEquals("885ed0ffd0acf9f8c9973ccc59b24ca93fb1233b774b21e1deb4642b4d36b4f8", capture.sha256)
            assertEquals(capture, database.captureDao().find(capture.captureId))
            assertFalse(repository.deleteAcknowledged(capture))
            assertTrue(file.exists())
            file.delete()
        }
    }

    @Test
    fun userPausedCaptureIsNotRecoveredAutomatically() = runBlocking {
        val repository = CaptureRepository(context, database.captureDao())
        val file = repository.createOutputFile(2_345).apply { writeBytes("paused-jpeg".toByteArray()) }
        val pairing = PairingConfig(
            1,
            "192.168.137.1",
            43424,
            "0123456789abcdef",
            "functional_analysis",
            "lecture",
            "private_http"
        )
        val capture = repository.commitCapturedFile(file, pairing)

        repository.markCancelled(capture.captureId)

        assertEquals(CaptureState.PAUSED, repository.find(capture.captureId)?.state)
        assertFalse(repository.recoverable().any { it.captureId == capture.captureId })
        file.delete()
        Unit
    }

    @Test
    fun rePairingRecoversOnlyBlockedUploadsForTheSameProfile() = runBlocking {
        val repository = CaptureRepository(context, database.captureDao())
        val oldPairing = PairingConfig(
            version = 1,
            host = "192.168.137.1",
            port = 43424,
            token = "0123456789abcdef",
            notebookId = "functional_analysis",
            sessionId = "lecture",
            transport = "private_http",
            profileId = "pc-primary"
        )
        val firstFile = repository.createOutputFile(2_346).apply { writeBytes("blocked-a".toByteArray()) }
        val otherFile = repository.createOutputFile(2_347).apply { writeBytes("blocked-b".toByteArray()) }
        val blocked = repository.commitCapturedFile(firstFile, oldPairing)
        val other = repository.commitCapturedFile(otherFile, oldPairing.copy(profileId = "pc-other"))
        repository.markFailure(blocked.captureId, CaptureState.BLOCKED_AUTH, 401, "expired", null)
        repository.markFailure(other.captureId, CaptureState.BLOCKED_AUTH, 401, "expired", null)

        val recovered = repository.prepareBlockedAuthRetries(
            oldPairing.copy(host = "100.92.105.105", endpointUrl = "http://100.92.105.105:43424")
        )

        assertEquals(listOf(blocked.captureId), recovered)
        assertEquals(CaptureState.PENDING, repository.find(blocked.captureId)?.state)
        assertEquals("http://100.92.105.105:43424", repository.find(blocked.captureId)?.endpointId)
        assertEquals(CaptureState.BLOCKED_AUTH, repository.find(other.captureId)?.state)
        firstFile.delete()
        otherFile.delete()
        Unit
    }

    @Test
    fun deletingUploadedLocalCopyKeepsTheHistoricalReceipt() = runBlocking {
        val repository = CaptureRepository(context, database.captureDao())
        val file = repository.createOutputFile(3_456).apply { writeBytes("uploaded-jpeg".toByteArray()) }
        val capture = repository.commitCapturedFile(
            file,
            PairingConfig(
                version = 1,
                host = "192.168.137.1",
                port = 43424,
                token = "0123456789abcdef",
                notebookId = "functional_analysis",
                sessionId = "lecture",
                transport = "private_http",
                profileId = "pc-primary",
                computerLabel = "课堂电脑"
            )
        )
        repository.markUploaded(capture.captureId, 202, "upload-7", "recognition-7", now = 4_000)
        val uploaded = repository.find(capture.captureId)!!

        assertTrue(repository.deleteAcknowledged(uploaded))

        val history = repository.find(capture.captureId)!!
        assertFalse(file.exists())
        assertFalse(history.localCopyAvailable)
        assertEquals("upload-7", history.remoteUploadId)
        assertEquals("recognition-7", history.remoteRecognitionJobId)
        assertEquals(4_000L, history.completedAt)
    }

    @Test
    fun selectedImageIsCopiedPrivatelyAndQueuedWithGalleryMetadata() = runBlocking {
        val repository = CaptureRepository(context, database.captureDao())
        val pairing = PairingConfig(
            version = 1,
            host = "192.168.137.1",
            port = 43424,
            token = "0123456789abcdef",
            notebookId = "functional_analysis",
            sessionId = "lecture",
            transport = "private_http",
            profileId = "pc-primary",
            computerLabel = "课堂电脑"
        )
        val source = Uri.parse("android.resource://${context.packageName}/${R.drawable.ic_mathnotes_camera}")

        val imported = repository.importImage(source, pairing, now = 5_000)

        assertEquals(CaptureState.PENDING, imported.state)
        assertEquals(CaptureSource.GALLERY, imported.captureSource)
        assertEquals("pc-primary", imported.pairingProfileId)
        assertTrue(imported.localCopyAvailable)
        assertTrue(java.io.File(imported.localPath).isFile)
        assertTrue(imported.byteLength > 0)
        java.io.File(imported.localPath).delete()
        Unit
    }

    @Test
    fun clearingRecentOnlyHidesUploadedRowsAndKeepsHistoryReceipt() = runBlocking {
        val repository = CaptureRepository(context, database.captureDao())
        val file = repository.createOutputFile(5_500).apply { writeBytes("recent-jpeg".toByteArray()) }
        val capture = repository.commitCapturedFile(
            file,
            PairingConfig(1, "192.168.137.1", 43424, "0123456789abcdef", "analysis", "lecture", "private_http")
        )
        repository.markUploaded(capture.captureId, 202, "upload-recent", "recognition-recent")

        assertEquals(1, repository.clearRecentUploaded())
        val preserved = repository.find(capture.captureId)!!
        assertTrue(preserved.hiddenFromRecent)
        assertEquals("upload-recent", preserved.remoteUploadId)
        assertTrue(file.isFile)
        file.delete()
        Unit
    }

    @Test
    fun manualRetryRebindsAQueuedMaterialToTheActivePairing() = runBlocking {
        val repository = CaptureRepository(context, database.captureDao())
        val file = repository.createOutputFile(6_000).apply { writeBytes("retry-jpeg".toByteArray()) }
        val oldPairing = PairingConfig(
            version = 1,
            host = "192.168.137.1",
            port = 43424,
            token = "old-token-0123456789",
            notebookId = "old-book",
            sessionId = "old-session",
            transport = "private_http",
            profileId = "old-pc",
            computerLabel = "旧电脑"
        )
        val capture = repository.commitCapturedFile(file, oldPairing)
        repository.markFailure(
            capture.captureId,
            CaptureState.BLOCKED_AUTH,
            401,
            "目标电脑已变化",
            null
        )
        val currentPairing = oldPairing.copy(
            host = "192.168.43.20",
            port = 50512,
            token = "new-token-0123456789",
            notebookId = "new-book",
            sessionId = "new-session",
            profileId = "new-pc",
            computerLabel = "课堂笔记本",
            targetTitle = "偏微分方程"
        )

        assertTrue(repository.prepareManualRetry(capture.captureId, currentPairing, now = 7_000))

        val rebound = repository.find(capture.captureId)!!
        assertEquals(CaptureState.PENDING, rebound.state)
        assertEquals("http://192.168.43.20:50512", rebound.endpointId)
        assertEquals("new-pc", rebound.pairingProfileId)
        assertEquals("old-book", rebound.notebookId)
        assertEquals("old-session", rebound.sessionId)
        assertEquals("课堂笔记本", rebound.computerLabel)
        assertEquals("old-session", rebound.targetTitle)
        assertEquals(0, rebound.attemptCount)
        assertEquals(null, rebound.lastHttpStatus)
        assertEquals(null, rebound.lastError)
        assertTrue(file.isFile)
        file.delete()
        Unit
    }
}
