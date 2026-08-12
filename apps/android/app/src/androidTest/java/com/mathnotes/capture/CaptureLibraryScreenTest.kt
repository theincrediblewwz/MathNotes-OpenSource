package com.mathnotes.capture

import android.graphics.Bitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.mathnotes.capture.storage.CaptureEntity
import com.mathnotes.capture.storage.CaptureSource
import com.mathnotes.capture.storage.CaptureState
import com.mathnotes.capture.storage.MaterialType
import com.mathnotes.capture.ui.MathNotesTheme
import java.io.File
import org.junit.After
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

    private fun capture(
        localPath: String,
        localCopyAvailable: Boolean = true,
        materialType: String = MaterialType.IMAGE,
        mimeType: String = "image/jpeg",
        sourceName: String = "blackboard.jpg"
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
        state = CaptureState.UPLOADED,
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
