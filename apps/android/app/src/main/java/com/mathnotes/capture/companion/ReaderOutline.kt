package com.mathnotes.capture.companion

import java.net.URI

/** A deep link is resolved only against the current rendered document, never a guessed block. */
internal fun companionReadingAnchor(html: String, blockId: String, imageAnchor: String?): String? {
    if (!blockId.matches(Regex("[A-Za-z0-9_-]+"))) return null
    val blockAnchor = "mathnotes-block-$blockId"
    val anchor = imageAnchor?.takeIf {
        it.startsWith("$blockAnchor-asset-") && it.matches(Regex("[A-Za-z0-9_-]+"))
    } ?: blockAnchor
    return anchor.takeIf { Regex("""\bid=["']${Regex.escape(it)}["']""").containsMatchIn(html) }
}

internal const val READER_OUTLINE_STYLE = """
    .mathnotes-outline{position:sticky;top:0;z-index:10;width:fit-content;max-width:100%;box-sizing:border-box;margin:0 0 14px;border:1px solid var(--android-line);border-radius:14px;background:var(--android-paper);box-shadow:0 3px 12px #00000008}
    .mathnotes-outline summary{cursor:pointer;padding:9px 14px;color:var(--android-accent);font-weight:600;min-height:24px;list-style-position:inside}
    .mathnotes-outline[open]{position:relative;width:100%}.mathnotes-outline nav{max-height:42vh;overflow:auto;padding:0 8px 8px}
    .mathnotes-outline a{display:block;box-sizing:border-box;padding:10px 10px 10px calc(10px + var(--outline-level)*14px);border-radius:9px;color:var(--android-ink);text-decoration:none;line-height:1.45}
    .mathnotes-outline a:active{background:var(--android-code)}[id^="mathnotes-heading-"]{scroll-margin-top:64px}
"""

/** Cached computer HTML remains script-free. Only headings rendered as real HTML enter the outline. */
internal fun addReaderOutline(html: String): String {
    val entries = mutableListOf<Pair<Int, String>>()
    val headingOrRawText = Regex(
        """<(script|style|pre|textarea)\b[^>]*>[\s\S]*?</\1\s*>|<h([1-6])\b([^>]*)>([\s\S]*?)</h\2\s*>""",
        RegexOption.IGNORE_CASE
    )
    val content = headingOrRawText.replace(html) { match ->
        if (match.groupValues[1].isNotBlank() || match.groupValues[3].contains("session-title")) {
            match.value
        } else {
            val label = match.groupValues[4]
                .replace(Regex("<[^>]*>"), "")
                .trim()
            if (label.isBlank()) match.value else {
                val index = entries.size
                entries += match.groupValues[2].toInt() to label
                // Keep original heading IDs and use our own non-conflicting span anchors.
                "<h${match.groupValues[2]}${match.groupValues[3]}><span id=\"mathnotes-heading-$index\"></span>${match.groupValues[4]}</h${match.groupValues[2]}>"
            }
        }
    }
    if (entries.isEmpty()) return html
    val minimumLevel = entries.minOf { it.first }
    val links = entries.mapIndexed { index, (level, label) ->
        "<a href=\"#mathnotes-heading-$index\" style=\"--outline-level:${level - minimumLevel}\">$label</a>"
    }.joinToString("")
    val outline = "<details class=\"mathnotes-outline\"><summary>目录</summary><nav aria-label=\"笔记目录\">$links</nav></details>"
    val body = Regex("<body\\b[^>]*>", RegexOption.IGNORE_CASE).find(content)
    return if (body == null) outline + content else content.replaceRange(body.range, body.value + outline)
}

/** Local Markdown is rendered on-device; use textContent for labels so note text never becomes markup. */
internal const val READER_OUTLINE_SCRIPT = """
    const headings = Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(node => node.textContent.trim());
    if (headings.length) {
      const outline = document.createElement('details'); outline.className = 'mathnotes-outline';
      const summary = document.createElement('summary'); summary.textContent = '目录'; outline.appendChild(summary);
      const nav = document.createElement('nav'); nav.setAttribute('aria-label', '笔记目录'); outline.appendChild(nav);
      const minimumLevel = headings.reduce((level, node) => Math.min(level, Number(node.tagName.substring(1))), 6);
      headings.forEach((heading, index) => {
        const id = 'mathnotes-heading-' + index; heading.id = id;
        const link = document.createElement('a'); link.href = '#' + id; link.textContent = heading.textContent;
        link.style.setProperty('--outline-level', Number(heading.tagName.substring(1)) - minimumLevel);
        link.addEventListener('click', () => { outline.open = false; }); nav.appendChild(link);
      });
      root.before(outline);
    }
"""

/** Allow only this document's generated TOC anchors; all external or script navigation stays blocked. */
internal fun isReaderOutlineNavigation(url: String): Boolean = runCatching {
    val uri = URI(url)
    val isLocalDocument = uri.scheme == "https" && uri.host == "appassets.androidplatform.net" &&
        uri.rawPath == "/assets/" && uri.rawQuery == null && uri.rawUserInfo == null && uri.port == -1
    (isLocalDocument || url.startsWith("#")) && uri.fragment.orEmpty().matches(Regex("mathnotes-(?:heading-[0-9]+|block-[A-Za-z0-9_-]+)"))
}.getOrDefault(false)
