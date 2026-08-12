package com.mathnotes.capture.companion

import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.pairing.PairingTarget
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import org.json.JSONException

data class CompanionSessionSnapshot(
    val notebookId: String,
    val sessionId: String,
    val title: String,
    val revision: String,
    val updatedAt: String,
    val markdown: String,
    val html: String,
    val assets: List<CompanionSessionAsset>
)

data class CompanionSessionAsset(
    val id: String,
    val path: String,
    val mimeType: String
)

private data class CompanionSessionManifest(
    val notebookId: String,
    val sessionId: String,
    val title: String,
    val revision: String,
    val updatedAt: String,
    val markdownBytes: Long,
    val htmlBytes: Long,
    val assets: List<CompanionSessionAsset>
)

data class CompanionCatalogSnapshot(
    val activeTarget: PairingTarget?,
    val targets: List<PairingTarget>
)

sealed interface CompanionSessionChange {
    data object Changed : CompanionSessionChange
    data object Deleted : CompanionSessionChange
}

class CompanionApiClient(
    private val requestClient: OkHttpClient = defaultRequestClient(),
    private val eventClient: OkHttpClient = defaultEventClient(),
    private val assetStore: CompanionAssetStore? = null,
    private val contentStore: CompanionContentStore? = null
) {
    suspend fun fetchCatalog(pairing: PairingConfig): CompanionCatalogSnapshot {
        var lastConnectionError: CompanionConnectionException? = null
        repeat(SESSION_FETCH_ATTEMPTS) { attempt ->
            try {
                val request = Request.Builder()
                    .url("${pairing.endpoint}/api/v1/pairing/verify")
                    .header("Authorization", "Bearer ${pairing.token}")
                    .header("Accept", "application/json")
                    .build()
                val catalog = withContext(Dispatchers.IO) {
                    requestClient.newCall(request).await().use { response ->
                        if (!response.isSuccessful) throw companionHttpError(response.code)
                        parseCompanionCatalog(response.body?.string().orEmpty())
                    }
                }
                return catalog
            } catch (error: CompanionConnectionException) {
                lastConnectionError = error
            } catch (error: CompanionSyncException) {
                throw error
            } catch (error: JSONException) {
                throw CompanionSyncException("电脑返回的笔记目录无法解析，请更新两端应用后重试。", error)
            } catch (error: IllegalArgumentException) {
                throw CompanionSyncException("电脑返回的笔记目录版本不兼容，请更新两端应用后重试。", error)
            } catch (error: SocketTimeoutException) {
                lastConnectionError = CompanionConnectionException("连接电脑超时，请确认两台设备仍在同一私有网络后重试。", error)
            } catch (error: ConnectException) {
                lastConnectionError = CompanionConnectionException("暂时无法连接电脑，请确认电脑端接收服务仍在运行。", error)
            } catch (error: IOException) {
                lastConnectionError = CompanionConnectionException("笔记目录同步中断：${error.message ?: "网络连接异常"}", error)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                android.util.Log.e("CompanionSync", "意外的笔记目录同步失败", error)
                throw CompanionSyncException(describeUnexpectedSyncError(error), error)
            }
            if (attempt < SESSION_FETCH_ATTEMPTS - 1) delay(SESSION_RETRY_DELAYS_MS[attempt])
        }
        throw lastConnectionError ?: CompanionConnectionException("暂时无法连接电脑，请确认电脑端接收服务仍在运行。")
    }

    suspend fun fetchSession(
        pairing: PairingConfig,
        target: PairingTarget,
        knownRevision: String? = null,
        onSnapshotReceived: suspend (CompanionSessionSnapshot) -> Unit = {}
    ): CompanionSessionSnapshot {
        var lastConnectionError: CompanionSyncException? = null
        repeat(SESSION_FETCH_ATTEMPTS) { attempt ->
            try {
                return fetchSessionOnce(pairing, target, knownRevision, onSnapshotReceived)
            } catch (error: CompanionConnectionException) {
                lastConnectionError = error
                if (attempt < SESSION_FETCH_ATTEMPTS - 1) {
                    delay(SESSION_RETRY_DELAYS_MS[attempt])
                }
            }
        }
        throw lastConnectionError ?: CompanionConnectionException("暂时无法连接电脑，请确认电脑端接收服务仍在运行。")
    }

    private suspend fun fetchSessionOnce(
        pairing: PairingConfig,
        target: PairingTarget,
        knownRevision: String?,
        onSnapshotReceived: suspend (CompanionSessionSnapshot) -> Unit
    ): CompanionSessionSnapshot {
        try {
            return withContext(Dispatchers.IO) {
                try {
                    fetchSessionV2(pairing, target, knownRevision, onSnapshotReceived)
                } catch (_: CompanionProtocolUnavailableException) {
                    fetchSessionV1(pairing, target, knownRevision, onSnapshotReceived)
                }
            }
        } catch (error: CompanionSyncException) {
            throw error
        } catch (error: JSONException) {
            throw CompanionSyncException("电脑返回的笔记清单无法解析，请更新两端应用后重试。", error)
        } catch (error: IllegalArgumentException) {
            throw CompanionSyncException("电脑返回的笔记同步版本不兼容，请更新两端应用后重试。", error)
        } catch (error: SocketTimeoutException) {
            throw CompanionConnectionException("连接电脑超时，请确认两台设备仍在同一私有网络后重试。", error)
        } catch (error: ConnectException) {
            throw CompanionConnectionException("暂时无法连接电脑，请确认电脑端接收服务仍在运行。", error)
        } catch (error: IOException) {
            throw CompanionConnectionException("笔记同步中断：${error.message ?: "网络连接异常"}", error)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            android.util.Log.e("CompanionSync", "意外的笔记正文同步失败", error)
            throw CompanionSyncException(describeUnexpectedSyncError(error), error)
        }
    }

    private suspend fun fetchSessionV2(
        pairing: PairingConfig,
        target: PairingTarget,
        knownRevision: String?,
        onSnapshotReceived: suspend (CompanionSessionSnapshot) -> Unit
    ): CompanionSessionSnapshot {
        val manifestRequest = authorizedV2Request(pairing, target, "manifest")
            .apply {
                header("Accept", "application/json")
                if (!knownRevision.isNullOrBlank()) header("If-None-Match", revisionEtag(knownRevision))
            }
            .build()
        val manifest = requestClient.newCall(manifestRequest).await().use { response ->
            if (response.code == 304) throw CompanionNotModifiedException()
            if (response.code == 404 || response.code == 405) throw CompanionProtocolUnavailableException()
            if (!response.isSuccessful) throw companionStageHttpError("同步清单", response.code)
            parseCompanionManifest(response.body?.string().orEmpty())
        }

        val documents = if (contentStore != null) {
            fetchDocumentToStore(pairing, target, manifest, "markdown", "md")
            fetchDocumentToStore(pairing, target, manifest, "html", "html")
            contentStore.readDocuments(pairing, target)
                ?: throw CompanionSyncException("正文已接收，但本地读取失败，请检查手机存储空间后重试。")
        } else {
            fetchDocumentText(pairing, target, manifest, "markdown") to
                fetchDocumentText(pairing, target, manifest, "html")
        }
        val (markdown, html) = documents
        if (markdown.toByteArray(Charsets.UTF_8).size.toLong() != manifest.markdownBytes) {
            throw CompanionSyncException("Markdown 正文接收不完整，请重试同步。")
        }
        if (html.toByteArray(Charsets.UTF_8).size.toLong() != manifest.htmlBytes) {
            throw CompanionSyncException("阅读预览接收不完整，请重试同步。")
        }
        val snapshot = CompanionSessionSnapshot(
            notebookId = manifest.notebookId,
            sessionId = manifest.sessionId,
            title = manifest.title,
            revision = manifest.revision,
            updatedAt = manifest.updatedAt,
            markdown = markdown,
            html = html,
            assets = manifest.assets
        )
        onSnapshotReceived(snapshot)
        return materializeAssets(pairing, target, snapshot)
    }

    private suspend fun fetchDocumentToStore(
        pairing: PairingConfig,
        target: PairingTarget,
        manifest: CompanionSessionManifest,
        format: String,
        extension: String
    ) {
        val request = authorizedV2Request(pairing, target, "document", mapOf("format" to format)).build()
        requestClient.newCall(request).await().use { response ->
            if (!response.isSuccessful) throw companionStageHttpError(documentStage(format), response.code)
            requireMatchingRevision(response, manifest.revision, format)
            val body = response.body ?: throw CompanionSyncException("${documentStage(format)}响应为空，请重试同步。")
            try {
                contentStore?.writeDocument(pairing, target, extension, body.byteStream())
            } catch (error: IOException) {
                throw CompanionSyncException("${documentStage(format)}已接收，但写入手机失败，请检查存储空间。", error)
            } catch (error: IllegalStateException) {
                throw CompanionSyncException("${documentStage(format)}已接收，但无法更新本地缓存。", error)
            }
        }
    }

    private suspend fun fetchDocumentText(
        pairing: PairingConfig,
        target: PairingTarget,
        manifest: CompanionSessionManifest,
        format: String
    ): String {
        val request = authorizedV2Request(pairing, target, "document", mapOf("format" to format)).build()
        return requestClient.newCall(request).await().use { response ->
            if (!response.isSuccessful) throw companionStageHttpError(documentStage(format), response.code)
            requireMatchingRevision(response, manifest.revision, format)
            response.body?.string() ?: throw CompanionSyncException("${documentStage(format)}响应为空，请重试同步。")
        }
    }

    private fun requireMatchingRevision(response: Response, expected: String, format: String) {
        val actual = response.header("X-MathNotes-Revision")
        if (actual != expected) {
            throw CompanionConnectionException("${documentStage(format)}生成期间笔记发生变化，正在重新同步。")
        }
    }

    private suspend fun fetchSessionV1(
        pairing: PairingConfig,
        target: PairingTarget,
        knownRevision: String?,
        onSnapshotReceived: suspend (CompanionSessionSnapshot) -> Unit
    ): CompanionSessionSnapshot {
        val request = authorizedRequest(pairing, target, "session")
                .apply {
                    if (!knownRevision.isNullOrBlank()) header("If-None-Match", revisionEtag(knownRevision))
                }
                .build()
            val response = requestClient.newCall(request).await()
            response.use {
                if (it.code == 304) throw CompanionNotModifiedException()
                if (!it.isSuccessful) throw companionHttpError(it.code)
                val snapshot = parseCompanionSnapshot(it.body?.string().orEmpty())
                onSnapshotReceived(snapshot)
                return materializeAssets(pairing, target, snapshot)
            }
    }

    fun observeChanges(pairing: PairingConfig, target: PairingTarget): Flow<CompanionSessionChange> = callbackFlow {
        val call = eventClient.newCall(authorizedRequest(pairing, target, "events").build())
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) {
                close(error)
            }

            override fun onResponse(call: Call, response: Response) {
                if (!response.isSuccessful) {
                    response.close()
                    close(IOException("笔记监听失败：HTTP ${response.code}"))
                    return
                }
                launch(Dispatchers.IO) {
                    response.use {
                        val source = it.body?.source() ?: return@use
                        var eventName = ""
                        while (!source.exhausted()) {
                            val line = source.readUtf8Line() ?: break
                            when {
                                line.startsWith("event:") -> eventName = line.substringAfter(':').trim()
                                line.isEmpty() && eventName == "session-changed" -> {
                                    trySend(CompanionSessionChange.Changed)
                                    eventName = ""
                                }
                                line.isEmpty() && eventName == "session-deleted" -> {
                                    trySend(CompanionSessionChange.Deleted)
                                    eventName = ""
                                }
                            }
                        }
                    }
                    close()
                }
            }
        })
        awaitClose { call.cancel() }
    }

    fun observeCatalogChanges(pairing: PairingConfig): Flow<Unit> = callbackFlow {
        val request = Request.Builder()
            .url("${pairing.endpoint}/api/v1/companion/catalog-events")
            .header("Authorization", "Bearer ${pairing.token}")
            .build()
        val call = eventClient.newCall(request)
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) {
                close(error)
            }

            override fun onResponse(call: Call, response: Response) {
                if (!response.isSuccessful) {
                    response.close()
                    close(IOException("笔记目录监听失败：HTTP ${response.code}"))
                    return
                }
                launch(Dispatchers.IO) {
                    response.use {
                        val source = it.body?.source() ?: return@use
                        var eventName = ""
                        while (!source.exhausted()) {
                            val line = source.readUtf8Line() ?: break
                            when {
                                line.startsWith("event:") -> eventName = line.substringAfter(':').trim()
                                line.isEmpty() && eventName == "catalog-changed" -> {
                                    trySend(Unit)
                                    eventName = ""
                                }
                            }
                        }
                    }
                    close()
                }
            }
        })
        awaitClose { call.cancel() }
    }

    private suspend fun materializeAssets(
        pairing: PairingConfig,
        target: PairingTarget,
        snapshot: CompanionSessionSnapshot
    ): CompanionSessionSnapshot = coroutineScope {
        if (snapshot.assets.isEmpty() || assetStore == null) return@coroutineScope snapshot
        val semaphore = Semaphore(3)
        val results = snapshot.assets.map { asset ->
            async(Dispatchers.IO) {
                semaphore.withPermit {
                    asset to runCatching { fetchAssetBytes(pairing, target, asset) }
                }
            }
        }.awaitAll()

        var html = snapshot.html
        var failures = 0
        for ((asset, result) in results) {
            result.onSuccess { payload ->
                assetStore.write(pairing, target, asset, payload.bytes, payload.mimeType)
            }.onFailure { error ->
                if (error is CompanionAuthenticationException) throw error
                failures += 1
                html = html.replace("mathnotes-companion-asset://${asset.id}", "")
            }
        }
        if (failures > 0) {
            val warning = "<aside class=\"asset-sync-warning\">$failures 张图片暂未同步，文字笔记仍可阅读；网络恢复后请刷新。</aside>"
            html = html.replace("</body>", "$warning</body>")
        }
        snapshot.copy(html = html)
    }

    private suspend fun fetchAssetBytes(
        pairing: PairingConfig,
        target: PairingTarget,
        asset: CompanionSessionAsset
    ): CompanionAssetPayload {
        val request = authorizedRequest(pairing, target, "asset", mapOf("path" to asset.path)).build()
        val response = requestClient.newCall(request).await()
        response.use {
            if (it.code == 401) throw CompanionAuthenticationException()
            if (!it.isSuccessful) throw IOException("素材同步失败：HTTP ${it.code}")
            val bytes = it.body?.bytes() ?: throw IOException("素材响应为空")
            val mimeType = it.header("Content-Type")?.substringBefore(';') ?: asset.mimeType
            return CompanionAssetPayload(bytes, mimeType)
        }
    }

    private fun authorizedRequest(
        pairing: PairingConfig,
        target: PairingTarget,
        route: String,
        extraQuery: Map<String, String> = emptyMap()
    ): Request.Builder {
        val url = "${pairing.endpoint}/api/v1/companion/$route" +
            "?notebookId=${encode(target.notebookId)}&sessionId=${encode(target.sessionId)}" +
            extraQuery.entries.joinToString(separator = "", transform = { "&${encode(it.key)}=${encode(it.value)}" })
        return Request.Builder()
            .url(url)
            .header("Authorization", "Bearer ${pairing.token}")
    }

    private fun authorizedV2Request(
        pairing: PairingConfig,
        target: PairingTarget,
        route: String,
        extraQuery: Map<String, String> = emptyMap()
    ): Request.Builder {
        val url = "${pairing.endpoint}/api/v2/companion/session/$route" +
            "?notebookId=${encode(target.notebookId)}&sessionId=${encode(target.sessionId)}" +
            extraQuery.entries.joinToString(separator = "", transform = { "&${encode(it.key)}=${encode(it.value)}" })
        return Request.Builder()
            .url(url)
            .header("Authorization", "Bearer ${pairing.token}")
            .header("X-MathNotes-Companion-Protocol", "2")
    }

    private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { cancel() }
        enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) {
                if (continuation.isActive) continuation.resumeWith(Result.failure(error))
            }

            override fun onResponse(call: Call, response: Response) {
                if (continuation.isActive) continuation.resume(response) else response.close()
            }
        })
    }

    companion object {
        private const val SESSION_FETCH_ATTEMPTS = 3
        private val SESSION_RETRY_DELAYS_MS = longArrayOf(300L, 800L)

        private fun defaultRequestClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .callTimeout(45, TimeUnit.SECONDS)
            .followRedirects(false)
            .build()

        private fun defaultEventClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS)
            .followRedirects(false)
            .build()

        private fun encode(value: String): String =
            URLEncoder.encode(value, StandardCharsets.UTF_8.toString())
    }
}

