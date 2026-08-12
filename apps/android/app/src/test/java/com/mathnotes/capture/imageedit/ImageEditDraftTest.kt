package com.mathnotes.capture.imageedit

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageEditDraftTest {
    @Test
    fun undoStageRestoresPreviousFileAndMimeType() {
        val original = File("original.jpg")
        val firstStage = File("stage-1.png")
        val draft = ImageEditDraft(
            sourceFile = firstStage,
            sourceName = "original.jpg",
            mimeType = "image/png",
            captureSource = "gallery",
            stageHistory = listOf(ImageEditStage(original, "image/jpeg"))
        )

        val undone = draft.undoStage()

        assertEquals(original, undone.sourceFile)
        assertEquals("image/jpeg", undone.mimeType)
        assertTrue(undone.cleanupFiles.contains(firstStage))
        assertFalse(undone.canUndoStage())
    }

    @Test
    fun lassoDashAnimationClosesOnDensityScaledCycle() {
        assertEquals(20f, marchingDashCyclePx(1f), 0.001f)
        assertEquals(60f, marchingDashCyclePx(3f), 0.001f)
        assertEquals(2_000f, marchingAnimationTravelPx(1f), 0.001f)
        assertEquals(6_000f, marchingAnimationTravelPx(3f), 0.001f)
    }
}
