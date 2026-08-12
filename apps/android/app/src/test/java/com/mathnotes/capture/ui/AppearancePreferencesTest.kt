package com.mathnotes.capture.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class AppearancePreferencesTest {
    @Test
    fun `theme ids match the desktop contract`() {
        assertEquals(
            listOf("default_light", "reading", "high_contrast", "dark"),
            MathNotesThemeId.entries.map { it.storageValue }
        )
    }

    @Test
    fun `unknown theme falls back to the established light theme`() {
        assertEquals(MathNotesThemeId.DEFAULT_LIGHT, MathNotesThemeId.fromStorage(null))
        assertEquals(MathNotesThemeId.DEFAULT_LIGHT, MathNotesThemeId.fromStorage("future_theme"))
    }

    @Test
    fun `locale ids are stable for future resource migration`() {
        assertEquals(listOf("zh-CN", "en-US"), MathNotesLocaleId.entries.map { it.storageValue })
    }
}
