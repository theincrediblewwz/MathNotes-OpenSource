package com.mathnotes.capture

import android.content.Intent
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import com.mathnotes.capture.notes.NoteReadingRequest
import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.storage.CaptureEntity
import com.mathnotes.capture.storage.CaptureState
import com.mathnotes.capture.standalone.*
import com.mathnotes.capture.ui.MathNotesColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream

@Composable
internal fun UploadTaskPreview(capture: CaptureEntity, pairing: PairingConfig?, onClose: () -> Unit, onOpenNote: (NoteReadingRequest) -> Unit) {
    val context = LocalContext.current
    val repository = remember(context) { QueuePreviewRepository(context) }
    var material by remember(capture.captureId) { mutableStateOf<QueuePreviewMaterial?>(null) }
    var note by remember(capture.captureId) { mutableStateOf<NoteReadingRequest?>(null) }
    var message by remember(capture.captureId) { mutableStateOf("正在核对上传素材…") }
    var refresh by remember(capture.captureId) { mutableStateOf(0) }
    var busy by remember(capture.captureId) { mutableStateOf(true) }
    LaunchedEffect(capture, pairing, refresh) {
        busy = true
        note = null
        try {
            material = repository.local(capture)
            if (capture.state == CaptureState.UPLOADED && pairing != null) {
                message = "正在读取电脑识别状态…"
                val remote = repository.remote(capture, pairing, material)
                material = remote.material; note = remote.note; message = remote.message
            } else message = if (capture.state == CaptureState.UPLOADED) "请连接原电脑以查看识别结果" else "等待上传或识别完成后可打开笔记"
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) { message = error.message ?: "素材暂时不可用" }
        finally { busy = false }
    }
    QueueMaterialPreview(material, message, note?.let { { onClose(); onOpenNote(it) } }, onClose,
        if (!busy && capture.state == CaptureState.UPLOADED && pairing != null) ({ refresh += 1 }) else null)
}

@Composable
internal fun LocalTaskPreview(task: StandaloneRecognitionTaskEntity, blocks: List<StandaloneBlockEntity>, onClose: () -> Unit, onOpenNote: (NoteReadingRequest) -> Unit) {
    val context = LocalContext.current
    var material by remember(task.id) { mutableStateOf<QueuePreviewMaterial?>(null) }
    LaunchedEffect(task, blocks) {
        material = withContext(Dispatchers.IO) { blocks.firstOrNull { it.id == task.assetBlockId }
            ?.let { trustedStandaloneSourceFile(context, task.sessionId, it) }
            ?.let { QueuePreviewMaterial(it, when (it.extension.lowercase()) { "png" -> "image/png"; "webp" -> "image/webp"; else -> "image/jpeg" }) } }
    }
    val result = blocks.firstOrNull { it.id == task.resultBlockId && it.sessionId == task.sessionId && it.kind == StandaloneBlockKind.MARKDOWN_DRAFT }
    val note = if (task.status == StandaloneTaskStatus.SUCCEEDED && result != null) NoteReadingRequest(
        "local:${task.id}", task.sessionId, result.id, imageLink = recognitionSourceImageLink(task.id, task.assetBlockId)
    ) else null
    QueueMaterialPreview(material, if (note != null) "识别已完成" else taskStatusLabel(task.status),
        note?.let { { onClose(); onOpenNote(it) } }, onClose)
}

@Composable
internal fun QueueMaterialPreview(material: QueuePreviewMaterial?, message: String, onOpenNote: (() -> Unit)?, onClose: () -> Unit, onRefresh: (() -> Unit)? = null) {
    val context = LocalContext.current
    var openError by remember { mutableStateOf<String?>(null) }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Column(Modifier.fillMaxSize().background(MathNotesColors.Background).safeDrawingPadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
                Text("任务素材（实际上传成品）", Modifier.weight(1f).padding(top = 14.dp), color = MathNotesColors.Ink)
                TextButton(onClick = onClose) { Text("关闭素材") }
            }
            Text(message, Modifier.padding(horizontal = 16.dp, vertical = 6.dp), color = MathNotesColors.Muted)
            onOpenNote?.let { TextButton(onClick = it) { Text("打开笔记并定位") } }
            onRefresh?.let { TextButton(onClick = it) { Text("刷新识别状态") } }
            if (material == null) Text("素材暂时不可用，请稍后重试", Modifier.padding(16.dp), color = MathNotesColors.Muted)
            else if (material.mimeType == "application/pdf") {
                TextButton(onClick = {
                    openError = runCatching {
                        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", material.file)
                        context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, material.mimeType).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                    }.exceptionOrNull()?.let { "没有可打开 PDF 的系统应用" }
                }) { Text("打开实际上传的 PDF") }
                openError?.let { Text(it, Modifier.padding(16.dp), color = MathNotesColors.Error) }
            } else {
                androidx.compose.runtime.key(material.file.absolutePath) {
                    AndroidView(modifier = Modifier.fillMaxWidth().weight(1f), factory = { viewContext -> WebView(viewContext).apply {
                        contentDescription = "任务实际上传照片，可捏合缩放"
                        settings.javaScriptEnabled = false; settings.allowFileAccess = false; settings.allowContentAccess = false
                        settings.blockNetworkLoads = true; settings.setSupportZoom(true); settings.builtInZoomControls = true
                        settings.displayZoomControls = false; settings.useWideViewPort = true; settings.loadWithOverviewMode = true
                        webViewClient = object : WebViewClient() {
                            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?) = true
                            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse {
                                return if (request?.url.toString() == "https://appassets.androidplatform.net/queue/processed" && material.file.isFile && material.file.canonicalFile == material.file) {
                                    WebResourceResponse(material.mimeType, null, material.file.inputStream())
                                } else WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(byteArrayOf()))
                            }
                        }
                        loadDataWithBaseURL("https://appassets.androidplatform.net/queue/", """<html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=8,user-scalable=yes"><style>body{margin:0;background:#20231f}img{width:100%;height:auto}</style></head><body><img src="processed" alt="任务实际上传成品"></body></html>""", "text/html", "utf-8", null)
                    } }, onRelease = { it.destroy() })
                }
            }
        }
    }
}
