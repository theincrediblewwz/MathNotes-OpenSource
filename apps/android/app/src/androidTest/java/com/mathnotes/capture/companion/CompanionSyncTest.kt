package com.mathnotes.capture.companion

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.pairing.PairingTarget
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

@RunWith(AndroidJUnit4::class)
class CompanionSyncTest {
    private lateinit var server: MockWebServer
    private lateinit var database: CompanionDatabase

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        database = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            CompanionDatabase::class.java
        ).allowMainThreadQueries().build()
    }

    @After
    fun tearDown() {
        database.close()
        server.shutdown()
    }

    @Test
    fun authenticatedSnapshotIsCachedForOfflineReading() = runBlocking {
        val largeImage = ByteArray(3 * 1024 * 1024) { index -> (index % 251).toByte() }
        enqueueLegacyProtocolFallback()
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                .setBody(
                    """{"version":1,"notebookId":"analysis","sessionId":"lecture","title":"泛函分析","revision":"r1","updatedAt":"2026-07-14T08:00:00.000Z","blockCount":1,"html":"<html><body>note<img src=\"mathnotes-companion-asset://asset-1\"></body></html>","assets":[{"id":"asset-1","path":"assets/embedded/graph.png","mimeType":"image/png"}]}"""
                )
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "image/png")
                .setBody(Buffer().write(largeImage))
        )
        val pairing = PairingConfig(
            version = 1,
            host = server.hostName,
            port = server.port,
            token = "0123456789abcdef",
            transport = "private_http",
            profileId = "test-pc"
        )
        val target = PairingTarget("analysis", "lecture", "泛函分析")
        val assetStore = CompanionAssetStore(ApplicationProvider.getApplicationContext())
        val repository = CompanionRepository(
            database.sessionDao(),
            CompanionApiClient(assetStore = assetStore)
        )

        repository.refresh(pairing, target)

        val cached = repository.sessions(pairing).first().single()
        assertEquals("r1", cached.revision)
        assertTrue(cached.html.contains("note"))
        assertTrue(cached.html.contains("mathnotes-companion-asset://asset-1"))
        assertTrue(cached.html.length < 1_000)
        assertEquals(largeImage.size.toLong(), assetStore.read(pairing, target, "asset-1")?.file?.length())
        val protocolRequest = server.takeRequest()
        assertEquals("/api/v2/companion/session/manifest", protocolRequest.requestUrl?.encodedPath)
        val request = server.takeRequest()
        assertEquals("Bearer 0123456789abcdef", request.getHeader("Authorization"))
        assertEquals("analysis", request.requestUrl?.queryParameter("notebookId"))
        assertEquals("lecture", request.requestUrl?.queryParameter("sessionId"))
        val assetRequest = server.takeRequest()
        assertEquals("/api/v1/companion/asset", assetRequest.requestUrl?.encodedPath)
        assertEquals("assets/embedded/graph.png", assetRequest.requestUrl?.queryParameter("path"))
        assertEquals("Bearer 0123456789abcdef", assetRequest.getHeader("Authorization"))
    }

    @Test
    fun multiMegabyteTextSnapshotRemainsReadableOffline() = runBlocking {
        val largeMarkdown = "长篇数学笔记。".repeat(280_000)
        val largeHtml = "<html><body><p>${"长篇数学笔记。".repeat(280_000)}</p></body></html>"
        enqueueLegacyProtocolFallback()
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                JSONObject()
                    .put("version", 1)
                    .put("notebookId", "analysis")
                    .put("sessionId", "long-note")
                    .put("title", "长篇笔记")
                    .put("revision", "large-r1")
                    .put("updatedAt", "2026-07-19T08:00:00.000Z")
                    .put("markdown", largeMarkdown)
                    .put("html", largeHtml)
                    .put("assets", JSONArray())
                    .toString()
            )
        )
        val pairing = PairingConfig(
            version = 1,
            host = server.hostName,
            port = server.port,
            token = "0123456789abcdef",
            transport = "private_http",
            profileId = "large-note-pc"
        )
        val repository = CompanionRepository(
            database.sessionDao(),
            CompanionApiClient(),
            contentStore = CompanionContentStore(ApplicationProvider.getApplicationContext())
        )

        repository.refresh(pairing, PairingTarget("analysis", "long-note", "长篇笔记"))

        val cached = repository.sessions(pairing).first().single()
        assertEquals(largeMarkdown, cached.markdown)
        assertEquals(largeHtml, cached.html)
    }

    @Test
    fun missingImageDoesNotBlockTextCache() = runBlocking {
        enqueueLegacyProtocolFallback()
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"version":1,"notebookId":"analysis","sessionId":"lecture","title":"泛函分析","revision":"r2","updatedAt":"2026-07-14T08:01:00.000Z","html":"<html><body>正文<img src=\"mathnotes-companion-asset://missing\"></body></html>","assets":[{"id":"missing","path":"assets/embedded/missing.png","mimeType":"image/png"}]}"""
            )
        )
        server.enqueue(MockResponse().setResponseCode(404))
        val pairing = PairingConfig(
            version = 1,
            host = server.hostName,
            port = server.port,
            token = "0123456789abcdef",
            transport = "private_http",
            profileId = "test-pc"
        )
        val repository = CompanionRepository(
            database.sessionDao(),
            CompanionApiClient(
                assetStore = CompanionAssetStore(ApplicationProvider.getApplicationContext())
            )
        )

        repository.refresh(pairing, PairingTarget("analysis", "lecture", "泛函分析"))

        val cached = repository.sessions(pairing).first().single()
        assertTrue(cached.html.contains("正文"))
        assertTrue(cached.html.contains("1 张图片暂未同步"))
        assertTrue(!cached.html.contains("mathnotes-companion-asset://"))
    }

    @Test
    fun legacyInlineImageCacheForcesLightweightSnapshotRefresh() = runBlocking {
        val pairing = PairingConfig(
            version = 1,
            host = server.hostName,
            port = server.port,
            token = "0123456789abcdef",
            transport = "private_http",
            profileId = "test-pc"
        )
        database.sessionDao().upsert(
            CompanionSessionEntity(
                profileId = "test-pc",
                notebookId = "analysis",
                sessionId = "lecture",
                title = "旧缓存",
                revision = "r1",
                markdown = "旧正文",
                html = "<img src=\"data:image/png;base64,AAAA\">",
                updatedAt = "old",
                syncedAt = 1L
            )
        )
        enqueueLegacyProtocolFallback()
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"version":1,"notebookId":"analysis","sessionId":"lecture","title":"新缓存","revision":"r1","updatedAt":"now","markdown":"新正文","html":"<p>新正文</p>","assets":[]}"""
            )
        )
        val repository = CompanionRepository(database.sessionDao(), CompanionApiClient())

        repository.refresh(pairing, PairingTarget("analysis", "lecture", "新缓存"))

        val request = server.takeRequest()
        assertEquals(null, request.getHeader("If-None-Match"))
        val cached = repository.sessions(pairing).first().single()
        assertEquals("新正文", cached.markdown)
        assertEquals("<p>新正文</p>", cached.html)
    }

    @Test
    fun segmentedProtocolStreamsLargeDocumentsBeforeAssets() = runBlocking {
        val largeMarkdown = "# 长篇笔记\n\n" + "数学正文。".repeat(360_000)
        val largeHtml = "<html><body><h1>长篇笔记</h1><p>${"数学正文。".repeat(360_000)}</p></body></html>"
        val manifest = JSONObject()
            .put("version", 2)
            .put("notebookId", "analysis")
            .put("sessionId", "segmented")
            .put("title", "分段同步")
            .put("revision", "segmented-r1")
            .put("updatedAt", "2026-07-19T10:00:00.000Z")
            .put("markdownBytes", largeMarkdown.toByteArray().size)
            .put("htmlBytes", largeHtml.toByteArray().size)
            .put("assets", JSONArray())
            .toString()
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                .setBody(manifest)
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "text/markdown; charset=utf-8")
                .setHeader("X-MathNotes-Revision", "segmented-r1")
                .setBody(largeMarkdown)
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "text/html; charset=utf-8")
                .setHeader("X-MathNotes-Revision", "segmented-r1")
                .setBody(largeHtml)
        )
        val pairing = PairingConfig(
            version = 1,
            host = server.hostName,
            port = server.port,
            token = "0123456789abcdef",
            transport = "private_http",
            profileId = "segmented-pc"
        )
        val target = PairingTarget("analysis", "segmented", "分段同步")
        val contentStore = CompanionContentStore(ApplicationProvider.getApplicationContext())
        val repository = CompanionRepository(
            database.sessionDao(),
            CompanionApiClient(contentStore = contentStore),
            contentStore = contentStore
        )

        repository.refresh(pairing, target)

        val cached = repository.sessions(pairing).first().single()
        assertEquals(largeMarkdown, cached.markdown)
        assertEquals(largeHtml, cached.html)
        assertEquals("/api/v2/companion/session/manifest", server.takeRequest().requestUrl?.encodedPath)
        assertEquals("markdown", server.takeRequest().requestUrl?.queryParameter("format"))
        assertEquals("html", server.takeRequest().requestUrl?.queryParameter("format"))
    }

    @Test
    fun sessionStartedOnMainConsumesDocumentsOffMainThread() {
        val markdown = "# 主线程发起\n\n正文"
        val html = "<html><body><h1>主线程发起</h1><p>正文</p></body></html>"
        val manifest = JSONObject()
            .put("version", 2)
            .put("notebookId", "analysis")
            .put("sessionId", "main-thread")
            .put("title", "线程回归")
            .put("revision", "main-thread-r1")
            .put("updatedAt", "2026-07-22T08:00:00.000Z")
            .put("markdownBytes", markdown.toByteArray().size)
            .put("htmlBytes", html.toByteArray().size)
            .put("assets", JSONArray())
            .toString()
        server.enqueue(MockResponse().setResponseCode(200).setBody(manifest))
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("X-MathNotes-Revision", "main-thread-r1")
                .setBody(markdown)
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("X-MathNotes-Revision", "main-thread-r1")
                .setBody(html)
        )
        val pairing = PairingConfig(
            version = 1,
            host = server.hostName,
            port = server.port,
            token = "0123456789abcdef",
            transport = "private_http",
            profileId = "main-thread-pc"
        )
        val callbackRanOnMain = AtomicBoolean(true)
        var snapshot: CompanionSessionSnapshot? = null
        var failure: Throwable? = null

        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            runBlocking {
                try {
                    snapshot = CompanionApiClient().fetchSession(
                        pairing,
                        PairingTarget("analysis", "main-thread", "线程回归")
                    ) {
                        callbackRanOnMain.set(
                            android.os.Looper.myLooper() == android.os.Looper.getMainLooper()
                        )
                    }
                } catch (error: Throwable) {
                    failure = error
                }
            }
        }

        if (failure != null) throw AssertionError("主线程发起同步不应在主线程读取正文", failure)
        assertEquals(markdown, snapshot?.markdown)
        assertFalse(callbackRanOnMain.get())
    }

    @Test
    fun catalogRefreshRenamesCurrentSessionAndRemovesDeletedCache() = runBlocking {
        val pairing = PairingConfig(
            version = 1,
            host = server.hostName,
            port = server.port,
            token = "0123456789abcdef",
            transport = "private_http",
            profileId = "test-pc"
        )
        database.sessionDao().upsert(
            CompanionSessionEntity("test-pc", "analysis", "lecture", "旧标题", "r1", "one", "<p>one</p>", "now", 1)
        )
        database.sessionDao().upsert(
            CompanionSessionEntity("test-pc", "analysis", "deleted", "待删除", "r1", "two", "<p>two</p>", "now", 2)
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"ok":true,"version":1,"activeTarget":{"notebookId":"analysis","sessionId":"lecture","title":"新标题"},"targets":[{"notebookId":"analysis","sessionId":"lecture","title":"新标题"}]}"""
            )
        )
        val repository = CompanionRepository(database.sessionDao(), CompanionApiClient())

        repository.refreshCatalog(pairing)

        val cached = repository.sessions(pairing).first()
        assertEquals(1, cached.size)
        assertEquals("lecture", cached.single().sessionId)
        assertEquals("新标题", cached.single().title)
        val request = server.takeRequest()
        assertEquals("/api/v1/pairing/verify", request.requestUrl?.encodedPath)
        assertEquals("Bearer 0123456789abcdef", request.getHeader("Authorization"))
    }

    private fun enqueueLegacyProtocolFallback() {
        server.enqueue(MockResponse().setResponseCode(404))
    }
}
