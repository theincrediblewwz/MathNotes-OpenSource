package com.mathnotes.capture

import org.junit.Assert.assertEquals
import org.junit.Test

class CameraZoomTest {
    @Test
    fun presetsIncludeWideStandardAndUsefulTelephotoRatios() {
        assertEquals(listOf(0.6f, 1f, 2f, 5f), cameraZoomPresets(0.6f, 8f))
    }

    @Test
    fun presetsRespectLimitedCameraRange() {
        assertEquals(listOf(1f, 2f, 3f), cameraZoomPresets(1f, 3f))
        assertEquals(listOf(1f, 1.5f), cameraZoomPresets(1f, 1.5f))
        assertEquals(listOf(1f), cameraZoomPresets(1f, 1f))
    }

    @Test
    fun clampAndFormatUseActualCameraCapabilities() {
        assertEquals(0.6f, clampCameraZoom(0.2f, 0.6f, 8f))
        assertEquals(8f, clampCameraZoom(10f, 0.6f, 8f))
        assertEquals("1×", formatCameraZoom(1f))
        assertEquals("0.6×", formatCameraZoom(0.6f))
    }
}
