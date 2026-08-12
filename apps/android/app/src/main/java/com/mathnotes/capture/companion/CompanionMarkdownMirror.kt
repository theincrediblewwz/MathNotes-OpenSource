package com.mathnotes.capture.companion

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class CompanionMarkdownMirror(private val context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    val treeUri: Uri?
        get() = preferences.getString(TREE_URI, null)?.let(Uri::parse)

    fun selectTree(uri: Uri) {
        context.contentResolver.takePersistableUriPermission(
            uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        )
        preferences.edit().putString(TREE_URI, uri.toString()).apply()
    }

    suspend fun writeSnapshot(snapshot: CompanionSessionSnapshot): Uri? = withContext(Dispatchers.IO) {
        writeMarkdown(snapshot.notebookId, snapshot.sessionId, snapshot.title, snapshot.markdown)
    }

    suspend fun writeEntity(session: CompanionSessionEntity): Uri? = withContext(Dispatchers.IO) {
        writeMarkdown(session.notebookId, session.sessionId, session.title, session.markdown)
    }

    private fun writeMarkdown(notebookId: String, sessionId: String, title: String, markdown: String): Uri? {
        val rootTree = treeUri ?: return null
        if (markdown.isBlank()) return null
        val resolver = context.contentResolver
        val root = DocumentsContract.buildDocumentUriUsingTree(
            rootTree,
            DocumentsContract.getTreeDocumentId(rootTree)
        )
        val notebookName = safeFileName(notebookId.ifBlank { "MathNotes" })
        val notebook = findChild(rootTree, root, notebookName)
            ?: DocumentsContract.createDocument(resolver, root, DocumentsContract.Document.MIME_TYPE_DIR, notebookName)
            ?: return null
        val sessionSuffix = safeFileName(sessionId).takeLast(16)
        val fileName = "${safeFileName(title.ifBlank { "未命名" })} [$sessionSuffix].md"
        val file = findChild(rootTree, notebook, fileName)
            ?: DocumentsContract.createDocument(resolver, notebook, "text/markdown", fileName)
            ?: return null
        resolver.openOutputStream(file, "wt")?.bufferedWriter(Charsets.UTF_8)?.use { writer ->
            writer.write(markdown)
            if (!markdown.endsWith('\n')) writer.newLine()
        } ?: return null
        return file
    }

    private fun findChild(treeUri: Uri, parent: Uri, displayName: String): Uri? {
        val resolver = context.contentResolver
        val parentId = DocumentsContract.getDocumentId(parent)
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId)
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME
        )
        return resolver.query(children, projection, null, null, null)?.use { cursor ->
            val idIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
            val nameIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
            while (cursor.moveToNext()) {
                if (cursor.getString(nameIndex) == displayName) {
                    return@use DocumentsContract.buildDocumentUriUsingTree(treeUri, cursor.getString(idIndex))
                }
            }
            null
        }
    }

    private fun safeFileName(value: String): String = value
        .replace(Regex("[\\\\/:*?\"<>|]"), "_")
        .trim()
        .take(80)
        .ifBlank { "未命名" }

    companion object {
        private const val PREFERENCES = "companion_markdown_mirror"
        private const val TREE_URI = "tree_uri"
    }
}
