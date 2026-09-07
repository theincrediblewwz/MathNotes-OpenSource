package com.mathnotes.capture.standalone

import android.annotation.SuppressLint
import android.graphics.Color
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.unit.dp
import com.mathnotes.capture.companion.COMPANION_READER_BASE_URL
import com.mathnotes.capture.companion.companionReaderAssetResponse
import com.mathnotes.capture.companion.prepareCompanionReaderHtml
import com.mathnotes.capture.companion.READER_OUTLINE_SCRIPT
import com.mathnotes.capture.companion.isReaderOutlineNavigation
import com.mathnotes.capture.ui.MathNotesColors
import com.mathnotes.capture.ui.MathNotesThemeId
import java.util.Base64
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import com.mathnotes.capture.notes.ReaderHeading
import com.mathnotes.capture.notes.ReaderOutlineBar
import com.mathnotes.capture.notes.ReaderInteractionWebView
import com.mathnotes.capture.notes.NoteReadingRequest

@Composable
internal fun StandaloneMarkdownReader(
    title: String,
    markdown: String,
    themeId: MathNotesThemeId,
    onClose: () -> Unit,
    images: Map<String, File> = emptyMap(),
    blocks: List<StandaloneBlockEntity> = emptyList(),
    readingRequest: NoteReadingRequest? = null,
    onReadingTap: () -> Unit = {},
    onReaderActive: (Boolean) -> Unit = {},
    bottomBarHidden: Boolean = false
) {
    BackHandler(onBack = onClose)
    DisposableEffect(Unit) { onReaderActive(true); onDispose { onReaderActive(false) } }
    Column(Modifier.fillMaxSize().padding(bottom = if (bottomBarHidden) 0.dp else 112.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f)) {
                Text("本机笔记", style = MaterialTheme.typography.labelMedium, color = MathNotesColors.Muted)
                Text(title, style = MaterialTheme.typography.titleLarge, color = MathNotesColors.Ink)
            }
            Spacer(Modifier.width(8.dp))
            TextButton(onClick = onClose) { Text("返回") }
        }
        if (markdown.isBlank()) {
            Box(
                modifier = Modifier.fillMaxWidth().weight(1f).padding(24.dp),
                contentAlignment = Alignment.Center
            ) {
                Text("这份笔记还没有内容", color = MathNotesColors.Muted)
            }
        } else {
            StandaloneMarkdownWebView(markdown, themeId, Modifier.fillMaxWidth().weight(1f), images = images,
                blocks = blocks, readingRequest = readingRequest, onReadingTap = onReadingTap)
        }
    }
}

internal fun prepareStandaloneSessionMarkdown(blocks: List<StandaloneBlockEntity>): String = blocks
    .asSequence()
    .filter { it.kind == StandaloneBlockKind.MARKDOWN_DRAFT }
    .sortedWith(compareBy<StandaloneBlockEntity> { it.createdAt }.thenBy { it.id })
    .map { it.markdown.trim() }
    .filter { it.isNotBlank() }
    .joinToString("\n\n---\n\n")

