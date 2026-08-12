package com.mathnotes.capture.companion

import com.mathnotes.capture.ui.MathNotesThemeId
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionReaderHtmlTest {
    private val legacySnapshot = """
        <!doctype html>
        <html lang="zh-CN"><head><style>:root{color-scheme:light}</style></head>
        <body><h1 class="session-title">a_very_long_session_title_that_must_wrap</h1>
        <section class="note-block"><p>正文</p><math display="block"><mi>x</mi></math></section></body></html>
    """.trimIndent()

    @Test
    fun injectsResponsiveReaderContractIntoExistingSnapshots() {
        val prepared = prepareCompanionReaderHtml(legacySnapshot, MathNotesThemeId.DEFAULT_LIGHT)

        assertTrue(prepared.contains("id=\"mathnotes-android-reader\""))
        assertTrue(prepared.contains("overflow-x:hidden!important"))
        assertTrue(prepared.contains("overflow-wrap:anywhere!important"))
        assertTrue(prepared.contains(".math-display,math[display=\"block\"]"))
        assertTrue(prepared.contains("id=\"mathnotes-android-katex\""))
        assertTrue(prepared.contains("href=\"katex/katex.min.css\""))
        assertTrue(prepared.contains(".katex>.katex-html{display:inline-block!important}"))
        assertTrue(prepared.contains(".math-display .katex-display>.katex>.katex-html{width:max-content!important;min-width:100%!important}"))
        assertTrue(prepared.contains(".katex-html>.tag{position:sticky!important;right:0!important;display:block!important"))
        assertTrue(prepared.contains(".katex svg{max-width:none!important;height:inherit!important;margin:0!important"))
        assertTrue(prepared.contains(".katex>.katex-mathml{display:block!important;position:absolute!important"))
        assertFalse(prepared.contains("white-space:nowrap"))
    }

    @Test
    fun injectsExplicitDarkPaletteInsteadOfLeavingTheCachedWhitePage() {
        val prepared = prepareCompanionReaderHtml(legacySnapshot, MathNotesThemeId.DARK)

        assertTrue(prepared.contains("content=\"dark\""))
        assertTrue(prepared.contains("--android-page:#171916"))
        assertTrue(prepared.contains("--android-paper:#20231f"))
        assertTrue(prepared.contains("--android-ink:#f1f1ec"))
        assertTrue(prepared.contains("background:var(--android-page)!important"))
    }

    @Test
    fun wrapsFragmentsThatDoNotContainACompleteHtmlDocument() {
        val prepared = prepareCompanionReaderHtml("<p>离线正文</p>", MathNotesThemeId.READING)

        assertTrue(prepared.startsWith("<!doctype html>"))
        assertTrue(prepared.contains("<body><p>离线正文</p></body>"))
    }
}
