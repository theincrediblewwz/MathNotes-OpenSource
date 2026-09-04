package com.mathnotes.capture.notes

import org.junit.Assert.assertEquals
import org.junit.Test

class UnifiedNotesSourceTest {
    @Test
    fun `notes offers local and computer sources in that order`() {
        assertEquals(listOf("本机", "电脑"), NotesSource.entries.map { it.label })
    }
}