private data class CompanionAssetPayload(val bytes: ByteArray, val mimeType: String)

internal class CompanionNotModifiedException : CompanionSyncException("笔记内容没有变化。")

private class CompanionProtocolUnavailableException : CompanionSyncException("电脑端暂不支持分段同步。")

internal fun revisionEtag(revision: String): String {
    val encoded = java.util.Base64.getUrlEncoder().withoutPadding()
        .encodeToString(revision.toByteArray(StandardCharsets.UTF_8))
    return "\"$encoded\""
}

open class CompanionSyncException(message: String, cause: Throwable? = null) : IOException(message, cause)

class CompanionConnectionException(message: String, cause: Throwable? = null) : CompanionSyncException(message, cause)

internal class CompanionAuthenticationException : CompanionSyncException("配对已失效，请重新配对电脑。")

internal fun describeUnexpectedSyncError(error: Throwable): String {
    val detail = error.message
        ?.takeIf { it.isNotBlank() }
        ?.let { "：$it" }
        .orEmpty()
    return "笔记同步出现意外错误（${error.javaClass.simpleName}$detail），请重试；若持续出现请反馈此信息。"
}

private fun companionHttpError(statusCode: Int): CompanionSyncException = when (statusCode) {
    401 -> CompanionAuthenticationException()
    404 -> CompanionSyncException("这份笔记已移动或删除，请在电脑端重新选择后刷新。")
    503 -> CompanionSyncException("电脑端笔记预览服务尚未就绪，请稍后重试。")
    else -> CompanionSyncException("电脑端生成笔记预览失败（HTTP $statusCode）。")
}

