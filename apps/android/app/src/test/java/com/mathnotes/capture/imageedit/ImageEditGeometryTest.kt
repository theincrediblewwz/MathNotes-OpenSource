package com.mathnotes.capture.imageedit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageEditGeometryTest {
    @Test
    fun cropIncludesTheSelectedPixelBoundariesWithoutExtraFloatingPointPixels() {
        assertEquals(ImagePixelRect(28, 25, 98, 75), imagePixelCrop(100, 100, NormalizedRect(0.28, 0.25, 0.7, 0.5)))
        assertEquals(ImagePixelRect(0, 0, 4032, 3024), imagePixelCrop(4032, 3024, NormalizedRect(0.0, 0.0, 1.0, 1.0)))
        assertEquals(ImagePixelRect(403, 604, 3629, 2722), imagePixelCrop(4032, 3024, NormalizedRect(0.1, 0.2, 0.8, 0.7)))
    }

    @Test
    fun previewDecodeStaysWithinBudgetForHighResolutionCameraImages() {
        for ((width, height) in listOf(4032 to 3024, 8192 to 6144, 16384 to 12288, 2049 to 1000, 100 to 50)) {
            val sample = previewSampleSize(width, height, 2048)
            assertTrue(kotlin.math.ceil(maxOf(width, height).toDouble() / sample) <= 2048)
        }
    }

    @Test
    fun landscapePortraitAndSquareKeepAllHandlesInsideTheCanvas() {
        for ((width, height) in listOf(4032 to 3024, 3024 to 4032, 2000 to 2000)) {
            val display = imageDisplayRect(360f, 250f, width, height, 24f)
            assertTrue(display.left >= 24f)
            assertTrue(display.top >= 24f)
            assertTrue(display.left + display.width <= 336f)
            assertTrue(display.top + display.height <= 226f)
            assertEquals(width.toFloat() / height, display.width / display.height, 0.0001f)
        }
    }

    @Test
    fun rotationKeepsTheRedactedRegionOnTheSameImageContent() {
        val original = ImageAnnotationObject.Redaction("mask", listOf(NormalizedPoint(0.1, 0.2), NormalizedPoint(0.4, 0.2)), 0.05)
        val rotated = rotateAnnotationClockwise(original) as ImageAnnotationObject.Redaction
        assertEquals(listOf(NormalizedPoint(0.8, 0.1), NormalizedPoint(0.8, 0.4)), rotated.points)
        var fullTurn: ImageAnnotationObject = original
        repeat(4) { fullTurn = rotateAnnotationClockwise(fullTurn) }
        assertEquals(original, fullTurn)
    }

    @Test
    fun opaqueRedactionUsesExistingPortableAnnotationValidation() {
        ImageTransformContract.validate(ImageTransformSidecar(
            sourceAsset = "source.jpg", sourceSha256 = "a".repeat(64), outputAsset = "edited.png",
            operations = emptyList(), annotations = listOf(ImageAnnotationObject.Redaction("mask", listOf(NormalizedPoint(0.2, 0.2), NormalizedPoint(0.8, 0.8)), 0.1)),
            createdAt = "2026-09-07T00:00:00Z"
        ))
    }
}
