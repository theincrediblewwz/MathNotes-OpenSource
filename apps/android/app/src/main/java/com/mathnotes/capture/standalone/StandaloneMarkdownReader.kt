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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.unit.dp
import com.mathnotes.capture.companion.COMPANION_READER_BASE_URL
import com.mathnotes.capture.companion.companionReaderAssetResponse
import com.mathnotes.capture.companion.prepareCompanionReaderHtml
import com.mathnotes.capture.ui.MathNotesColors
import com.mathnotes.capture.ui.MathNotesThemeId
import java.util.Base64

@Composable
internal fun StandaloneMarkdownReader(
    title: String,
    markdown: String,
    themeId: MathNotesThemeId,
    onClose: () -> Unit
) {
    BackHandler(onBack = onClose)
    Column(Modifier.fillMaxSize()) {
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
            StandaloneMarkdownWebView(markdown, themeId, Modifier.fillMaxWidth().weight(1f))
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
    modifier: Modifier = Modifier
) {
    if (markdown.isBlank()) {
        Box(modifier.padding(18.dp), contentAlignment = Alignment.Center) {
            Text("这份笔记还没有正文", color = MathNotesColors.Muted)
        }
    } else {
        StandaloneMarkdownWebView(markdown, themeId, modifier, compact = true)
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun StandaloneMarkdownWebView(
    markdown: String,
    themeId: MathNotesThemeId,
    modifier: Modifier = Modifier,
    compact: Boolean = false
) {
    val readerHtml = remember(markdown, themeId, compact) {
        prepareStandaloneMarkdownReaderHtml(markdown, themeId, compact)
    }
    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
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
                    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = true

                    override fun shouldInterceptRequest(
                        view: WebView?,
                        request: WebResourceRequest?
                    ) = request?.url?.let { companionReaderAssetResponse(context, it) }
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

internal fun prepareStandaloneMarkdownReaderHtml(
    markdown: String,
    themeId: MathNotesThemeId,
    compact: Boolean = false
): String {
    val normalizedMarkdown = normalizeStandaloneMathForPortableMarkdown(markdown)
    val encodedMarkdown = Base64.getEncoder().encodeToString(normalizedMarkdown.toByteArray(Charsets.UTF_8))
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
            root.innerHTML = renderer.render(source);
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