private fun companionStageHttpError(stage: String, statusCode: Int): CompanionSyncException = when (statusCode) {
    401 -> CompanionAuthenticationException()
    404 -> CompanionSyncException("$stage：这份笔记已移动或删除。")
    503 -> CompanionSyncException("$stage：电脑端服务尚未就绪，请稍后重试。")
    else -> CompanionSyncException("${stage}失败（HTTP $statusCode）。")
}

private fun documentStage(format: String): String =
    if (format == "markdown") "Markdown 正文同步" else "阅读预览同步"

private fun parseCompanionManifest(raw: String): CompanionSessionManifest {
    val json = JSONObject(raw)
    require(json.optInt("version") == 2) { "不支持的分段同步版本" }
    return CompanionSessionManifest(
        notebookId = json.getString("notebookId"),
        sessionId = json.getString("sessionId"),
        title = json.getString("title"),
        revision = json.getString("revision"),
        updatedAt = json.getString("updatedAt"),
        markdownBytes = json.getLong("markdownBytes"),
        htmlBytes = json.getLong("htmlBytes"),
        assets = parseCompanionAssets(json)
    )
}

private fun parseCompanionAssets(json: JSONObject): List<CompanionSessionAsset> {
    val assetsJson = json.optJSONArray("assets")
    return buildList {
        if (assetsJson != null) {
            for (index in 0 until assetsJson.length()) {
                val asset = assetsJson.getJSONObject(index)
                add(
                    CompanionSessionAsset(
                        id = asset.getString("id"),
                        path = asset.getString("path"),
                        mimeType = asset.getString("mimeType")
                    )
                )
            }
        }
    }
}

