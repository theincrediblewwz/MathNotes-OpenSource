package com.mathnotes.capture.imageedit

import android.graphics.Bitmap
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.assertIsEnabled
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
        drawAcrossPreview()
        waitForUndoEnabled()
        composeRule.onNodeWithText("撤销").performClick()

        composeRule.onNodeWithText("箭头").performClick()
        drawAcrossPreview()
        waitForUndoEnabled()
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
