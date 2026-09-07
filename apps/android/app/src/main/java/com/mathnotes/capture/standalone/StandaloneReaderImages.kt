package com.mathnotes.capture.standalone

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.File

/** Assets come from the selected Session's persisted task -> result -> image relationship. */
internal fun standaloneReaderImages(
    context: Context,
    sessionId: String,
    blocks: List<StandaloneBlockEntity>,
    tasks: List<StandaloneRecognitionTaskEntity>
): Map<String, File> {
    val sessionBlocks = blocks.filter { it.sessionId == sessionId }.associateBy { it.id }
    return tasks.filter { it.sessionId == sessionId && it.status == StandaloneTaskStatus.SUCCEEDED }.mapNotNull { task ->
        val result = sessionBlocks[task.resultBlockId]?.takeIf { it.kind == StandaloneBlockKind.MARKDOWN_DRAFT } ?: return@mapNotNull null
        val asset = sessionBlocks[task.assetBlockId] ?: return@mapNotNull null
        val link = recognitionSourceImageLink(task.id, asset.id) ?: return@mapNotNull null
        val file = trustedStandaloneSourceFile(context, sessionId, asset) ?: return@mapNotNull null
        if (!result.markdown.contains("]($link)")) return@mapNotNull null
        link to file
    }.toMap()
}

internal fun trustedStandaloneSourceFile(context: Context, sessionId: String, asset: StandaloneBlockEntity): File? = runCatching {
    if (asset.kind != StandaloneBlockKind.IMAGE || asset.sessionId != sessionId || recognitionSourceImageLink(sessionId, asset.id) == null) return null
    val file = File(asset.localPath).canonicalFile
    val directory = File(context.filesDir, "standalone/assets/$sessionId").canonicalFile
    if (file.parentFile != directory || file.nameWithoutExtension != asset.id || !file.isFile || file.length() == 0L ||
        file.extension.lowercase() !in setOf("png", "jpg", "jpeg", "webp")) return null
    file
}.getOrNull()

internal fun standaloneReaderImageLink(uri: Uri): String? {
    if (uri.scheme != "https" || uri.host != "appassets.androidplatform.net" || uri.port != -1 || uri.query != null || uri.fragment != null) return null
    val path = uri.encodedPath.orEmpty()
    val parts = path.removePrefix("/assets/source-images/").split('/')
    if (!path.startsWith("/assets/source-images/") || parts.size != 2) return null
    return recognitionSourceImageLink(parts[0], parts[1])
}

internal fun standaloneReaderImageResponse(uri: Uri, images: Map<String, File>): WebResourceResponse? {
    if (uri.host != "appassets.androidplatform.net" || !uri.path.orEmpty().startsWith("/assets/source-images/")) return null
    val file = standaloneReaderImageLink(uri)?.let(images::get)
    if (file == null || !file.isFile || runCatching { file.canonicalFile != file }.getOrDefault(true)) return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(byteArrayOf()))
    val mime = when (file.extension.lowercase()) { "png" -> "image/png"; "webp" -> "image/webp"; else -> "image/jpeg" }
    return runCatching { WebResourceResponse(mime, null, file.inputStream()) }.getOrElse {
        WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(byteArrayOf()))
    }
}
