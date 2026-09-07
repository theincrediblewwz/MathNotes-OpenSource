package com.mathnotes.capture

import android.graphics.Bitmap
import android.graphics.Color
import android.view.View
import android.webkit.WebView
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.Espresso
import androidx.test.espresso.UiController
import androidx.test.espresso.ViewAction
import androidx.test.espresso.action.GeneralClickAction
import androidx.test.espresso.action.Press
import androidx.test.espresso.action.Tap
import androidx.test.espresso.matcher.ViewMatchers
import androidx.test.platform.app.InstrumentationRegistry
import com.mathnotes.capture.companion.*
import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.pairing.PairingStore
import com.mathnotes.capture.standalone.*
import com.mathnotes.capture.storage.*
import com.mathnotes.capture.ui.MathNotesTheme
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.hamcrest.Matcher
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Exercises the shipping app composition, both queue cards, and both real reading routes. */
class QueueReadingFlowTest {
    @get:Rule val compose = createComposeRule()
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val db by lazy { StandaloneDatabase.get(context) }
    private val repository by lazy { StandaloneRepository(context) }
    private val cleanup = mutableListOf<File>()
    private val prefix = "qa-reader-${System.nanoTime()}"
    private var notebook: StandaloneNotebookEntity? = null
    private var session: StandaloneSessionEntity? = null
    private var capture: CaptureEntity? = null
    private var pairing: PairingConfig? = null
    private var host: MockWebServer? = null

    @Before fun guard() { check(android.os.Build.FINGERPRINT.contains("generic") || android.os.Build.MODEL.contains("Android SDK")) { "Fixture tests require a disposable emulator" } }
    @After fun cleanup() = runBlocking {
        runCatching {
            if (compose.onAllNodesWithTag("reader-outline-popup").fetchSemanticsNodes().isNotEmpty()) Espresso.pressBack()
        }
        session?.let { db.dao().deleteTasksForSession(it.id); db.dao().deleteBlocksForSession(it.id); db.dao().deleteSessionById(it.id) }
        notebook?.let { db.dao().deleteNotebookById(it.id) }
        capture?.let { MathNotesDatabase.get(context).captureDao().deleteUploadedById(it.captureId) }
        pairing?.let { PairingStore(context).remove(it.profileId) }
        host?.shutdown(); cleanup.forEach { it.delete() }
    }

    @Test fun localQueuePreviewOpensItsActualPhotoThenLocatesTextAndNativeOutlineAndBottomBarWork() = runBlocking {
        val image = fixturePhoto()
        notebook = repository.createNotebook("本机目录验收")
        session = repository.createSession(notebook!!.id, "队列定位验收")
        val profile = StandaloneProviderProfile("local-fake", "local-fake", "fixture", true, true)
        val task = repository.importCapturedFile(session!!.id, image, profile)
        val asset = requireNotNull(repository.findBlock(task.assetBlockId)); cleanup += File(asset.localPath)
        val claim = requireNotNull(repository.claimAfterUserConfirmation(task.id))
        repository.completeRecognition(claim, markdown(), File(asset.localPath))
        compose.setContent { MathNotesTheme { MathNotesCaptureApp() } }
        compose.onNodeWithText("队列", substring = false).performClick()
        waitForText("队列定位验收")
        compose.onNodeWithText("队列定位验收", substring = false).performScrollTo().performClick()
        waitForText("打开笔记并定位")
        compose.waitUntil(5_000) { runCatching {
            Espresso.onView(ViewMatchers.withContentDescription("任务实际上传照片，可捏合缩放")).check { view, error ->
                if (error != null) throw error
                assertFalse((view as WebView).settings.allowFileAccess); assertTrue(view.settings.blockNetworkLoads)
            }
            true
        }.getOrDefault(false)
        }
        evidence("local-queue-preview")
        compose.onNodeWithText("打开笔记并定位").performClick()
        waitForText("目录")
        waitForJs("document.querySelector('#mathnotes-local-markdown img')?.naturalWidth", "320")
        compose.waitUntil(5_000) { webValue { it.scrollY }.toInt() > 0 }
        evidence("local-queue-located")
        verifyFloatingOutline("本机附录 24", "local-outline-popup")
        compose.onNodeWithText("第二节图形", substring = false).assertDoesNotExist()
        compose.onNodeWithText("目录", substring = false).performClick()
        compose.onNodeWithText("第一章", substring = false).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("第二节图形", substring = false).performScrollTo().performClick()
        compose.onNodeWithText("收起目录").assertDoesNotExist()
        compose.waitUntil(5_000) { webValue { it.scrollY }.toInt() > 0 }
        compose.onNodeWithText("设置", substring = false).assertIsDisplayed()
        compose.onNodeWithText("目录").performClick(); compose.onNodeWithText("第一章").performScrollTo().performClick()
        plainTap()
        try { compose.waitUntil(3_000) { compose.onAllNodesWithText("设置", substring = false).fetchSemanticsNodes().isEmpty() } }
        finally { evidence("local-after-plain-tap") }
        evidence("local-bottom-bar-hidden")
        plainTap(); waitForText("设置")
        // A real scroll and long-press selection must never trigger the reading single-tap callback.
        Espresso.onView(ViewMatchers.isAssignableFrom(WebView::class.java)).perform(androidx.test.espresso.action.ViewActions.swipeDown())
        compose.onNodeWithText("设置", substring = false).assertIsDisplayed()
        compose.onNodeWithText("目录").performClick(); compose.onNodeWithText("第一章").performScrollTo().performClick()
        val selectionPoint = firstParagraphTextPoint()
        Espresso.onView(ViewMatchers.isAssignableFrom(WebView::class.java)).perform(GeneralClickAction(Tap.LONG, { selectionPoint }, Press.FINGER, 0, 0))
        compose.waitUntil(3_000) { webValue { (it as com.mathnotes.capture.notes.ReaderInteractionWebView).isTextSelectionActive } == "true" }
        compose.onNodeWithText("设置", substring = false).assertIsDisplayed()
        evidence("local-outline-and-selection")
        Espresso.pressBack()
    }

