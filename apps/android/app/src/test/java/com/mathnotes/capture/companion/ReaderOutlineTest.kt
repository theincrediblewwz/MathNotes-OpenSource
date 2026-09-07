package com.mathnotes.capture.companion

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ReaderOutlineTest {
    @Test fun blockLocationWaitsForHydratedBodyAndOutlinePreservesItsRealAnchor() {
        assertNull(companionReadingAnchor("", "result", null))
        val body = "<html><body><h1>第一章</h1><section data-block-id=\"result\"><h2>图形</h2><img id=\"mathnotes-block-result-asset-real\"></section></body></html>"
        val reader = addReaderOutline(ensureCompanionBlockAnchors(body))
        assertTrue(reader.contains("<section id=\"mathnotes-block-result\" data-block-id=\"result\">"))
        assertEquals("mathnotes-block-result", companionReadingAnchor(reader, "result", null))
        assertEquals("mathnotes-block-result-asset-real", companionReadingAnchor(reader, "result", "mathnotes-block-result-asset-real"))
        assertNull(companionReadingAnchor(reader, "deleted", null))
        assertNull(companionReadingAnchor(reader, "result", "mathnotes-block-result-asset-missing"))
        assertNull(companionReadingAnchor(reader, "bad\"id", null))
    }

    @Test fun collapsedOutlinePreservesHierarchyAndExistingAnchors() {
        val html = addReaderOutline("<html><body><h1 class=\"session-title\">笔记名</h1><h1 id=\"original\">第一章</h1><h2>小节 &amp; 例子</h2><h3><em>细节</em></h3></body></html>")
        assertTrue(html.contains("<body><details class=\"mathnotes-outline\">"))
        assertFalse(html.contains("<details open"))
        assertFalse(html.contains(">笔记名</a>"))
        assertTrue(html.contains("<h1 id=\"original\"><span id=\"mathnotes-heading-0\""))
        assertTrue(html.contains("href=\"#mathnotes-heading-1\" style=\"--outline-level:1\">小节 &amp; 例子"))
        assertTrue(html.contains("--outline-level:2\">细节</a>"))
    }

    @Test fun excludesCodeAndPreservesEscapedUntrustedText() {
        val html = addReaderOutline("<pre><h1>代码</h1></pre><h2>&lt;img onerror=alert(1)&gt;</h2>")
        assertFalse(html.contains(">代码</a>"))
        assertTrue(html.contains(">&lt;img onerror=alert(1)&gt;</a>"))
        assertFalse(addReaderOutline("<p>正文</p>").contains("<details"))
    }

    @Test fun onlyAllowsGeneratedAnchorsWithinTheReader() {
        assertTrue(isReaderOutlineNavigation("#mathnotes-heading-12"))
        assertTrue(isReaderOutlineNavigation("https://appassets.androidplatform.net/assets/#mathnotes-heading-0"))
        assertFalse(isReaderOutlineNavigation("https://example.com/assets/#mathnotes-heading-0"))
        assertFalse(isReaderOutlineNavigation("javascript:alert(1)#mathnotes-heading-0"))
        assertFalse(isReaderOutlineNavigation("https://appassets.androidplatform.net/assets/page#mathnotes-heading-0"))
        assertFalse(isReaderOutlineNavigation("https://appassets.androidplatform.net/assets/?x=1#mathnotes-heading-0"))
    }
}
