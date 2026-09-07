package com.mathnotes.capture.standalone

import com.mathnotes.capture.ui.MathNotesThemeId
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class StandaloneMarkdownReaderTest {
    @Test
    fun `full reader builds a collapsed heading outline while card previews stay compact`() {
        val full = prepareStandaloneMarkdownReaderHtml("# 第一章\n\n## 子节", MathNotesThemeId.READING)
        val compact = prepareStandaloneMarkdownReaderHtml("# 第一章\n\n## 子节", MathNotesThemeId.READING, compact = true)
        assertTrue(full.contains("outline.className = 'mathnotes-outline'"))
        assertTrue(full.contains("link.textContent = heading.textContent"))
        assertTrue(full.contains("outline.open = false"))
        assertFalse(full.contains("outline.open = true"))
        assertFalse(compact.contains("outline.className = 'mathnotes-outline'"))
    }

    @Test
    fun `local reader uses bundled Markdown and KaTeX without embedding raw note markup`() {
        val html = prepareStandaloneMarkdownReaderHtml("# 标题\n\n${'$'}${'$'}x_i^2${'$'}${'$'}\n<script>alert(1)</script>", MathNotesThemeId.READING)

        assertTrue(html.contains("reader/markdown-it.min.js"))
        assertTrue(html.contains("katex/katex.min.js"))
        assertTrue(html.contains("katex/contrib/auto-render.min.js"))
        assertTrue(html.contains("html:false"))
        assertTrue(html.contains("{left:\"\\\\[\",right:\"\\\\]\",display:true}"))
        assertTrue(html.contains("{left:\"\\\\(\",right:\"\\\\)\",display:false}"))
        assertTrue(html.contains("blockNetworkLoads").not())
        assertFalse(html.contains("<script>alert(1)</script>"))
        assertFalse(html.contains("root.textContent = source"))
        assertTrue(html.contains("--android-page:#f7f6f2"))
    }

    @Test
    fun `session reader combines only readable drafts in chronological order`() {
        val blocks = listOf(
            block(id = "later", kind = StandaloneBlockKind.MARKDOWN_DRAFT, markdown = "## 第二页", createdAt = 20),
            block(id = "photo", kind = StandaloneBlockKind.IMAGE, markdown = "不应显示", createdAt = 15),
            block(id = "earlier", kind = StandaloneBlockKind.MARKDOWN_DRAFT, markdown = "# 第一页", createdAt = 10),
            block(id = "blank", kind = StandaloneBlockKind.MARKDOWN_DRAFT, markdown = "  ", createdAt = 30)
        )

        assertEquals("# 第一页\n\n---\n\n## 第二页", prepareStandaloneSessionMarkdown(blocks))
    }

    @Test
    fun `reader normalizes PC style math before Markdown consumes backslashes`() {
        val markdown = """
            设 \(X, \|x\|\) 为赋范空间。

            \[
            \forall \varepsilon > 0, \exists N
            \]
        """.trimIndent()

        assertEquals(
            """
                设 ${'$'}X, \|x\|${'$'} 为赋范空间。

                ${'$'}${'$'}\forall \varepsilon > 0, \exists N${'$'}${'$'}
            """.trimIndent(),
            normalizeStandaloneMathForPortableMarkdown(markdown)
        )
    }

    @Test
    fun `reader normalizes indented CRLF display math before Markdown treats it as code`() {
        val markdown = "函数为\r\n\r\n    ${'$'}${'$'}\r\n    \\mathscr{D}Q(\\xi,A,Q)=\\rho_{f,0}-\\rho_{s,0}\r\n    ${'$'}${'$'}\r\n\r\n中性曲面"

        val normalized = normalizeStandaloneMathForPortableMarkdown(markdown)

        assertEquals(
            "函数为\n\n${'$'}${'$'}\\mathscr{D}Q(\\xi,A,Q)=\\rho_{f,0}-\\rho_{s,0}${'$'}${'$'}\n\n中性曲面",
            normalized
        )
        assertFalse(normalized.contains("\r"))
        assertFalse(normalized.contains("    ${'$'}${'$'}"))
    }

    @Test
    fun `reader collapses multiline display math before Markdown inserts line break elements`() {
        val markdown = """
            函数为

            ${'$'}${'$'}
            \mathscr{D}Q(\xi,A,Q)=\rho_{f,0}-
            \rho_{s,0}=\xi-\dfrac{A}
            {\sqrt{Q+2s\xi}}+\mathcal{T}(-\xi).
            ${'$'}${'$'}

            中性曲面。对每个 ${'$'}Q\in I_Q${'$'}，
        """.trimIndent().replace("\n${'$'}${'$'}", "\n\u3000${'$'}${'$'}")

        val normalized = normalizeStandaloneMathForPortableMarkdown(markdown)

        assertEquals(
            "函数为\n\n${'$'}${'$'}\\mathscr{D}Q(\\xi,A,Q)=\\rho_{f,0}- \\rho_{s,0}=\\xi-\\dfrac{A} {\\sqrt{Q+2s\\xi}}+\\mathcal{T}(-\\xi).${'$'}${'$'}\n\n中性曲面。对每个 ${'$'}Q\\in I_Q${'$'}，",
            normalized
        )
        assertFalse(normalized.substringAfter("${'$'}${'$'}").substringBefore("${'$'}${'$'}").contains('\n'))
    }

    @Test
    fun `reader unwraps provider plain text fences but preserves actual code fences`() {
        val markdown = """
            ```text
            函数为

            ${'$'}${'$'}
            x^2+y^2=1
            ${'$'}${'$'}
            ```

            ```kotlin
            val literal = "${'$'}${'$'}"
            ```
        """.trimIndent()

        val normalized = normalizeStandaloneMathForPortableMarkdown(markdown)

        assertTrue(normalized.startsWith("函数为\n\n${'$'}${'$'}x^2+y^2=1${'$'}${'$'}"))
        assertTrue(normalized.contains("```kotlin"))
        assertFalse(normalized.contains("```text"))
    }

    @Test
    fun `compact preview keeps real renderer and limits it to three small lines`() {
        val html = prepareStandaloneMarkdownReaderHtml("# 标题\n\n${'$'}${'$'}x^2${'$'}${'$'}", MathNotesThemeId.READING, compact = true)

        assertTrue(html.contains("id=\"mathnotes-local-preview\""))
        assertTrue(html.contains("font-size:12px!important"))
        assertTrue(html.contains("max-height:4.35em!important"))
        assertTrue(html.contains("content:\"…\""))
        assertTrue(html.contains("katex/contrib/auto-render.min.js"))
    }

    private fun block(id: String, kind: String, markdown: String, createdAt: Long) = StandaloneBlockEntity(
        id = id,
        sessionId = "session",
        kind = kind,
        localPath = "",
        markdown = markdown,
        locked = false,
        createdAt = createdAt,
        updatedAt = createdAt
    )
}
