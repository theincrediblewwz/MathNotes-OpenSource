package com.mathnotes.capture

import androidx.lifecycle.Lifecycle
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InlineCaptureCameraTest {
    @Test
    fun `camera is rebound whenever MathNotes returns to foreground`() {
        assertTrue(shouldRebindInlineCamera(Lifecycle.Event.ON_RESUME))
        assertFalse(shouldRebindInlineCamera(Lifecycle.Event.ON_PAUSE))
        assertFalse(shouldRebindInlineCamera(Lifecycle.Event.ON_STOP))
    }
}
