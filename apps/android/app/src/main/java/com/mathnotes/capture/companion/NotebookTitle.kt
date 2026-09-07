package com.mathnotes.capture.companion

/** Older servers and cache rows may only contain the storage directory ID. */
internal fun resolveNotebookTitle(notebookId: String, advertised: String, cached: String = ""): String =
    listOf(advertised, cached).firstOrNull { it.isNotBlank() && it != notebookId }
        ?: "未命名笔记本"
