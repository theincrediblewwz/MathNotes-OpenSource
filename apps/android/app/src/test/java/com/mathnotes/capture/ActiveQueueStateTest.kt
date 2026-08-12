package com.mathnotes.capture

import com.mathnotes.capture.storage.CaptureState
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ActiveQueueStateTest {
    @Test
    fun `home count only includes work that still needs automatic upload`() {
        assertTrue(isActiveQueueState(CaptureState.PENDING))
        assertTrue(isActiveQueueState(CaptureState.UPLOADING))
        assertTrue(isActiveQueueState(CaptureState.RETRYABLE))

        assertFalse(isActiveQueueState(CaptureState.UPLOADED))
        assertFalse(isActiveQueueState(CaptureState.PAUSED))
        assertFalse(isActiveQueueState(CaptureState.BLOCKED_AUTH))
        assertFalse(isActiveQueueState(CaptureState.FAILED_PERMANENT))
    }
}