@Composable
internal fun StandaloneMarkdownPreview(
    markdown: String,
    themeId: MathNotesThemeId,
    modifier: Modifier = Modifier,
    images: Map<String, File> = emptyMap()
) {
    if (markdown.isBlank()) {
        Box(modifier.padding(18.dp), contentAlignment = Alignment.Center) {
            Text("这份笔记还没有正文", color = MathNotesColors.Muted)
        }
    } else {
        StandaloneMarkdownWebView(markdown, themeId, modifier, compact = true, images = images)
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun StandaloneMarkdownWebView(
    markdown: String,
    themeId: MathNotesThemeId,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
    images: Map<String, File> = emptyMap(),
    blocks: List<StandaloneBlockEntity> = emptyList(),
    readingRequest: NoteReadingRequest? = null,
    onReadingTap: () -> Unit = {}
) {
    val currentImages by rememberUpdatedState(images)
    val currentTap by rememberUpdatedState(onReadingTap)
    val currentRequest by rememberUpdatedState(readingRequest)
    var headings by remember(markdown) { mutableStateOf(emptyList<ReaderHeading>()) }
    var browser by remember { mutableStateOf<ReaderInteractionWebView?>(null) }
    var expandedImage by remember(markdown) { mutableStateOf<String?>(null) }
    val readerHtml = remember(markdown, themeId, compact, images.keys, blocks) {
        prepareStandaloneMarkdownReaderHtml(markdown, themeId, compact, images.keys, blocks)
    }
    Column(modifier) {
    if (!compact) ReaderOutlineBar(headings) { heading ->
        browser?.evaluateJavascript("document.getElementById(${JSONObject.quote(heading.anchor)})?.scrollIntoView({block:'start'});", null)
    }
    AndroidView(
        modifier = Modifier.fillMaxWidth().weight(1f),
        factory = { context ->
            ReaderInteractionWebView(context).apply {
                browser = this
                this.onReadingTap = { if (!compact) currentTap() }
                setBackgroundColor(Color.TRANSPARENT)
                settings.javaScriptEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.blockNetworkLoads = true
                settings.domStorageEnabled = false
                settings.databaseEnabled = false
                settings.useWideViewPort = false
                settings.loadWithOverviewMode = false
                settings.textZoom = 100
                settings.setSupportZoom(false)
                settings.builtInZoomControls = false
                settings.displayZoomControls = false
                isHorizontalScrollBarEnabled = false
                overScrollMode = View.OVER_SCROLL_NEVER
                webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView, url: String?) {
                        if (compact) return
                        view.evaluateJavascript("JSON.stringify(Array.from(document.querySelectorAll('#mathnotes-local-markdown h1,#mathnotes-local-markdown h2,#mathnotes-local-markdown h3,#mathnotes-local-markdown h4,#mathnotes-local-markdown h5,#mathnotes-local-markdown h6')).map(h=>({anchor:h.id,label:h.textContent,level:Number(h.tagName.substring(1))})))") { value ->
                            headings = runCatching {
                                val rows = JSONArray(JSONArray("[$value]").getString(0))
                                (0 until rows.length()).map { i -> rows.getJSONObject(i).let { ReaderHeading(it.getString("anchor"), it.getString("label"), it.getInt("level")) } }
                            }.getOrDefault(emptyList())
                        }
                        currentRequest?.let { request ->
                            view.evaluateJavascript(standaloneReadingTargetScript(request), null)
                        }
                    }
                    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                        val uri = request?.url ?: return true
                        val imageLink = standaloneReaderImageLink(uri)
                        if (imageLink != null && currentImages[imageLink]?.isFile == true) {
                            expandedImage = imageLink
                            return true
                        }
                        return !isReaderOutlineNavigation(uri.toString())
                    }

                    override fun shouldInterceptRequest(
                        view: WebView?,
                        request: WebResourceRequest?
                    ) = request?.url?.let { standaloneReaderImageResponse(it, currentImages) ?: companionReaderAssetResponse(context, it) }
                }
            }
        },
        update = { view ->
            if (view.tag != readerHtml.hashCode()) {
                view.tag = readerHtml.hashCode()
                view.loadDataWithBaseURL(COMPANION_READER_BASE_URL, readerHtml, "text/html", "utf-8", null)
            }
        }
    , onRelease = { it.destroy() })
    }
    expandedImage?.takeIf { images[it]?.isFile == true }?.let { link ->
        StandaloneSourceImageViewer(link, images, onClose = { expandedImage = null })
    }
}

internal fun prepareStandaloneMarkdownReaderHtml(
    markdown: String,
    themeId: MathNotesThemeId,
    compact: Boolean = false,
    imageLinks: Set<String> = emptySet(),
    blocks: List<StandaloneBlockEntity> = emptyList()
): String {
    val normalizedMarkdown = normalizeStandaloneMathForPortableMarkdown(markdown)
    val encodedMarkdown = Base64.getEncoder().encodeToString(normalizedMarkdown.toByteArray(Charsets.UTF_8))
    val encodedImageLinks = Base64.getEncoder().encodeToString(imageLinks.joinToString("\n").toByteArray(Charsets.UTF_8))
    val encodedBlocks = Base64.getEncoder().encodeToString(JSONArray(blocks
        .filter { it.kind == StandaloneBlockKind.MARKDOWN_DRAFT }
        .sortedWith(compareBy<StandaloneBlockEntity> { it.createdAt }.thenBy { it.id })
        .map { JSONObject().put("id", it.id).put("markdown", normalizeStandaloneMathForPortableMarkdown(it.markdown)) }).toString().toByteArray(Charsets.UTF_8))
    val compactStyle = if (compact) {
        """
            <style id="mathnotes-local-preview">
            body{padding:7px 10px!important;font-size:12px!important;line-height:1.45!important;overflow:hidden!important}
            .note-block{position:relative!important;max-height:4.35em!important;overflow:hidden!important;padding:0!important}
            .note-block::after{content:"…";position:absolute;right:0;bottom:0;padding-left:18px;background:linear-gradient(90deg,transparent,var(--android-page) 42%);color:var(--android-muted)}
            .note-block h1,.note-block h2,.note-block h3,.note-block h4{font-size:1em!important;line-height:1.45!important;margin:0 0 2px!important}
            .note-block p,.note-block ul,.note-block ol,.note-block blockquote,.note-block pre{margin:0 0 2px!important}
            .note-block .katex-display{margin:.1em 0!important;font-size:.88em!important}
            </style>
        """.trimIndent()
    } else {
        ""
    }
    val body = """
        <article class="note-block" id="mathnotes-local-markdown"></article>
        $compactStyle
        <script src="reader/markdown-it.min.js"></script>
        <script src="katex/katex.min.js"></script>
        <script src="katex/contrib/auto-render.min.js"></script>
        <script>
        (() => {
          const bytes = Uint8Array.from(atob("$encodedMarkdown"), value => value.charCodeAt(0));
          const source = new TextDecoder("utf-8").decode(bytes);
          const root = document.getElementById("mathnotes-local-markdown");
          try {
            const renderer = window.markdownit({html:false,linkify:false,breaks:true,typographer:false});
            const allowedImages = new Set(new TextDecoder('utf-8').decode(Uint8Array.from(atob('$encodedImageLinks'), c => c.charCodeAt(0))).split('\n').filter(Boolean));
            const renderImage = renderer.renderer.rules.image;
            renderer.renderer.rules.image = (tokens, index, options, env, self) => {
              const source = tokens[index].attrGet('src') || '';
              if (!allowedImages.has(source)) return '<span class="source-image-unavailable">[识别照片不可用]</span>';
              const picture = renderImage(tokens, index, options, env, self);
              return '<a class="mathnotes-source-image" aria-label="查看识别照片" href="' + renderer.utils.escapeHtml(source) + '">' + picture + '</a>';
            };
            const blocks = JSON.parse(new TextDecoder('utf-8').decode(Uint8Array.from(atob('$encodedBlocks'), c=>c.charCodeAt(0))));
            if (blocks.length) {
              blocks.forEach(block => { const section = document.createElement('section'); section.id = 'mathnotes-block-' + block.id; section.innerHTML = renderer.render(block.markdown); root.appendChild(section); });
            } else root.innerHTML = renderer.render(source);
            ${if (compact) "" else READER_OUTLINE_SCRIPT}
            const outline = document.querySelector('.mathnotes-outline'); if (outline) outline.hidden = true;
          } catch (_) {
            root.classList.add("math-error");
            root.textContent = "这份笔记暂时无法排版，请稍后重试。";
            return;
          }
          try {
            renderMathInElement(root, {
              delimiters: [
                {left:"\\[",right:"\\]",display:true},
                {left:"\\(",right:"\\)",display:false},
                {left:"${'$'}${'$'}",right:"${'$'}${'$'}",display:true},
                {left:"${'$'}",right:"${'$'}",display:false}
              ],
              throwOnError:false,
              strict:"ignore"
            });
          } catch (_) {}
        })();
        </script>
    """.trimIndent()
    return prepareCompanionReaderHtml(body, themeId)
}

