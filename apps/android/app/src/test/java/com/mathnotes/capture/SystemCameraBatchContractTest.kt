package com.mathnotes.capture

import org.junit.Assert.assertEquals
import org.junit.Test

class SystemCameraBatchContractTest {
    @Test
    fun `system camera return either stops edits or enqueues one photo`() {
        assertEquals(
            SystemCameraReturnAction.STOP,
            systemCameraReturnAction(saved = false, hasFile = true, editAfterCapture = false)
        )
        assertEquals(
            SystemCameraReturnAction.EDIT,
            systemCameraReturnAction(saved = true, hasFile = true, editAfterCapture = true)
        )
        assertEquals(
            SystemCameraReturnAction.ENQUEUE,
            systemCameraReturnAction(saved = true, hasFile = true, editAfterCapture = false)
        )
        assertEquals(
            SystemCameraReturnAction.STOP,
            systemCameraReturnAction(saved = true, hasFile = false, editAfterCapture = false)
        )
    }

    @Test
    fun `gallery selection stays inside the available recent captures`() {
        assertEquals(0, coerceGalleryIndex(-1, 3))
        assertEquals(2, coerceGalleryIndex(8, 3))
        assertEquals(0, coerceGalleryIndex(4, 0))
    }
}