internal fun parseCompanionSnapshot(raw: String): CompanionSessionSnapshot {
    val json = JSONObject(raw)
    require(json.optInt("version") == 1) { "不支持的笔记同步版本" }
    return CompanionSessionSnapshot(
        notebookId = json.getString("notebookId"),
        sessionId = json.getString("sessionId"),
        title = json.getString("title"),
        revision = json.getString("revision"),
        updatedAt = json.getString("updatedAt"),
        markdown = json.optString("markdown"),
        html = json.getString("html"),
        assets = parseCompanionAssets(json)
    )
}

internal fun parseCompanionCatalog(raw: String): CompanionCatalogSnapshot {
    val json = JSONObject(raw)
    require(json.optBoolean("ok") && json.optInt("version") == 1) { "不支持的笔记目录版本" }
    val targetsJson = json.optJSONArray("targets")
    val targets = buildList {
        if (targetsJson != null) {
            for (index in 0 until targetsJson.length()) {
                targetsJson.optJSONObject(index)?.toPairingTarget()?.let(::add)
            }
        }
    }
    return CompanionCatalogSnapshot(
        activeTarget = json.optJSONObject("activeTarget")?.toPairingTarget(),
        targets = targets
    )
}

private fun JSONObject.toPairingTarget(): PairingTarget? {
    val notebookId = optString("notebookId")
    val sessionId = optString("sessionId")
    if (notebookId.isBlank() || sessionId.isBlank()) return null
    return PairingTarget(
        notebookId = notebookId,
        sessionId = sessionId,
        title = optString("title").ifBlank { sessionId },
        notebookTitle = optString("notebookTitle").ifBlank { notebookId }
    )
}
