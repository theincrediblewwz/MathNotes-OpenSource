package com.mathnotes.capture.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionApiClientTest {
    @Test
    fun parsesVersionedSnapshot() {
        val snapshot = parseCompanionSnapshot(
            """{"version":1,"notebookId":"analysis","sessionId":"lecture","title":"泛函分析","revision":"abc","updatedAt":"now","markdown":"# note","html":"<html>note</html>","assets":[{"id":"asset-1","path":"assets/embedded/graph.png","mimeType":"image/png"}]}"""
        )

        assertEquals("analysis", snapshot.notebookId)
        assertEquals("lecture", snapshot.sessionId)
        assertTrue(snapshot.html.contains("note"))
        assertEquals("# note", snapshot.markdown)
        assertEquals("assets/embedded/graph.png", snapshot.assets.single().path)
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsUnknownSnapshotVersion() {
        parseCompanionSnapshot(
            """{"version":2,"notebookId":"analysis","sessionId":"lecture","title":"Note","revision":"abc","updatedAt":"now","html":""}"""
        )
    }

    @Test
    fun parsesCatalogWithNullableActiveTarget() {
        val catalog = parseCompanionCatalog(
            """{"ok":true,"version":1,"activeTarget":null,"targets":[{"notebookId":"analysis","notebookTitle":"数学分析","sessionId":"lecture","title":"泛函分析"}]}"""
        )

        assertEquals(null, catalog.activeTarget)
        assertEquals("lecture", catalog.targets.single().sessionId)
        assertEquals("数学分析", catalog.targets.single().notebookTitle)
    }

    @Test
    fun encodesRevisionAsHttpEtag() {
        assertEquals("\"YWJj\"", revisionEtag("abc"))
    }

    @Test
    fun unexpectedSyncErrorsExposeTheirTypeAndMessage() {
        val message = describeUnexpectedSyncError(IllegalStateException("response body failed"))

        assertTrue(message.contains("IllegalStateException"))
        assertTrue(message.contains("response body failed"))
    }
}