internal fun standaloneReadingTargetScript(request: NoteReadingRequest): String = """
    (() => {
      const block = document.getElementById('mathnotes-block-' + ${JSONObject.quote(request.blockId)});
      if (!block) return false;
      const source = ${JSONObject.quote(request.imageLink.orEmpty())};
      const image = source && Array.from(block.querySelectorAll('img')).find(img => img.getAttribute('src') === source);
      const target = image || block;
      const scroll = () => { target.scrollIntoView({block:'start'}); target.style.outline='2px solid var(--android-accent)'; };
      requestAnimationFrame(scroll);
      if (image && !image.complete) image.addEventListener('load', scroll, {once:true});
      return true;
    })()
""".trimIndent()

internal fun normalizeStandaloneMathForPortableMarkdown(markdown: String): String {
    val lineNormalized = markdown.replace("\r\n", "\n").replace('\r', '\n')
    val readableMarkdown = unwrapPlainTextMarkdownFences(lineNormalized)
    val inlineNormalized = Regex("""\\\(([\s\S]*?)\\\)""").replace(readableMarkdown) { match ->
        "${'$'}${match.groupValues[1].trim()}${'$'}"
    }
    val bracketNormalized = Regex("""(^|\n)[\p{Zs}\t ]*\\\[[\p{Zs}\t ]*\n?([\s\S]*?)\n?[\p{Zs}\t ]*\\\](?=\n|${'$'})""")
        .replace(inlineNormalized) { match ->
            "${match.groupValues[1]}${'$'}${'$'}${collapseStandaloneDisplayMath(match.groupValues[2])}${'$'}${'$'}"
        }
    return Regex("""(^|\n)[\p{Zs}\t ]*\$\$[\p{Zs}\t ]*\n?([\s\S]*?)\n?[\p{Zs}\t ]*\$\$(?=\n|${'$'})""")
        .replace(bracketNormalized) { match ->
            "${match.groupValues[1]}${'$'}${'$'}${collapseStandaloneDisplayMath(match.groupValues[2])}${'$'}${'$'}"
        }
}

private fun collapseStandaloneDisplayMath(math: String): String = math
    .lineSequence()
    .map { line -> line.trimPortableMathWhitespace() }
    .filter { line -> line.isNotBlank() }
    .joinToString(" ")

private fun unwrapPlainTextMarkdownFences(markdown: String): String = Regex(
    """(^|\n)[\p{Zs}\t ]*```(?:text|markdown|md)[\p{Zs}\t ]*\n([\s\S]*?)\n[\p{Zs}\t ]*```(?=\n|${'$'})""",
    RegexOption.IGNORE_CASE
).replace(markdown) { match -> "${match.groupValues[1]}${match.groupValues[2]}" }

private fun String.trimPortableMathWhitespace(): String = trim { character ->
    character == '\t' || Character.isWhitespace(character) || Character.isSpaceChar(character)
}
