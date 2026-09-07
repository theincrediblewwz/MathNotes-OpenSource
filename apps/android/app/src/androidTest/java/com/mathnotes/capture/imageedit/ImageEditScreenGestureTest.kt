package com.mathnotes.capture.imageedit

import android.graphics.Bitmap
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.mathnotes.capture.ui.MathNotesTheme
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ImageEditScreenGestureTest {
    @get:Rule
    val composeRule = createComposeRule()

    private lateinit var source: File

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        source = File(context.cacheDir, "image-edit-gesture-test.png")
        FileOutputStream(source).use { output ->
            Bitmap.createBitmap(900, 600, Bitmap.Config.ARGB_8888).apply {
                eraseColor(android.graphics.Color.WHITE)
                compress(Bitmap.CompressFormat.PNG, 100, output)
                recycle()
            }
        }
    }

    @After
    fun tearDown() {
        source.delete()
    }

    @Test
    fun penAndArrowDragsCreateUndoableAnnotations() {
        val draft = ImageEditDraft(source, source.name, "image/png", "test")
        composeRule.setContent {
            MathNotesTheme {
                ImageEditScreen(
                    draft = draft,
                    saving = false,
                    message = null,
                    onApply = { _, _, _, _, _, _ -> },
                    onWorkingDraftChange = {},
                    onDiscard = {}
                )
            }
        }

        composeRule.waitUntil(timeoutMillis = 5_000) {
            runCatching {
                composeRule.onNodeWithContentDescription("待裁剪图片").fetchSemanticsNode()
                true
            }.getOrDefault(false)
        }

        composeRule.onNodeWithText("画笔").performClick()
        composeRule.onNodeWithText("笔", substring = false).performClick()
        drawAcrossPreview()
        waitForUndoEnabled()
        composeRule.onNodeWithText("撤销").performClick()

        composeRule.onNodeWithText("画笔 · 笔").performClick()
        composeRule.onNodeWithText("箭头").performClick()
        drawAcrossPreview()
        waitForUndoEnabled()
    }

    @Test
    fun cropHandleMatchesTheExportedImageCoordinatesWithCanvasPadding() {
        val appliedCrop = AtomicReference<NormalizedRect?>()
        composeRule.setContent {
            MathNotesTheme {
                ImageEditScreen(ImageEditDraft(source, source.name, "image/png", "test"), false, null,
                    onApply = { _, _, _, crop, _, _ -> appliedCrop.set(crop) }, onWorkingDraftChange = {}, onDiscard = {})
            }
        }
        waitForPreview()
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val density = context.resources.displayMetrics.density
        composeRule.onNodeWithContentDescription("待裁剪图片").performTouchInput {
            val display = imageDisplayRect(width.toFloat(), height.toFloat(), 900, 600, 24f * density)
            swipe(Offset(display.left + 1, display.top + 1), Offset(display.left + display.width * 0.2f, display.top + display.height * 0.2f), 450)
        }
        composeRule.onNodeWithText("应用并加入队列").performClick()
        composeRule.runOnIdle {
            val crop = requireNotNull(appliedCrop.get())
            assertEquals(0.2, crop.x, 0.003)
            assertEquals(0.2, crop.y, 0.003)
            assertEquals(0.8, crop.width, 0.003)
            assertEquals(0.8, crop.height, 0.003)
        }
    }

    @Test
    fun brushSubmenuCreatesWhiteRectangleAndRotationRetainsIt() {
        val appliedAnnotations = AtomicReference<List<ImageAnnotationObject>>(emptyList())
        Bitmap.createBitmap(900, 600, Bitmap.Config.ARGB_8888).apply {
            eraseColor(android.graphics.Color.rgb(48, 98, 76))
            val canvas = android.graphics.Canvas(this)
            val paint = android.graphics.Paint().apply { color = android.graphics.Color.WHITE; textSize = 34f }
            for (row in 1..8) canvas.drawText("MathNotes white cover fixture $row", 30f, row * 62f, paint)
            source.outputStream().use { compress(Bitmap.CompressFormat.PNG, 100, it) }; recycle()
        }
        composeRule.setContent {
            MathNotesTheme {
                ImageEditScreen(ImageEditDraft(source, source.name, "image/png", "test"), false, null,
                    onApply = { _, _, _, _, _, annotations -> appliedAnnotations.set(annotations) }, onWorkingDraftChange = {}, onDiscard = {})
            }
        }
        waitForPreview()
        composeRule.onNodeWithText("马赛克（矩形遮盖）").assertDoesNotExist()
        composeRule.onNodeWithText("画笔").performClick()
        persistentScreenshot("white-rectangle-brush-menu")
        composeRule.onNodeWithText("马赛克（矩形遮盖）").performClick()
        composeRule.onNodeWithText("画笔 · 马赛克").assertIsEnabled()
        composeRule.onNodeWithContentDescription("待裁剪图片").performTouchInput {
            swipe(Offset(center.x * 0.55f, center.y * 0.8f), Offset(center.x * 1.45f, center.y * 1.2f), 450)
        }
        waitForUndoEnabled()
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val screenshot = File(context.getExternalFilesDir("qa"), "image-editor-redaction.png")
        screenshot.parentFile?.mkdirs()
        screenshot.outputStream().use { composeRule.onNodeWithContentDescription("待裁剪图片").captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
        persistentScreenshot("white-rectangle-preview")
        composeRule.onNodeWithText("旋转 90°").performClick()
        persistentScreenshot("white-rectangle-rotated")
        composeRule.onNodeWithText("应用并加入队列").performClick()
        composeRule.runOnIdle {
            val redaction = appliedAnnotations.get().single() as ImageAnnotationObject.Redaction
            assertEquals("#ffffff", redaction.color)
            assertTrue(redaction.rectangular)
            assertTrue(redaction.points.size >= 2)
            assertTrue(redaction.points.maxOf { it.y } - redaction.points.minOf { it.y } > 0.3)
            assertTrue(redaction.points.maxOf { it.x } - redaction.points.minOf { it.x } > 0.1)
        }
    }

    private fun persistentScreenshot(name: String) {
        composeRule.waitForIdle()
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val file = File(context.getExternalFilesDir("qa"), "$name.png")
        val automation = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation
        automation.takeScreenshot().also { bitmap ->
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
        for (command in listOf("mkdir -p /sdcard/Download/MathNotes-feedback-v034-final", "cp ${file.absolutePath} /sdcard/Download/MathNotes-feedback-v034-final/$name.png")) {
            android.os.ParcelFileDescriptor.AutoCloseInputStream(automation.executeShellCommand(command)).use { it.readBytes() }
        }
    }

    private fun waitForPreview() {
        composeRule.waitUntil(timeoutMillis = 5_000) {
            runCatching { composeRule.onNodeWithContentDescription("待裁剪图片").fetchSemanticsNode(); true }.getOrDefault(false)
        }
    }

    private fun drawAcrossPreview() {
        composeRule.onNodeWithContentDescription("待裁剪图片").performTouchInput {
            swipe(
                start = Offset(center.x * 0.35f, center.y),
                end = Offset(center.x * 1.65f, center.y),
                durationMillis = 450
            )
        }
    }

    private fun waitForUndoEnabled() {
        composeRule.waitUntil(timeoutMillis = 3_000) {
            runCatching {
                composeRule.onNodeWithText("撤销").assertIsEnabled()
                true
            }.getOrDefault(false)
        }
    }
}
