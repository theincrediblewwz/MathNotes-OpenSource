package com.mathnotes.capture.standalone

internal fun buildStandaloneNotebookExportMarkdown(
    notebook: StandaloneNotebookEntity,
    sessions: List<StandaloneSessionEntity>,
    blocksBySession: Map<String, List<StandaloneBlockEntity>>
): String {
    val notebookTitle = notebook.title.singleLineTitle("未命名 Notebook")
    val orderedSessions = sessions
        .filter { it.notebookId == notebook.id }
        .sortedWith(compareBy<StandaloneSessionEntity> { it.createdAt }.thenBy { it.id })
    if (orderedSessions.isEmpty()) return "# $notebookTitle\n\n_这个 Notebook 还没有 Session。_\n"

    val sections = orderedSessions.map { session ->
        val sessionTitle = session.title.singleLineTitle("未命名 Session")
        val markdown = prepareStandaloneSessionMarkdown(blocksBySession[session.id].orEmpty()).trim()
        "## $sessionTitle\n\n${markdown.ifBlank { "_这份 Session 还没有正文。_" }}"
    }
    return "# $notebookTitle\n\n${sections.joinToString("\n\n---\n\n")}\n"
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
