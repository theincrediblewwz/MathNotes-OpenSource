package com.mathnotes.capture

import android.graphics.Bitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.mathnotes.capture.storage.CaptureEntity
import com.mathnotes.capture.storage.CaptureSource
import com.mathnotes.capture.storage.CaptureState
import com.mathnotes.capture.storage.MaterialType
import com.mathnotes.capture.standalone.StandaloneBlockEntity
import com.mathnotes.capture.standalone.StandaloneBlockKind
import com.mathnotes.capture.standalone.StandaloneNotebookEntity
import com.mathnotes.capture.standalone.StandaloneRecognitionTaskEntity
import com.mathnotes.capture.standalone.StandaloneSessionEntity
import com.mathnotes.capture.standalone.StandaloneTaskStatus
import com.mathnotes.capture.ui.MathNotesTheme
import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CaptureLibraryScreenTest {
    @get:Rule
    val composeRule = createComposeRule()

    private var previewFile: File? = null

    @After
    fun tearDown() {
        previewFile?.delete()
    }

    @Test
    fun historyExpandsByComputerAndNotebook() {
        val capture = capture(localPath = "/missing/photo.jpg", localCopyAvailable = false)
        composeRule.setContent {
            MathNotesTheme { QueueScreen(listOf(capture), {}, {}, {}, {}, {}) }
        }

        composeRule.onNodeWithText("历史").performClick()
        composeRule.onNodeWithText("课堂电脑").performClick()
        composeRule.onNodeWithText("functional_analysis").performClick()

        composeRule.onNodeWithText("泛函分析第 3 讲").assertIsDisplayed()
        composeRule.onNodeWithText("本地副本已清理，上传回执仍保留").assertIsDisplayed()
    }

    @Test
    fun localImageOpensAFullScreenSourcePreview() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        previewFile = File(context.cacheDir, "preview-source.jpg").also { file ->
            val bitmap = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888)
            try {
                file.outputStream().use { output -> bitmap.compress(Bitmap.CompressFormat.JPEG, 90, output) }
            } finally {
                bitmap.recycle()
            }
        }
        composeRule.setContent {
            MathNotesTheme { QueueScreen(listOf(capture(previewFile!!.absolutePath)), {}, {}, {}, {}, {}) }
        }

        composeRule.onNodeWithText("blackboard.jpg").performClick()

        composeRule.onNodeWithText("原素材预览").assertIsDisplayed()
        composeRule.onNodeWithText("关闭").assertIsDisplayed()
    }

    @Test
    fun localPdfOpensAFilePreviewWithSystemReaderAction() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.filesDir, "documents").apply { mkdirs() }
        previewFile = File(directory, "lecture.pdf").also { it.writeBytes("%PDF-1.4\n%%EOF".toByteArray()) }
        val pdf = capture(
            localPath = previewFile!!.absolutePath,
            materialType = MaterialType.PDF,
            mimeType = "application/pdf",
            sourceName = "lecture.pdf"
        )
        composeRule.setContent {
            MathNotesTheme { QueueScreen(listOf(pdf), {}, {}, {}, {}, {}) }
        }

        composeRule.onNodeWithText("lecture.pdf").performClick()

        composeRule.onNodeWithText("用系统应用打开").assertIsDisplayed()
    }

    @Test
    fun longPressingUploadedHistoryRequiresConfirmationBeforeDeletion() {
        var deletedId: String? = null
        val uploaded = capture(localPath = "/missing/photo.jpg", localCopyAvailable = false)
        composeRule.setContent {
            MathNotesTheme {
                QueueScreen(
                    captures = listOf(uploaded),
                    onRetry = {},
                    onCancel = {},
                    onDelete = {},
                    onDeleteHistory = { deletedId = it.captureId },
                    onClearUploadedHistory = {},
                    onClearRecentUploaded = {}
                )
            }
        }
        composeRule.onNodeWithText("历史").performClick()
        composeRule.onNodeWithText("课堂电脑").performClick()
        composeRule.onNodeWithText("functional_analysis").performClick()

        composeRule.onNodeWithText("blackboard.jpg").performTouchInput { longClick() }
        composeRule.onNodeWithText("删除历史？").assertIsDisplayed()
        assertEquals(null, deletedId)
        composeRule.onNodeWithText("删除历史").performClick()
        assertEquals("capture-1", deletedId)
    }

    @Test
    fun longPressingPendingQueueTaskOffersDeletion() {
        var deletedId: String? = null
        val pending = capture(localPath = "/missing/pending.jpg", state = CaptureState.PENDING)
        composeRule.setContent {
            MathNotesTheme {
                QueueScreen(
                    captures = listOf(pending),
                    onDelete = {},
                    onRetry = {},
                    onCancel = {},
                    onClearRecentUploaded = {},
                    onClearUploadedHistory = {},
                    onDeleteTask = { deletedId = it.captureId }
                )
            }
        }

        composeRule.onNodeWithText("blackboard.jpg").performTouchInput { longClick() }
        composeRule.onNodeWithText("删除任务？").assertIsDisplayed()
        composeRule.onNodeWithText("删除任务").performClick()
        assertEquals("capture-1", deletedId)
    }

    @Test
    fun longPressingLocalRecognitionTaskOffersDeletion() {
        var deletedId: String? = null
        val notebook = StandaloneNotebookEntity("book-1", "泛函分析", 1, 1)
        val session = StandaloneSessionEntity("session-1", notebook.id, "第 3 讲", 1, 1)
        val block = StandaloneBlockEntity(
            id = "asset-1",
            sessionId = session.id,
            kind = StandaloneBlockKind.IMAGE,
            localPath = "/missing/local.jpg",
            markdown = "",
            locked = false,
            createdAt = 1,
            updatedAt = 1
        )
        val task = StandaloneRecognitionTaskEntity(
            id = "local-task-1",
            sessionId = session.id,
            assetBlockId = block.id,
            providerId = "deepseek",
            destination = "https://api.deepseek.com/chat/completions",
            model = "deepseek-v4-flash-exp",
            status = StandaloneTaskStatus.AWAITING_CONFIRMATION,
            createdAt = 1,
            updatedAt = 1
        )
        composeRule.setContent {
            MathNotesTheme {
                QueueScreen(
                    captures = emptyList(),
                    onDelete = {},
                    onRetry = {},
                    onCancel = {},
                    onClearRecentUploaded = {},
                    onClearUploadedHistory = {},
                    localTasks = listOf(task),
                    localBlocks = listOf(block),
                    localSessions = listOf(session),
                    localNotebooks = listOf(notebook),
                    onDeleteLocalTask = { deletedId = it.id }
                )
            }
        }

        composeRule.onNodeWithText("第 3 讲").performTouchInput { longClick() }
        composeRule.onNodeWithText("删除本机任务？").assertIsDisplayed()
        composeRule.onNodeWithText("删除任务").performClick()
        assertEquals("local-task-1", deletedId)
    }

    @Test
    fun tappingProcessedLocalTaskOpensPhotoDetail() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        previewFile = File(context.cacheDir, "processed-local.jpg").also { file ->
            val bitmap = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888)
            try {
                file.outputStream().use { output -> bitmap.compress(Bitmap.CompressFormat.JPEG, 90, output) }
            } finally {
                bitmap.recycle()
            }
        }
        val notebook = StandaloneNotebookEntity("book-preview", "泛函分析", 1, 1)
        val session = StandaloneSessionEntity("session-preview", notebook.id, "第 8 讲", 1, 1)
        val block = StandaloneBlockEntity(
            id = "asset-preview",
            sessionId = session.id,
            kind = StandaloneBlockKind.IMAGE,
            localPath = previewFile!!.absolutePath,
            markdown = "",
            locked = false,
            createdAt = 1,
            updatedAt = 1
        )
        val task = StandaloneRecognitionTaskEntity(
            id = "task-preview",
            sessionId = session.id,
            assetBlockId = block.id,
            providerId = "deepseek",
            destination = "https://api.deepseek.com/chat/completions",
            model = "deepseek-v4-flash-exp",
            status = StandaloneTaskStatus.SUCCEEDED,
            createdAt = 1,
            updatedAt = 1
        )
        composeRule.setContent {
            MathNotesTheme {
                QueueScreen(
                    captures = emptyList(),
                    onDelete = {},
                    onRetry = {},
                    onCancel = {},
                    onClearRecentUploaded = {},
                    onClearUploadedHistory = {},
                    localTasks = listOf(task),
                    localBlocks = listOf(block),
                    localSessions = listOf(session),
                    localNotebooks = listOf(notebook)
                )
            }
        }

        composeRule.onNodeWithText("第 8 讲").performClick()

        composeRule.onNodeWithContentDescription("第 8 讲 1 / 1").assertIsDisplayed()
        composeRule.onNodeWithText("关闭").assertIsDisplayed()
    }

    @Test
    fun recentGalleryOpensSquareItemAndConfirmsDetailDeletion() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        previewFile = File(context.cacheDir, "recent-gallery.jpg").also { file ->
            val bitmap = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888)
            try {
                file.outputStream().use { output -> bitmap.compress(Bitmap.CompressFormat.JPEG, 90, output) }
            } finally {
                bitmap.recycle()
            }
        }
        var deletedId: String? = null
        composeRule.setContent {
            MathNotesTheme {
                CapturePreviewGallery(
                    items = listOf(CaptureGalleryItem("recent-1", previewFile!!.absolutePath, "recent.jpg", true)),
                    onClose = {},
                    onDelete = { deletedId = it.id }
                )
            }
        }

        composeRule.onNodeWithText("最近拍摄").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("打开recent.jpg").performClick()
        composeRule.onNodeWithText("关闭").assertIsDisplayed()
        composeRule.onNodeWithTag("gallery-delete").performClick()
        composeRule.onNodeWithText("删除这张照片？").assertIsDisplayed()
        assertEquals(null, deletedId)
        composeRule.onNodeWithTag("confirm-gallery-delete").performClick()
        assertEquals("recent-1", deletedId)
    }

    private fun capture(
        localPath: String,
        localCopyAvailable: Boolean = true,
        materialType: String = MaterialType.IMAGE,
        mimeType: String = "image/jpeg",
        sourceName: String = "blackboard.jpg",
        state: String = CaptureState.UPLOADED
    ) = CaptureEntity(
        captureId = "capture-1",
        deviceId = "phone-1",
        localPath = localPath,
        mimeType = mimeType,
        byteLength = 123,
        sha256 = "abc",
        notebookId = "functional_analysis",
        sessionId = "lecture-3",
        endpointId = "192.168.137.1:43424",
        state = state,
        attemptCount = 1,
        nextAttemptAt = null,
        lastHttpStatus = 202,
        lastError = null,
        remoteUploadId = "upload-1",
        remoteRecognitionJobId = "recognition-1",
        createdAt = 1_000,
        updatedAt = 2_000,
        materialType = materialType,
        captureSource = CaptureSource.GALLERY,
        sourceName = sourceName,
        pairingProfileId = "pc-1",
        computerLabel = "课堂电脑",
        targetTitle = "泛函分析第 3 讲",
        localCopyAvailable = localCopyAvailable,
        completedAt = 2_000
    )
}
