package com.mathnotes.capture.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MathNotesSystemBarAppearanceTest {
    @Test
    fun darkThemeUsesDarkCanvasAndLightSystemIcons() {
        val appearance = systemBarAppearanceFor(MathNotesThemeId.DARK)

        assertEquals(0xFF171916.toInt(), appearance.backgroundArgb)
        assertFalse(appearance.useDarkIcons)
    }

    @Test
    fun lightThemesUseTheirCanvasColorAndDarkSystemIcons() {
        val expectedColors = mapOf(
            MathNotesThemeId.DEFAULT_LIGHT to 0xFFFBFAF7.toInt(),
            MathNotesThemeId.READING to 0xFFF7F6F2.toInt(),
            MathNotesThemeId.HIGH_CONTRAST to 0xFFFFFFFF.toInt()
        )

        expectedColors.forEach { (themeId, expectedColor) ->
            val appearance = systemBarAppearanceFor(themeId)
            assertEquals(expectedColor, appearance.backgroundArgb)
            assertTrue(appearance.useDarkIcons)
        }
    }

    @Test
    fun mediaPreviewAlwaysUsesDarkCanvasAndLightIconsThenThemeCanRestore() {
        MathNotesThemeId.entries.forEach { themeId ->
            val preview = systemBarAppearanceFor(themeId, mediaPreviewOpen = true)
            assertEquals(0xFF171816.toInt(), preview.backgroundArgb)
            assertFalse(preview.useDarkIcons)
        }

        val restored = systemBarAppearanceFor(MathNotesThemeId.DEFAULT_LIGHT)
        assertEquals(0xFFFBFAF7.toInt(), restored.backgroundArgb)
        assertTrue(restored.useDarkIcons)
    }
}