    @Test fun computerUploadedCardWithoutLocalCopyFetchesExactAssetAndOpensActualSyncedReaderAnchor() = runBlocking {
        val image = fixturePhoto()
        val server = MockWebServer().also { it.start(); host = it }
        val nb = "$prefix-nb"; val sid = "$prefix-session"
        val assetPath = "assets/processed.png"
        val assetId = java.security.MessageDigest.getInstance("SHA-256").digest(assetPath.toByteArray()).joinToString("") { "%02x".format(it) }.take(24)
        val photoAnchor = "mathnotes-block-result-asset-$assetId"
        val beforeOne = fixturePhoto("-before-one", Color.BLUE, 900, 700)
        val beforeTwo = fixturePhoto("-before-two", Color.rgb(210, 90, 30), 900, 1100)
        val html = "<html><body><h1>电脑第一章</h1><p>" + "电脑阅读内容 ".repeat(650) + "</p><img src=\"mathnotes-companion-asset://before-one\"><img src=\"mathnotes-companion-asset://before-two\"><section id=\"mathnotes-block-result\" data-block-id=\"result\"><h2>电脑图形节</h2><p>实际识别说明</p><img id=\"$photoAnchor\" data-companion-asset-id=\"$assetId\" src=\"mathnotes-companion-asset://$assetId\"></section>" + (1..24).joinToString("") { "<h2>电脑附录 $it</h2><p>附录正文</p>" } + "</body></html>"
        val receipt = capture(image, nb, sid).copy(localCopyAvailable = false)
        capture = receipt
        pairing = PairingConfig(1, "127.0.0.1", server.port, "test-only-token-12345678", nb, sid, "private_http", "电脑队列验收", "$prefix-profile", "验收电脑")
        assertTrue(PairingStore(context).save(pairing!!))
        val status = JSONObject().put("uploadId", receipt.remoteUploadId).put("notebookId", nb).put("sessionId", sid)
            .put("sha256", receipt.sha256).put("mimeType", "image/png").put("assetPath", "assets/processed.png")
            .put("imageBlockId", "hidden").put("transcriptBlockId", "result").put("recognitionStatus", "succeeded")
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                assertEquals("Bearer test-only-token-12345678", request.getHeader("Authorization"))
                return when (request.requestUrl!!.encodedPath) {
                    "/api/v1/uploads/status" -> { assertEquals(nb, request.requestUrl!!.queryParameter("notebookId")); assertEquals(sid, request.requestUrl!!.queryParameter("sessionId")); json(status) }
                    "/api/v1/pairing/verify" -> json(JSONObject().put("ok", true).put("version", 1).put("targets", org.json.JSONArray().put(JSONObject().put("notebookId", nb).put("sessionId", sid).put("title", "电脑队列验收").put("notebookTitle", "中文电脑笔记本"))))
                    "/api/v1/companion/session" -> json(JSONObject().put("version", 1).put("notebookId", nb).put("sessionId", sid).put("title", "电脑队列验收").put("revision", "r1").put("updatedAt", "2026-09-07").put("markdown", "# 电脑第一章").put("html", html)
                        .put("assets", org.json.JSONArray().put(JSONObject().put("id", assetId).put("path", "assets/processed.png").put("mimeType", "image/png"))
                            .put(JSONObject().put("id", "before-one").put("path", "assets/before-one.png").put("mimeType", "image/png"))
                            .put(JSONObject().put("id", "before-two").put("path", "assets/before-two.png").put("mimeType", "image/png"))))
                    "/api/v1/companion/asset" -> {
                        val file = when (request.requestUrl!!.queryParameter("path")) { "assets/before-one.png" -> beforeOne; "assets/before-two.png" -> beforeTwo; else -> image }
                        MockResponse().addHeader("Content-Type", "image/png").setBodyDelay(if (file == beforeTwo) 900 else 500, TimeUnit.MILLISECONDS).setBody(Buffer().write(file.readBytes()))
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        MathNotesDatabase.get(context).captureDao().insert(receipt)
        compose.setContent { MathNotesTheme { MathNotesCaptureApp() } }
        compose.onNodeWithText("队列", substring = false).performClick()
        waitForText("电脑上传验收.png")
        compose.onNodeWithText("电脑上传验收.png").performScrollTo().performClick()
        waitForText("打开笔记并定位")
        evidence("computer-queue-remote-preview")
        compose.onNodeWithText("打开笔记并定位").performClick()
        waitForText("目录")
        try { compose.waitUntil(15_000) { runCatching { webValue { it.url.orEmpty() }.endsWith("#$photoAnchor") }.getOrDefault(false) } }
        finally { evidence("computer-before-location-assert") }
        compose.waitUntil(5_000) { webValue { it.scrollY }.toInt() > 0 }
        assertEquals("false", webValue { it.settings.javaScriptEnabled })
        compose.waitUntil(8_000) { actualPhotoPixelsVisible() }
        evidence("computer-queue-located")
        verifyFloatingOutline("电脑附录 24", "computer-outline-popup")
        compose.onNodeWithText("目录").performClick()
        compose.onNodeWithText("电脑第一章").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("电脑图形节").performScrollTo().performClick()
        compose.onNodeWithText("收起目录").assertDoesNotExist()
        compose.onNodeWithText("目录").performClick(); compose.onNodeWithText("电脑第一章").performScrollTo().performClick()
        plainTap(); compose.waitUntil(3_000) { compose.onAllNodesWithText("设置", substring = false).fetchSemanticsNodes().isEmpty() }
        evidence("computer-bottom-bar-hidden")
        plainTap(); waitForText("设置")
        // A 304-style cache timestamp update and identical asset payload must not reload or
        // send a reader who has continued reading back to the queue's original photo.
        Espresso.onView(ViewMatchers.isAssignableFrom(WebView::class.java)).perform(webAction { it.scrollTo(0, 250) })
        val previousPosition = webValue { "${it.url}|${it.scrollY}" }
        val store = CompanionAssetStore(context)
        val target = com.mathnotes.capture.pairing.PairingTarget(nb, sid, "电脑队列验收")
        val previousAssetRevision = store.contentRevision(pairing!!, target, listOf(assetId))
        store.write(pairing!!, target, CompanionSessionAsset(assetId, assetPath, "image/png"), image.readBytes(), "image/png")
        assertEquals(previousAssetRevision, store.contentRevision(pairing!!, target, listOf(assetId)))
        val dao = CompanionDatabase.get(context).sessionDao()
        val cached = requireNotNull(dao.find(pairing!!.profileId, nb, sid))
        dao.upsert(cached.copy(syncedAt = cached.syncedAt + 1))
        kotlinx.coroutines.delay(500)
        compose.waitForIdle()
        assertEquals(previousPosition, webValue { "${it.url}|${it.scrollY}" })
    }

    @Test fun queueNeverUsesUnverifiedBytesOrAnotherSessionsStatusAndMissingBlocksCannotPretendToJump() = runBlocking {
        val image = fixturePhoto()
        val server = MockWebServer().also { it.start(); host = it }
        val receipt = capture(image, "nb", "session")
        val connection = PairingConfig(1, "127.0.0.1", server.port, "test-only-token-12345678", "nb", "session", "private_http")
        val previews = QueuePreviewRepository(context)
        assertNotNull(previews.local(receipt))
        assertNull(previews.local(receipt.copy(sha256 = "0".repeat(64))))
        val status = JSONObject().put("uploadId", receipt.remoteUploadId).put("notebookId", "other").put("sessionId", "session").put("sha256", receipt.sha256)
        server.enqueue(json(status))
        assertNull(previews.remote(receipt, connection, null).note)
        assertEquals(1, server.requestCount)
        status.put("notebookId", "nb").put("mimeType", "image/png").put("assetPath", "assets/processed.png").put("recognitionStatus", "succeeded").put("transcriptBlockId", "missing")
        server.enqueue(json(status)); server.enqueue(MockResponse().setResponseCode(404))
        server.enqueue(json(JSONObject().put("version", 1).put("notebookId", "nb").put("sessionId", "session").put("title", "已删除").put("revision", "r").put("updatedAt", "now").put("markdown", "正文").put("html", "<p>其他正文</p>")))
        val result = previews.remote(receipt, connection, previews.local(receipt))
        assertNull(result.note); assertTrue(result.message.contains("不可定位"))
    }

    private fun fixturePhoto(suffix: String = "", background: Int = Color.rgb(30, 100, 80), width: Int = 320, height: Int = 200): File {
        val file = File(context.filesDir, "captures/$prefix$suffix.png").apply { parentFile!!.mkdirs() }; cleanup += file
        Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).apply { eraseColor(background);
            for (y in 40 until 140) for (x in 60 until 190) setPixel(x, y, Color.WHITE)
            file.outputStream().use { compress(Bitmap.CompressFormat.PNG, 100, it) }; recycle() }
        return file
    }
    private fun capture(image: File, nb: String, sid: String) = CaptureEntity(prefix, "qa-device", image.canonicalPath, "image/png", image.length(), queueFileSha256(image), nb, sid,
        "http://127.0.0.1", CaptureState.UPLOADED, 1, null, 200, null, "$prefix-upload", "job", System.currentTimeMillis(), System.currentTimeMillis(),
        sourceName = "电脑上传验收.png", pairingProfileId = "$prefix-profile", targetTitle = "电脑队列验收")
    private fun markdown() = "# 第一章\n\n" + "这是正文内容，用于验证目录和阅读手势。\n\n".repeat(60) + "## 第二节图形\n\n实际识别图形说明。\n$SOURCE_IMAGE_MARKER\n\n### 第三节\n\n阅读结尾。\n\n" + (1..24).joinToString("\n\n") { "## 本机附录 $it\n\n附录正文。" }
    private fun json(value: JSONObject) = MockResponse().addHeader("Content-Type", "application/json").setBody(value.toString())
    private fun waitForText(text: String) { compose.waitUntil(15_000) { compose.onAllNodesWithText(text, substring = false).fetchSemanticsNodes().isNotEmpty() } }
    private fun plainTap() { Espresso.onView(ViewMatchers.isAssignableFrom(WebView::class.java)).perform(GeneralClickAction(Tap.SINGLE, { view ->
        val xy = IntArray(2); view.getLocationOnScreen(xy); floatArrayOf(xy[0] + view.width * .35f, xy[1] + view.height * .25f)
    }, Press.FINGER, 0, 0)) }
    private fun actualPhotoPixelsVisible(): Boolean {
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        var count = 0
        for (y in 0 until bitmap.height step 4) for (x in 0 until bitmap.width step 4) {
            if (bitmap.getPixel(x, y) == Color.rgb(30, 100, 80)) count++
        }
        bitmap.recycle()
        return count > 300
    }
    private fun webValue(block: (WebView) -> Any): String {
        var result = ""
        Espresso.onView(ViewMatchers.isAssignableFrom(WebView::class.java)).perform(webAction { result = block(it).toString() }); return result
    }
    private fun waitForJs(script: String, expected: String) {
        compose.waitUntil(10_000) {
            val result = AtomicReference<String>(); val latch = CountDownLatch(1)
            Espresso.onView(ViewMatchers.isAssignableFrom(WebView::class.java)).perform(webAction { web -> web.evaluateJavascript(script) { result.set(it); latch.countDown() } })
            latch.await(2, TimeUnit.SECONDS) && result.get() == expected
        }
    }
    private fun webAction(action: (WebView) -> Unit) = object : ViewAction {
        override fun getConstraints(): Matcher<View> = ViewMatchers.isAssignableFrom(WebView::class.java)
        override fun getDescription() = "Inspect the actual reading WebView"
        override fun perform(controller: UiController, view: View) { action(view as WebView) }
    }
    private fun evidence(name: String) {
        compose.waitForIdle()
        if (compose.onAllNodesWithTag("reader-outline-popup").fetchSemanticsNodes().isEmpty()) runCatching {
            val frame = CountDownLatch(1)
            Espresso.onView(ViewMatchers.isAssignableFrom(WebView::class.java)).perform(webAction { web ->
                web.postVisualStateCallback(1, object : WebView.VisualStateCallback() { override fun onComplete(id: Long) { frame.countDown() } })
            }); frame.await(3, TimeUnit.SECONDS)
        }
        val directory = File(context.getExternalFilesDir("qa"), "feedback-v034").apply { mkdirs() }
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().also { bitmap ->
            File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
        val roots = compose.onAllNodes(isRoot(), useUnmergedTree = true)
        File(directory, "$name.txt").writeText(roots.fetchSemanticsNodes().indices.joinToString("\n\n") { roots[it].printToString() })
        for (command in listOf("mkdir -p /sdcard/Download/MathNotes-feedback-v034-final",
            "cp ${directory.absolutePath}/$name.png /sdcard/Download/MathNotes-feedback-v034-final/$name.png",
            "cp ${directory.absolutePath}/$name.txt /sdcard/Download/MathNotes-feedback-v034-final/$name.txt")) {
            android.os.ParcelFileDescriptor.AutoCloseInputStream(InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command)).use { it.readBytes() }
        }
    }

    private fun verifyFloatingOutline(lastLabel: String, name: String) {
        var web: WebView? = null
        Espresso.onView(ViewMatchers.isAssignableFrom(WebView::class.java)).perform(webAction { web = it })
        fun bounds(): List<Int> {
            var result = emptyList<Int>()
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                val view = requireNotNull(web); val xy = IntArray(2); view.getLocationOnScreen(xy)
                result = listOf(xy[0], xy[1], view.width, view.height, view.scrollY)
            }
            return result
        }
        val before = bounds()
        compose.onNodeWithText("目录", substring = false).performClick()
        compose.onNodeWithTag("reader-outline-popup").assertIsDisplayed()
        assertEquals("Opening the floating outline must not move or resize the document", before, bounds())
        evidence(name)
        compose.onNodeWithText(lastLabel, substring = false).performScrollTo().assertIsDisplayed()
        evidence("$name-scrolled")
        assertEquals(before, bounds())
        Espresso.pressBack()
        waitForPopupClosed()
        compose.onNodeWithTag("reader-outline-popup").assertDoesNotExist()
        compose.onNodeWithText("设置", substring = false).assertIsDisplayed()
        compose.onNodeWithTag("reader-outline-button").performClick()
        compose.onNodeWithTag("reader-outline-popup").assertIsDisplayed()
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val downTime = android.os.SystemClock.uptimeMillis()
        val x = before[0] + before[2] * .96f
        val y = before[1] + before[3] * .65f
        for ((action, time) in listOf(android.view.MotionEvent.ACTION_DOWN to downTime, android.view.MotionEvent.ACTION_UP to downTime + 80)) {
            android.view.MotionEvent.obtain(downTime, time, action, x, y, 0).also {
                it.source = android.view.InputDevice.SOURCE_TOUCHSCREEN
                assertTrue(automation.injectInputEvent(it, true)); it.recycle()
            }
        }
        waitForPopupClosed()
        compose.onNodeWithTag("reader-outline-popup").assertDoesNotExist()
        compose.onNodeWithText("设置", substring = false).assertIsDisplayed()
        compose.onNodeWithTag("reader-outline-button").performClick()
        compose.onNodeWithTag("reader-outline-popup").assertIsDisplayed()
        compose.onNodeWithTag("reader-outline-button").performClick()
        waitForPopupClosed()
        compose.onNodeWithTag("reader-outline-popup").assertDoesNotExist()
    }

    private fun waitForPopupClosed() {
        compose.waitUntil(2_000) { compose.onAllNodesWithTag("reader-outline-popup").fetchSemanticsNodes().isEmpty() }
    }

    private fun firstParagraphTextPoint(): FloatArray {
        val coordinates = AtomicReference<FloatArray>(); val latch = CountDownLatch(1)
        Espresso.onView(ViewMatchers.isAssignableFrom(WebView::class.java)).perform(webAction { web ->
            web.evaluateJavascript("(() => { const p = document.querySelector('#mathnotes-local-markdown p'); const r=document.createRange();r.setStart(p.firstChild,0);r.setEnd(p.firstChild,3);const b=r.getBoundingClientRect();return JSON.stringify([b.x+b.width/2,b.y+b.height/2]);})()") { raw ->
                val point = org.json.JSONArray(org.json.JSONArray("[$raw]").getString(0))
                val location = IntArray(2); web.getLocationOnScreen(location)
                coordinates.set(floatArrayOf(location[0] + point.getDouble(0).toFloat() * web.scale, location[1] + point.getDouble(1).toFloat() * web.scale)); latch.countDown()
            }
        }); check(latch.await(3, TimeUnit.SECONDS)); return coordinates.get()
    }
}
