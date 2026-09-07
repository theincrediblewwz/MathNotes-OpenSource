package com.mathnotes.capture.standalone

internal fun buildStandaloneNotebookExportMarkdown(
    notebook: StandaloneNotebookEntity,
    sessions: List<StandaloneSessionEntity>,
    blocksBySession: Map<String, List<StandaloneBlockEntity>>
): String {
    return standaloneNotebookExportParts(notebook, sessions, blocksBySession).joinToString("") { it.markdown }
}

internal data class StandaloneNotebookExportPart(val sessionId: String?, val markdown: String)

internal fun standaloneNotebookExportParts(
    notebook: StandaloneNotebookEntity,
    sessions: List<StandaloneSessionEntity>,
    blocksBySession: Map<String, List<StandaloneBlockEntity>>
): List<StandaloneNotebookExportPart> {
    val notebookTitle = notebook.title.singleLineTitle("未命名 Notebook")
    val orderedSessions = sessions
        .filter { it.notebookId == notebook.id }
        .sortedWith(compareBy<StandaloneSessionEntity> { it.createdAt }.thenBy { it.id })
    if (orderedSessions.isEmpty()) return listOf(StandaloneNotebookExportPart(null, "# $notebookTitle\n\n_这个 Notebook 还没有 Session。_\n"))

    val sections = orderedSessions.mapIndexed { index, session ->
        val sessionTitle = session.title.singleLineTitle("未命名 Session")
        val markdown = prepareStandaloneSessionMarkdown(blocksBySession[session.id].orEmpty()).trim()
        val separator = if (index == orderedSessions.lastIndex) "\n" else "\n\n---\n\n"
        StandaloneNotebookExportPart(session.id, "## $sessionTitle\n\n${markdown.ifBlank { "_这份 Session 还没有正文。_" }}$separator")
    }
    return listOf(StandaloneNotebookExportPart(null, "# $notebookTitle\n\n")) + sections
}

internal fun buildStandaloneSessionExportMarkdown(
    session: StandaloneSessionEntity,
    blocks: List<StandaloneBlockEntity>
): String {
    val sessionTitle = session.title.singleLineTitle("未命名 Session")
    val markdown = prepareStandaloneSessionMarkdown(blocks).trim()
    return "# $sessionTitle\n\n${markdown.ifBlank { "_这份 Session 还没有正文。_" }}\n"
}

internal fun standaloneNotebookExportFileName(title: String): String =
    standaloneExportFileName(title, "MathNotes-Notebook")

internal fun standaloneSessionExportFileName(title: String): String =
    standaloneExportFileName(title, "MathNotes-Session")

private fun standaloneExportFileName(title: String, fallback: String): String {
    val safe = title
        .singleLineTitle(fallback)
        .replace(Regex("""[\\/:*?\"<>|\p{Cc}]"""), "_")
        .trim(' ', '.')
        .take(80)
        .ifBlank { fallback }
    return "$safe.md"
}

private fun String.singleLineTitle(fallback: String): String =
    lineSequence().joinToString(" ") { it.trim() }.trim().ifBlank { fallback }
