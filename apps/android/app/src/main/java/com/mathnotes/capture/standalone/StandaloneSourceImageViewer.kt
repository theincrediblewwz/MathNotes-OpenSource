package com.mathnotes.capture.standalone

import android.annotation.SuppressLint
import android.webkit.WebResourceRequest
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.mathnotes.capture.companion.COMPANION_READER_BASE_URL
import com.mathnotes.capture.ui.MathNotesColors
import java.io.File

@SuppressLint("SetJavaScriptEnabled")
@Composable
internal fun StandaloneSourceImageViewer(link: String, images: Map<String, File>, onClose: () -> Unit) {
    if (images[link]?.isFile != true) return
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Column(Modifier.fillMaxSize().background(MathNotesColors.Background).safeDrawingPadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("识别照片（已处理）", modifier = Modifier.weight(1f), color = MathNotesColors.Ink)
                TextButton(onClick = onClose) { Text("关闭照片") }
            }
            AndroidView(modifier = Modifier.fillMaxWidth().weight(1f), factory = { context ->
                WebView(context).apply {
                    contentDescription = "识别照片，可捏合缩放"
                    settings.javaScriptEnabled = false
                    settings.allowFileAccess = false
                    settings.allowContentAccess = false
                    settings.blockNetworkLoads = true
                    settings.setSupportZoom(true)
                    settings.builtInZoomControls = true
                    settings.displayZoomControls = false
                    settings.useWideViewPort = true
                    settings.loadWithOverviewMode = true
                    webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?) = true
                        override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?) =
                            request?.url?.let { standaloneReaderImageResponse(it, mapOf(link to images.getValue(link))) }
                    }
                    loadDataWithBaseURL(COMPANION_READER_BASE_URL, standaloneSourceImageViewerHtml(link), "text/html", "utf-8", null)
                }
            }, onRelease = { it.destroy() })
        }
    }
}

internal fun standaloneSourceImageViewerHtml(link: String): String {
    val parts = link.removePrefix("source-images/").split('/')
    require(parts.size == 2 && recognitionSourceImageLink(parts[0], parts[1]) == link)
    return """<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=8,user-scalable=yes"><style>body{margin:0;background:#20231f}img{display:block;width:100%;height:auto}</style></head><body><img src="$link" alt="识别照片（已处理）"></body></html>"""
}
