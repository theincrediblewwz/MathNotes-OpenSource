package com.mathnotes.capture.standalone

import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.view.View
import android.webkit.WebView
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.room.Room
import androidx.core.content.FileProvider
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.Espresso
import androidx.test.espresso.UiController
import androidx.test.espresso.ViewAction
import androidx.test.espresso.matcher.ViewMatchers
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.mathnotes.capture.ui.MathNotesTheme
import com.mathnotes.capture.ui.MathNotesThemeId
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import org.hamcrest.Matcher
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RecognitionSourceImageIntegrationTest {
    @get:Rule val composeRule = createComposeRule()
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private lateinit var database: StandaloneDatabase
    private lateinit var repository: StandaloneRepository
    private val cleanup = mutableListOf<File>()

    @Before fun setUp() {
        database = Room.inMemoryDatabaseBuilder(context, StandaloneDatabase::class.java).build()
        repository = StandaloneRepository(context, database)
    }

    @After fun tearDown() { database.close(); cleanup.forEach { it.delete() } }

    @Test fun persistsOnlyThisTasksActuallySubmittedProcessedPhotoAndRejectsAnotherPhoto() = runBlocking {
        val first = recognizedFixture()
        val stored = requireNotNull(repository.findBlock(requireNotNull(repository.findTask(first.task.id)?.resultBlockId)))
        assertTrue(stored.markdown.contains("保留图形的解释"))
        assertTrue(stored.markdown.contains("![识别照片（已处理）](${first.link})"))
        assertTrue(stored.markdown.contains("```\n$SOURCE_IMAGE_MARKER\n```"))
        val otherTask = repository.importCapturedFile(first.session.id, first.image, profile())
        val otherClaim = requireNotNull(repository.claimAfterUserConfirmation(otherTask.id))
        val otherAsset = requireNotNull(repository.findBlock(otherTask.assetBlockId))
        cleanup += File(otherAsset.localPath)
        repository.completeRecognition(otherClaim, "另一张照片说明\n$SOURCE_IMAGE_MARKER", first.image)
        val wrong = requireNotNull(repository.findBlock(requireNotNull(repository.findTask(otherTask.id)?.resultBlockId)))
        assertEquals("另一张照片说明\n_识别照片不可用_", wrong.markdown)
    }

    @Test fun readerImageRequestsUseOnlyAssociatedAssetsAndKeepTheirActualPixels() = runBlocking {
        val fixture = recognizedFixture()
        val images = fixtureImages(fixture)
        val url = Uri.parse("https://appassets.androidplatform.net/assets/${fixture.link}")
        val response = requireNotNull(standaloneReaderImageResponse(url, images))
        assertArrayEquals(fixture.image.readBytes(), response.data.use { it.readBytes() })
        assertEquals("image/png", response.mimeType)
        for (invalid in listOf("source-images/missing/asset", "source-images/${fixture.task.id}/%2e%2e", "${fixture.link}?path=/data/secret")) {
            assertEquals(404, standaloneReaderImageResponse(Uri.parse("https://appassets.androidplatform.net/assets/$invalid"), images)?.statusCode)
        }
        assertTrue(standaloneReaderImages(context, "another-session", database.dao().findBlocksForSession(fixture.session.id), listOf(requireNotNull(repository.findTask(fixture.task.id)))).isEmpty())
        val asset = requireNotNull(repository.findBlock(fixture.task.assetBlockId))
        assertEquals(null, trustedStandaloneSourceFile(context, fixture.session.id, asset.copy(localPath = File(context.cacheDir, "wrong.png").absolutePath)))
    }

    @Test fun realSessionAndNotebookExportsCarryOnlyTheProcessedPhotoInsideMarkdown() = runBlocking {
        val fixture = recognizedFixture()
        val directory = File(context.filesDir, "documents").apply { mkdirs() }
        for (notebook in listOf(false, true)) {
            val file = File(directory, "source-image-export-${System.nanoTime()}.md")
            cleanup += file
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
            if (notebook) repository.exportNotebookMarkdown(fixture.session.notebookId, uri)
            else repository.exportSessionMarkdown(fixture.session.id, uri)
            val markdown = file.readText()
            println("Portable source-image export: notebook=$notebook bytes=${file.length()} imageBytes=${fixture.image.length()} format=single-markdown-data-url")
            assertTrue(markdown.contains("保留图形的解释"))
            assertFalse(markdown.contains("source-images/"))
            assertFalse(markdown.contains(fixture.image.absolutePath))
            val encoded = Regex("data:image/png;base64,([A-Za-z0-9+/=]+)").findAll(markdown).toList()
            assertEquals(1, encoded.size)
            val bytes = java.util.Base64.getDecoder().decode(encoded.single().groupValues[1])
            assertArrayEquals(fixture.image.readBytes(), bytes)
            val bitmap = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            assertEquals(80, bitmap.width)
            assertEquals(60, bitmap.height)
            assertEquals(Color.BLACK, bitmap.getPixel(30, 30))
            bitmap.recycle()
        }
    }

    @Test fun notebookAndSessionExportsCannotResolveAnotherSessionsImageFromForgedMarkdown() = runBlocking {
        val first = recognizedFixture()
        val secondSession = repository.createSession(first.session.notebookId, "第二节")
        val secondTask = repository.importCapturedFile(secondSession.id, first.image, profile())
        val secondImage = File(requireNotNull(repository.findBlock(secondTask.assetBlockId)).localPath)
        cleanup += secondImage
        val secondClaim = requireNotNull(repository.claimAfterUserConfirmation(secondTask.id))
        repository.completeRecognition(secondClaim, "第二节图形\n$SOURCE_IMAGE_MARKER", secondImage)
        val foreignLink = requireNotNull(recognitionSourceImageLink(secondTask.id, secondTask.assetBlockId))
        database.dao().insertBlock(StandaloneBlockEntity("forged-draft", first.session.id, StandaloneBlockKind.MARKDOWN_DRAFT, "",
            "伪造跨节引用\n![识别照片（已处理）]($foreignLink)", false, 9_999_999_999_999L, 9_999_999_999_999L))
        for (notebook in listOf(false, true)) {
            val output = File(context.filesDir, "documents/scoped-export-${System.nanoTime()}.md").apply { parentFile?.mkdirs() }
            cleanup += output
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", output)
            if (notebook) repository.exportNotebookMarkdown(first.session.notebookId, uri) else repository.exportSessionMarkdown(first.session.id, uri)
            val markdown = output.readText()
            val pictures = Regex("data:image/png;base64,").findAll(markdown).count()
            assertEquals(if (notebook) 2 else 1, pictures)
            assertTrue(markdown.contains("伪造跨节引用\n_识别照片不可用_"))
        }
    }

    @Test fun realReaderLoadsPhotoOpensZoomViewerAndBackClosesOnlyPhoto() = runBlocking {
        val fixture = recognizedFixture()
        val result = requireNotNull(repository.findBlock(requireNotNull(repository.findTask(fixture.task.id)?.resultBlockId)))
        val images = fixtureImages(fixture)
        composeRule.setContent {
            MathNotesTheme {
                StandaloneMarkdownReader("图形笔记", result.markdown, MathNotesThemeId.READING, onClose = {}, images = images)
            }
        }
        val imageState = AtomicReference<String>()
        repeat(30) {
            val evaluated = CountDownLatch(1)
            Espresso.onView(ViewMatchers.isAssignableFrom(WebView::class.java)).perform(webAction { web ->
                web.evaluateJavascript("(() => { const i = document.querySelector('a.mathnotes-source-image img'); return i ? i.naturalWidth + '|' + i.naturalHeight : 'pending'; })()") { imageState.set(it); evaluated.countDown() }
            })
            assertTrue(evaluated.await(3, TimeUnit.SECONDS))
            if (imageState.get() == "\"80|60\"") return@repeat
            Thread.sleep(100)
        }
        assertEquals("\"80|60\"", imageState.get())
        Espresso.onView(ViewMatchers.isAssignableFrom(WebView::class.java)).perform(webAction { web ->
            web.evaluateJavascript("document.querySelector('a.mathnotes-source-image').click()", null)
        })
        composeRule.waitUntil(5_000) { runCatching { composeRule.onNodeWithText("关闭照片").assertIsDisplayed(); true }.getOrDefault(false) }
        Espresso.onView(ViewMatchers.withContentDescription("识别照片，可捏合缩放")).perform(webAction { web ->
            assertFalse(web.settings.allowFileAccess)
            assertFalse(web.settings.allowContentAccess)
            assertTrue(web.settings.blockNetworkLoads)
            assertTrue(web.settings.supportZoom())
            assertTrue(web.settings.builtInZoomControls)
            assertTrue(web.zoomIn())
        })
        Espresso.pressBack()
        composeRule.onNodeWithText("关闭照片").assertDoesNotExist()
        composeRule.onNodeWithText("图形笔记").assertIsDisplayed()
        Unit
    }

    private suspend fun recognizedFixture(): Fixture {
        val session = repository.ensureCaptureSession()
        val processed = File(context.cacheDir, "processed-${System.nanoTime()}.png")
        cleanup += processed
        val bitmap = Bitmap.createBitmap(80, 60, Bitmap.Config.ARGB_8888).apply {
            eraseColor(Color.WHITE)
            for (x in 20..50) for (y in 25..35) setPixel(x, y, Color.BLACK)
        }
        processed.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
        val task = repository.importCapturedFile(session.id, processed, profile())
        val asset = requireNotNull(repository.findBlock(task.assetBlockId))
        val image = File(asset.localPath)
        cleanup += image
        val claimed = requireNotNull(repository.claimAfterUserConfirmation(task.id))
        repository.completeRecognition(claimed, "保留图形的解释\n$SOURCE_IMAGE_MARKER\n\n```\n$SOURCE_IMAGE_MARKER\n```", image)
        return Fixture(session, task, image, requireNotNull(recognitionSourceImageLink(task.id, asset.id)))
    }

    private suspend fun fixtureImages(fixture: Fixture) = standaloneReaderImages(context, fixture.session.id,
        database.dao().findBlocksForSession(fixture.session.id), listOf(requireNotNull(repository.findTask(fixture.task.id))))

    private fun profile() = StandaloneProviderProfile("custom_openai_compatible", "https://fixture.invalid/v1/chat/completions", "fixture", true, true)
    private data class Fixture(val session: StandaloneSessionEntity, val task: StandaloneRecognitionTaskEntity, val image: File, val link: String)
    private fun webAction(action: (WebView) -> Unit) = object : ViewAction {
        override fun getConstraints(): Matcher<View> = ViewMatchers.isAssignableFrom(WebView::class.java)
        override fun getDescription() = "Inspect the local source-image reader"
        override fun perform(uiController: UiController, view: View) { action(view as WebView); uiController.loopMainThreadUntilIdle() }
    }
}
