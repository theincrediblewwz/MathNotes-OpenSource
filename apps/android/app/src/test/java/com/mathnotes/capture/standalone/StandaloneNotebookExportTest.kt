package com.mathnotes.capture.standalone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StandaloneNotebookExportTest {
    @Test
    fun `notebook export keeps notebook and session names with readable markdown only`() {
        val notebook = notebook("analysis", "泛函分析")
        val first = session("s1", notebook.id, "有界算子", 10)
        val second = session("s2", notebook.id, "谱理论", 20)

        val markdown = buildStandaloneNotebookExportMarkdown(
            notebook,
            listOf(second, first),
            mapOf(
                first.id to listOf(block("image", first.id, StandaloneBlockKind.IMAGE, "不应导出", 1), block("draft", first.id, StandaloneBlockKind.MARKDOWN_DRAFT, "设 ${'$'}T:X\\to Y${'$'}。", 2)),
                second.id to emptyList()
            )
        )

        assertTrue(markdown.startsWith("# 泛函分析\n\n## 有界算子"))
        assertTrue(markdown.contains("设 ${'$'}T:X\\to Y${'$'}。"))
        assertTrue(markdown.contains("## 谱理论\n\n_这份 Session 还没有正文。_"))
        assertFalse(markdown.contains("不应导出"))
    }

    @Test
    fun `export filename is safe for the system document picker`() {
        assertEquals("泛函_分析_第一讲.md", standaloneNotebookExportFileName(" 泛函/分析:第一讲. "))
        assertEquals("有界算子_第一节.md", standaloneSessionExportFileName(" 有界算子:第一节. "))
    }

    @Test
    fun `session export is available for the note users long press`() {
        val session = session("s1", "analysis", "有界算子", 10)
        val markdown = buildStandaloneSessionExportMarkdown(
            session,
            listOf(
                block("image", session.id, StandaloneBlockKind.IMAGE, "不应导出", 1),
                block("draft", session.id, StandaloneBlockKind.MARKDOWN_DRAFT, "设 ${'$'}T:X\\to Y${'$'}。", 2)
            )
        )

        assertEquals("# 有界算子\n\n设 ${'$'}T:X\\to Y${'$'}。\n", markdown)
        assertFalse(markdown.contains("不应导出"))
    }

    private fun notebook(id: String, title: String) = StandaloneNotebookEntity(id, title, 1, 1)
    private fun session(id: String, notebookId: String, title: String, createdAt: Long) =
        StandaloneSessionEntity(id, notebookId, title, createdAt, createdAt)
    private fun block(id: String, sessionId: String, kind: String, markdown: String, createdAt: Long) =
        StandaloneBlockEntity(id, sessionId, kind, "", markdown, false, createdAt, createdAt)
}
