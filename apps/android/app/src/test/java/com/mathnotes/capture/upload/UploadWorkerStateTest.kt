package com.mathnotes.capture.upload

import com.mathnotes.capture.storage.CaptureState
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UploadWorkerStateTest {
    @Test
    fun `automatic work only processes active upload states`() {
        assertTrue(isAutomaticUploadState(CaptureState.PENDING))
        assertTrue(isAutomaticUploadState(CaptureState.UPLOADING))
        assertTrue(isAutomaticUploadState(CaptureState.RETRYABLE))

        assertFalse(isAutomaticUploadState(CaptureState.PAUSED))
        assertFalse(isAutomaticUploadState(CaptureState.BLOCKED_AUTH))
        assertFalse(isAutomaticUploadState(CaptureState.FAILED_PERMANENT))
        assertFalse(isAutomaticUploadState(CaptureState.UPLOADED))
    }
}
