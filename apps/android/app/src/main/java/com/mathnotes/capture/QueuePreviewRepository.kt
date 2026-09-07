package com.mathnotes.capture

import android.content.Context
import com.mathnotes.capture.companion.CompanionApiClient
import com.mathnotes.capture.notes.NoteReadingRequest
import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.pairing.PairingTarget
import com.mathnotes.capture.storage.CaptureEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

internal data class QueuePreviewMaterial(val file: File, val mimeType: String)
internal data class RemoteQueuePreview(val material: QueuePreviewMaterial?, val note: NoteReadingRequest?, val message: String)

/** Queue receipts bind the preview to the bytes sent by this task, never an editor source or sidecar. */
internal class QueuePreviewRepository(
    private val context: Context,
    private val client: OkHttpClient = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(8, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(45, TimeUnit.SECONDS).build()
) {
    suspend fun local(capture: CaptureEntity): QueuePreviewMaterial? = withContext(Dispatchers.IO) {
        if (!capture.localCopyAvailable) return@withContext null
        val file = runCatching { File(capture.localPath).canonicalFile }.getOrNull() ?: return@withContext null
        val roots = listOf("captures", "documents").map { File(context.filesDir, it).canonicalFile.toPath() }
        if (roots.none { file.toPath().startsWith(it) } || !file.isFile || file.length() != capture.byteLength ||
            !queueFileSha256(file).equals(capture.sha256, ignoreCase = true)) return@withContext null
        QueuePreviewMaterial(file, capture.mimeType)
    }

    suspend fun remote(capture: CaptureEntity, pairing: PairingConfig, local: QueuePreviewMaterial?): RemoteQueuePreview = withContext(Dispatchers.IO) {
        val uploadId = capture.remoteUploadId ?: return@withContext RemoteQueuePreview(local, null, "尚无电脑上传回执")
        val url = (pairing.endpoint + "/api/v1/uploads/status").toHttpUrl().newBuilder()
            .addQueryParameter("uploadId", uploadId).addQueryParameter("notebookId", capture.notebookId)
            .addQueryParameter("sessionId", capture.sessionId).build()
        val status = client.newCall(Request.Builder().url(url).header("Authorization", "Bearer ${pairing.token}").build()).execute().use { response ->
            check(response.isSuccessful) { when (response.code) {
                401 -> "配对已失效，请重新连接电脑"
                404 -> "电脑暂不支持任务定位，或这项上传已经不可用"
                else -> "无法读取电脑任务状态（HTTP ${response.code}）"
            } }
            JSONObject(response.body?.string().orEmpty())
        }
        check(status.optString("uploadId") == uploadId) { "电脑返回了其他上传任务，已停止预览" }
        if (status.optString("notebookId") != capture.notebookId || status.optString("sessionId") != capture.sessionId ||
            !status.optString("sha256").equals(capture.sha256, true) || !capture.sha256.matches(Regex("[a-fA-F0-9]{64}"))) {
            return@withContext RemoteQueuePreview(local, null, "电脑返回的信息不足以核对素材，请更新电脑端后重试")
        }
        val mimeType = status.optString("mimeType")
        check(mimeType in setOf("image/png", "image/jpeg", "image/webp", "application/pdf")) { "无法预览此素材格式" }
        val assetPath = status.optString("assetPath")
        check(assetPath.startsWith("assets/") && assetPath.split('/').none { it == ".." || it.isBlank() } && !assetPath.contains('\\')) { "电脑返回的素材地址无效" }
        val material = local ?: run {
            val directory = File(context.cacheDir, "queue-previews").apply { mkdirs() }
            val extension = when (mimeType) { "image/png" -> "png"; "image/webp" -> "webp"; "application/pdf" -> "pdf"; else -> "jpg" }
            val file = File(directory, "${capture.sha256}.$extension")
            if (!file.isFile || !queueFileSha256(file).equals(capture.sha256, true)) {
                val assetUrl = (pairing.endpoint + "/api/v1/companion/asset").toHttpUrl().newBuilder()
                    .addQueryParameter("notebookId", capture.notebookId).addQueryParameter("sessionId", capture.sessionId)
                    .addQueryParameter("path", assetPath).build()
                val temporary = File.createTempFile("queue-", ".tmp", directory)
                try {
                    client.newCall(Request.Builder().url(assetUrl).header("Authorization", "Bearer ${pairing.token}").build()).execute().use { response ->
                        check(response.isSuccessful) { "实际上传素材不可用（HTTP ${response.code}）" }
                        response.body?.byteStream()?.use { input -> temporary.outputStream().use { output ->
                            val buffer = ByteArray(32 * 1024); var total = 0L
                            while (true) { val count = input.read(buffer); if (count < 0) break; total += count
                                check(total <= capture.byteLength) { "素材大小与上传回执不一致" }; output.write(buffer, 0, count) }
                        } } ?: error("素材响应为空")
                    }
                    check(temporary.length() == capture.byteLength && queueFileSha256(temporary).equals(capture.sha256, true)) { "素材校验失败，未显示未经核对的照片" }
                    temporary.copyTo(file, overwrite = true)
                } finally { temporary.delete() }
            }
            QueuePreviewMaterial(file.canonicalFile, mimeType)
        }
        if (status.optString("recognitionStatus") != "succeeded") return@withContext RemoteQueuePreview(material, null, "素材已上传，电脑识别尚未完成")
        val snapshot = try { CompanionApiClient(requestClient = client).fetchSession(pairing, PairingTarget(capture.notebookId, capture.sessionId, capture.targetTitle)) }
        catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
        catch (_: Exception) { return@withContext RemoteQueuePreview(material, null, "识别已完成，暂时无法核对笔记位置；请稍后重试") }
        check(snapshot.notebookId == capture.notebookId && snapshot.sessionId == capture.sessionId) { "电脑返回了其他笔记，已停止定位" }
        val blockId = listOf(status.optString("transcriptBlockId"), status.optString("imageBlockId"))
            .firstOrNull { it.matches(Regex("[A-Za-z0-9_-]+")) && companionHtmlContainsBlock(snapshot.html, it) }
        val assetId = MessageDigest.getInstance("SHA-256").digest(assetPath.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }.take(24)
        val imageAnchor = "mathnotes-block-$blockId-asset-$assetId"
        RemoteQueuePreview(material, blockId?.let { NoteReadingRequest("upload:${capture.captureId}:${System.nanoTime()}", capture.sessionId, it,
            capture.notebookId, pairing = pairing, targetAnchor = imageAnchor.takeIf { snapshot.html.contains("id=\"$it\"") }) }, if (blockId == null) "识别已完成，但对应正文块已删除或不可定位" else "识别已完成")
    }
}

internal fun companionHtmlContainsBlock(html: String, blockId: String): Boolean = Regex(
    """<section\b[^>]*\b(?:id=["']mathnotes-block-${Regex.escape(blockId)}["']|data-block-id=["']${Regex.escape(blockId)}["'])[^>]*>"""
).containsMatchIn(html)

internal fun queueFileSha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input -> val bytes = ByteArray(32 * 1024); while (true) { val count = input.read(bytes); if (count < 0) break; digest.update(bytes, 0, count) } }
    return digest.digest().joinToString("") { "%02x".format(it) }
}
