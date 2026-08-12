package com.mathnotes.capture.companion

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.view.View
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.pairing.PairingTarget
import com.mathnotes.capture.ui.MathNotesColors
import com.mathnotes.capture.ui.MathNotesThemeId
import com.mathnotes.capture.ui.MathNotesPageHeader
import com.mathnotes.capture.ui.MathNotesPaper
import java.io.FileInputStream
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CompanionNotesScreen(
    pairing: PairingConfig?,
    targets: List<PairingTarget>,
    themeId: MathNotesThemeId = MathNotesThemeId.DEFAULT_LIGHT,
    endpointCandidates: List<PairingConfig> = emptyList(),
    onPairingVerified: (PairingConfig, List<PairingTarget>) -> Unit = { _, _ -> }
) {
    val context = LocalContext.current
    val markdownMirror = remember(context) { CompanionMarkdownMirror(context.applicationContext) }
    val assetStore = remember(context) { CompanionAssetStore(context.applicationContext) }
    val contentStore = remember(context) { CompanionContentStore(context.applicationContext) }
    val repository = remember(context) {
        CompanionRepository(
            CompanionDatabase.get(context.applicationContext).sessionDao(),
            client = CompanionApiClient(assetStore = assetStore, contentStore = contentStore),
            markdownMirror = markdownMirror,
            contentStore = contentStore
        )
    }
    val cachedFlow = remember(repository, pairing?.profileId, pairing?.host, pairing?.port) {
        pairing?.let(repository::sessions) ?: flowOf(emptyList<CompanionSessionEntity>())
    }
    val cached by cachedFlow.collectAsStateWithLifecycle(initialValue = emptyList())
    var selected by remember(pairing?.profileId) { mutableStateOf<PairingTarget?>(null) }
    var catalogTargets by remember(pairing?.profileId) { mutableStateOf(targets) }
    var catalogSyncing by remember(pairing?.profileId) { mutableStateOf(false) }
    var catalogError by remember(pairing?.profileId) { mutableStateOf<String?>(null) }
    var catalogRefreshRequest by remember(pairing?.profileId) { mutableStateOf(0) }
    var lastManualRefreshAt by remember(pairing?.profileId) { mutableStateOf(0L) }
    var expandedNotebooks by remember(pairing?.profileId) { mutableStateOf(emptySet<String>()) }
    var verifiedPairing by remember(pairing?.profileId) { mutableStateOf(pairing) }

    BackHandler(enabled = selected != null) { selected = null }

    LaunchedEffect(targets) {
        if (targets.isNotEmpty()) catalogTargets = targets
    }

    LaunchedEffect(pairing?.endpointId, pairing?.profileId) {
        verifiedPairing = pairing
    }

    LaunchedEffect(pairing, catalogRefreshRequest) {
        val activePairing = pairing ?: return@LaunchedEffect
        catalogSyncing = true
        try {
            val resolved = repository.refreshCatalog(activePairing, endpointCandidates)
            val catalog = resolved.catalog
            catalogTargets = catalog.targets
            catalogError = null
            selected = selected?.let { current ->
                catalog.targets.firstOrNull {
                    it.notebookId == current.notebookId && it.sessionId == current.sessionId
                }
            }
            val requested = PairingTarget(
                activePairing.notebookId,
                activePairing.sessionId,
                activePairing.targetTitle
            )
            val effectiveTarget = resolveCatalogTarget(requested, catalog)
            val effectivePairing = effectiveTarget?.let(resolved.pairing::withTarget)
                ?: resolved.pairing.copy(notebookId = "", sessionId = "", targetTitle = "")
            verifiedPairing = effectivePairing
            onPairingVerified(effectivePairing, catalog.targets)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (cause: Throwable) {
            catalogError = cause.message?.let { "笔记目录同步失败：$it" }
                ?: "笔记目录同步失败，请确认电脑接收服务正在运行。"
        } finally {
            catalogSyncing = false
        }
    }

    LaunchedEffect(verifiedPairing?.endpointId, pairing?.profileId) {
        val activePairing = verifiedPairing ?: return@LaunchedEffect
        coroutineScope {
            launch {
                repository.observeCatalogChanges(activePairing).collect {
                    if (!catalogSyncing) catalogRefreshRequest += 1
                }
            }
            launch {
                while (isActive) {
                    delay(COMPANION_RECONCILE_INTERVAL_MS)
                    if (!catalogSyncing) catalogRefreshRequest += 1
                }
            }
        }
    }

    fun requestManualRefresh() {
        val now = System.currentTimeMillis()
        if (pairing != null && !catalogSyncing &&
            now - lastManualRefreshAt >= COMPANION_MANUAL_REFRESH_INTERVAL_MS
        ) {
            lastManualRefreshAt = now
            catalogRefreshRequest += 1
        }
    }

    val active = selected
    val activeConnection = verifiedPairing ?: pairing
    if (active != null && activeConnection != null) {
        val cachedSession = cached.firstOrNull {
            it.notebookId == active.notebookId && it.sessionId == active.sessionId
        }
        CompanionReader(
            pairing = activeConnection,
            endpointCandidates = endpointCandidates,
            target = active,
            cached = cachedSession,
            repository = repository,
            assetStore = assetStore,
            themeId = themeId,
            onConnectionVerified = { verified ->
                verifiedPairing = verified
                onPairingVerified(verified, catalogTargets)
            },
            onDeleted = {
                selected = null
                if (!catalogSyncing) catalogRefreshRequest += 1
            },
            onManualRefresh = ::requestManualRefresh
        )
        return
    }

    val advertisedKeys = catalogTargets.mapTo(mutableSetOf()) { it.notebookId to it.sessionId }
    val offlineTargets = cached
        .filterNot { (it.notebookId to it.sessionId) in advertisedKeys }
        .map { PairingTarget(it.notebookId, it.sessionId, it.title) }
    val visibleTargets = catalogTargets + offlineTargets

    PullToRefreshBox(
        isRefreshing = catalogSyncing,
        onRefresh = ::requestManualRefresh,
        modifier = Modifier.fillMaxSize()
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(start = 22.dp, top = 28.dp, end = 22.dp, bottom = 112.dp)
        ) {
            MathNotesPageHeader(
                eyebrow = "只读同步",
                title = "我的笔记",
                detail = "连接电脑时自动更新；离线时仍可阅读最近缓存。"
            )
            Spacer(Modifier.height(22.dp))
            catalogError?.let { message ->
                MathNotesPaper(Modifier.fillMaxWidth().padding(bottom = 9.dp)) {
                    Text(message, color = MathNotesColors.Error)
                    Text("下拉可重新同步；照片上传队列不受影响。", color = MathNotesColors.Muted)
                }
            }
            if (visibleTargets.isEmpty()) {
                MathNotesPaper(Modifier.fillMaxWidth()) {
                    Text("还没有可阅读的 Session", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(5.dp))
                    Text("请先在设置中连接电脑。", color = MathNotesColors.Muted)
                }
            }
            visibleTargets.groupBy { it.notebookId }.forEach { (notebookId, notebookTargets) ->
                val expanded = notebookId in expandedNotebooks
                MathNotesPaper(
                    Modifier
                        .fillMaxWidth()
                        .padding(bottom = 9.dp)
                        .clickable {
                            expandedNotebooks = if (expanded) {
                                expandedNotebooks - notebookId
                            } else {
                                expandedNotebooks + notebookId
                            }
                        }
                ) {
                    Text(
                        "${if (expanded) "▾" else "▸"}  $notebookId",
                        style = MaterialTheme.typography.titleMedium,
                        color = MathNotesColors.Ink
                    )
                    Spacer(Modifier.height(5.dp))
                    Text(
                        "${notebookTargets.size} 个 Session",
                        style = MaterialTheme.typography.bodySmall,
                        color = MathNotesColors.Muted
                    )
                }
                if (expanded) notebookTargets.forEach { target ->
                    val local = cached.firstOrNull {
                        it.notebookId == target.notebookId && it.sessionId == target.sessionId
                    }
                    MathNotesPaper(
                        Modifier
                            .fillMaxWidth()
                            .padding(start = 14.dp, bottom = 9.dp)
                            .clickable { selected = target }
                    ) {
                        Text(target.title, style = MaterialTheme.typography.titleMedium, color = MathNotesColors.Ink)
                        Spacer(Modifier.height(5.dp))
                        Text(
                            if (local?.html.isNullOrBlank()) "点击从电脑同步" else "已缓存 · ${local?.updatedAt}",
                            style = MaterialTheme.typography.bodySmall,
                            color = if (local?.html.isNullOrBlank()) MathNotesColors.Accent else MathNotesColors.Muted
                        )
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CompanionReader(
    pairing: PairingConfig,
    endpointCandidates: List<PairingConfig>,
    target: PairingTarget,
    cached: CompanionSessionEntity?,
    repository: CompanionRepository,
    assetStore: CompanionAssetStore,
    themeId: MathNotesThemeId,
    onConnectionVerified: (PairingConfig) -> Unit,
    onDeleted: () -> Unit,
    onManualRefresh: () -> Unit
) {
    var syncing by remember(target) { mutableStateOf(false) }
    var error by remember(target) { mutableStateOf<String?>(null) }
    var refreshRequest by remember(target) { mutableStateOf(0) }
    var lastManualRefreshAt by remember(target) { mutableStateOf(0L) }

    LaunchedEffect(pairing, target, refreshRequest) {
        syncing = true
        try {
            val resolved = repository.refresh(pairing, target, endpointCandidates)
            error = null
            if (resolved.pairing.endpointId != pairing.endpointId) {
                onConnectionVerified(resolved.pairing.withTarget(target))
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (cause: Throwable) {
            error = cause.message?.let { "笔记正文同步失败：$it" }
                ?: "笔记正文同步失败，请稍后重试。"
        } finally {
            syncing = false
        }
    }

    LaunchedEffect(pairing, target) {
        coroutineScope {
            launch {
                repository.observeChanges(pairing, target).collect { change ->
                    when (change) {
                        CompanionSessionChange.Changed -> if (!syncing) refreshRequest += 1
                        CompanionSessionChange.Deleted -> {
                            repository.deleteSession(pairing, target)
                            onDeleted()
                        }
                    }
                }
            }
            launch {
                while (isActive) {
                    delay(COMPANION_RECONCILE_INTERVAL_MS)
                    if (!syncing) refreshRequest += 1
                }
            }
        }
    }

    fun requestReaderRefresh() {
        val now = System.currentTimeMillis()
        if (!syncing && now - lastManualRefreshAt >= COMPANION_MANUAL_REFRESH_INTERVAL_MS) {
            lastManualRefreshAt = now
            refreshRequest += 1
            onManualRefresh()
        }
    }

    PullToRefreshBox(
        isRefreshing = syncing,
        onRefresh = ::requestReaderRefresh,
        modifier = Modifier.fillMaxSize()
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .padding(bottom = COMPANION_READER_BOTTOM_INSET)
        ) {
            if (syncing || error != null) {
                MathNotesPaper(Modifier.fillMaxWidth().padding(12.dp)) {
                    if (syncing) {
                        CircularProgressIndicator(
                            modifier = Modifier.align(Alignment.CenterHorizontally),
                            color = MathNotesColors.Accent
                        )
                        Spacer(Modifier.height(7.dp))
                        Text("正在同步 ${target.title}", color = MathNotesColors.Muted)
                    } else {
                        Text(error.orEmpty(), color = MathNotesColors.Error)
                        Text(
                            "目标电脑：${pairing.computerLabel.ifBlank { "${pairing.host}:${pairing.port}" }}",
                            color = MathNotesColors.Muted,
                            style = MaterialTheme.typography.bodySmall
                        )
                        if (cached != null) Text("正在显示离线缓存", color = MathNotesColors.Muted)
                        TextButton(onClick = ::requestReaderRefresh) {
                            Text("重新连接并同步")
                        }
                    }
                }
            }
            if (cached == null) {
                if (!syncing) {
                    Text(
                        "暂无本地缓存，请确认手机与电脑处于可互访的私有网络。",
                        modifier = Modifier.padding(22.dp),
                        color = MathNotesColors.Muted
                    )
                }
            } else {
                ReadOnlyWebView(
                    html = cached.html,
                    themeId = themeId,
                    pairing = pairing,
                    target = target,
                    assetStore = assetStore,
                    modifier = Modifier.fillMaxWidth().weight(1f)
                )
            }
        }
    }
}

internal fun resolveCatalogTarget(
    requested: PairingTarget,
    catalog: CompanionCatalogSnapshot
): PairingTarget? = catalog.targets.firstOrNull {
    it.notebookId == requested.notebookId && it.sessionId == requested.sessionId
} ?: catalog.activeTarget?.let { active ->
    catalog.targets.firstOrNull {
        it.notebookId == active.notebookId && it.sessionId == active.sessionId
    } ?: active
} ?: catalog.targets.firstOrNull()

internal val COMPANION_READER_BOTTOM_INSET = 112.dp
internal const val COMPANION_EVENT_RECONNECT_DELAY_MS = 3_000L
internal const val COMPANION_RECONCILE_INTERVAL_MS = 30_000L
internal const val COMPANION_MANUAL_REFRESH_INTERVAL_MS = 3_000L
internal const val COMPANION_READER_BASE_URL = "https://appassets.androidplatform.net/assets/"

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun ReadOnlyWebView(
    html: String,
    themeId: MathNotesThemeId,
    pairing: PairingConfig,
    target: PairingTarget,
    assetStore: CompanionAssetStore,
    modifier: Modifier = Modifier
) {
    val readerHtml = remember(html, themeId) { prepareCompanionReaderHtml(html, themeId) }
    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
                settings.javaScriptEnabled = false
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.blockNetworkLoads = true
                settings.useWideViewPort = false
                settings.loadWithOverviewMode = false
                settings.textZoom = 100
                settings.setSupportZoom(false)
                settings.builtInZoomControls = false
                settings.displayZoomControls = false
                isHorizontalScrollBarEnabled = false
                overScrollMode = View.OVER_SCROLL_NEVER
                webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(
                        view: WebView?,
                        request: WebResourceRequest?
                    ): WebResourceResponse? {
                        val uri = request?.url ?: return null
                        if (uri.scheme == "mathnotes-companion-asset") {
                            val assetId = uri.host.orEmpty().ifBlank {
                                uri.schemeSpecificPart.removePrefix("//")
                            }
                            val cachedAsset = assetStore.read(pairing, target, assetId) ?: return null
                            return WebResourceResponse(
                                cachedAsset.mimeType,
                                null,
                                FileInputStream(cachedAsset.file)
                            )
                        }
                        return companionReaderAssetResponse(context, uri)
                    }
                }
            }
        },
        update = { view ->
            if (view.tag != readerHtml.hashCode()) {
                view.tag = readerHtml.hashCode()
                view.loadDataWithBaseURL(COMPANION_READER_BASE_URL, readerHtml, "text/html", "utf-8", null)
            }
        }
    )
}

internal fun prepareCompanionReaderHtml(html: String, themeId: MathNotesThemeId): String {
    val palette = when (themeId) {
        MathNotesThemeId.DEFAULT_LIGHT -> CompanionReaderPalette("#fbfaf7", "#fffefd", "#24231f", "#7f7b72", "#e3e0d8", "#f5f3ee", "#267a5a", "light")
        MathNotesThemeId.READING -> CompanionReaderPalette("#f7f6f2", "#fcfbf8", "#2c2b27", "#77746d", "#dfdcd4", "#f0eee8", "#2f7158", "light")
        MathNotesThemeId.HIGH_CONTRAST -> CompanionReaderPalette("#ffffff", "#ffffff", "#11120f", "#51534c", "#a4a59f", "#f1f1ee", "#006b45", "light")
        MathNotesThemeId.DARK -> CompanionReaderPalette("#171916", "#20231f", "#f1f1ec", "#aaa99f", "#41453f", "#292c28", "#72c59f", "dark")
    }
    val style = """
        <meta name="color-scheme" content="${palette.colorScheme}">
        <link id="mathnotes-android-katex" rel="stylesheet" href="katex/katex.min.css">
        <style id="mathnotes-android-reader">
        :root{color-scheme:${palette.colorScheme}!important;--android-page:${palette.page};--android-paper:${palette.paper};--android-ink:${palette.ink};--android-muted:${palette.muted};--android-line:${palette.line};--android-code:${palette.code};--android-accent:${palette.accent}}
        html,body{width:100%!important;min-width:0!important;max-width:100%!important;overflow-x:hidden!important;background:var(--android-page)!important;color:var(--android-ink)!important}
        body{margin:0!important;padding:18px 16px 48px!important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC",sans-serif!important;font-size:16px!important;line-height:1.72!important;letter-spacing:0!important}
        .session-title,.note-block,h1,h2,h3,h4,h5,h6,p,li,blockquote{min-width:0!important;max-width:100%!important;overflow-wrap:anywhere!important;word-break:normal!important;white-space:normal!important}
        .session-title{font-size:clamp(22px,6vw,28px)!important;line-height:1.28!important;margin:0 0 14px!important}
        .note-block{max-width:100%!important;padding:14px 2px!important;border-color:var(--android-line)!important}
        h1{font-size:1.55em!important}h2{font-size:1.32em!important}h3{font-size:1.16em!important}h1,h2,h3,h4{line-height:1.34!important;margin:12px 0 10px!important}
        p{margin:9px 0!important}ul,ol{max-width:100%!important;padding-left:1.45em!important}li{padding-left:.08em!important}
        blockquote{border-color:var(--android-accent)!important;color:var(--android-muted)!important}
        pre{max-width:100%!important;overflow-x:auto!important;white-space:pre-wrap!important;overflow-wrap:anywhere!important;background:var(--android-code)!important;color:var(--android-ink)!important}
        code{background:var(--android-code)!important;color:var(--android-ink)!important}
        .math-inline{display:inline-block!important;max-width:100%!important;vertical-align:-.12em!important}
        .math-display,math[display="block"]{max-width:100%!important}.math-display{width:100%!important;overflow-x:auto!important;overflow-y:hidden!important;-webkit-overflow-scrolling:touch!important}.math-display math[display="block"]{display:block!important;width:max-content!important;min-width:100%!important;margin:0!important}
        .katex>.katex-html{display:inline-block!important}.math-display .katex>.katex-html,.katex-display>.katex>.katex-html{display:block!important}.katex>.katex-mathml{display:block!important;position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip-path:inset(50%)!important;border:0!important}
        .math-display .katex-display,.math-display .katex-display>.katex,.math-display .katex-display>.katex>.katex-html{width:max-content!important;min-width:100%!important}
        @media(max-width:640px){.math-display .katex-display>.katex>.katex-html>.tag{position:sticky!important;right:0!important;display:block!important;width:max-content!important;min-width:3.5em!important;margin:.4em 0 0 auto!important;text-align:right!important}}
        table{display:block!important;width:100%!important;max-width:100%!important;overflow-x:auto!important;border-collapse:collapse!important;-webkit-overflow-scrolling:touch!important}
        img,svg,video,canvas{display:block!important;max-width:100%!important;height:auto!important;margin:12px auto!important}
        .katex svg{max-width:none!important;height:inherit!important;margin:0!important;border-radius:0!important}
        .math-error{color:#d56f64!important}.asset-sync-warning{background:var(--android-code)!important;border-color:var(--android-line)!important;color:var(--android-muted)!important}
        </style>
    """.trimIndent()
    return when {
        html.contains("</head>", ignoreCase = true) -> html.replaceFirst(Regex("</head>", RegexOption.IGNORE_CASE), "$style</head>")
        html.contains("<body", ignoreCase = true) -> html.replaceFirst(Regex("<body", RegexOption.IGNORE_CASE), "<head>$style</head><body")
        else -> "<!doctype html><html><head>$style</head><body>$html</body></html>"
    }
}

internal fun companionReaderAssetResponse(context: Context, uri: Uri): WebResourceResponse? {
    if (uri.scheme != "https" || uri.host != "appassets.androidplatform.net") return null
    val assetPath = uri.path.orEmpty().removePrefix("/assets/")
    if (!assetPath.startsWith("katex/") || assetPath.contains("..")) return null
    val mimeType = when {
        assetPath.endsWith(".css") -> "text/css"
        assetPath.endsWith(".woff2") -> "font/woff2"
        else -> return null
    }
    return try {
        WebResourceResponse(mimeType, null, context.assets.open(assetPath))
    } catch (_: IOException) {
        null
    }
}

private data class CompanionReaderPalette(
    val page: String,
    val paper: String,
    val ink: String,
    val muted: String,
    val line: String,
    val code: String,
    val accent: String,
    val colorScheme: String
)
