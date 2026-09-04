package com.mathnotes.capture.standalone

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StandaloneCaptureImportRoutingTest {
    @Test
    fun configuredCameraCaptureIsEnqueuedImmediately() {
        val calls = mutableListOf<Pair<String, Boolean>>()
        val task = task(
            providerId = "deepseek",
            status = StandaloneTaskStatus.AWAITING_CONFIRMATION
        )

        val enqueued = enqueueCapturedRecognitionIfReady(task, autoStartRecognition = true) { id, network ->
            calls += id to network
        }

        assertTrue(enqueued)
        assertTrue(calls == listOf("task-1" to true))
    }

    @Test
    fun unconfiguredOrManuallyImportedImageIsNotAutoCharged() {
        val calls = mutableListOf<String>()

        assertFalse(enqueueCapturedRecognitionIfReady(
            task(providerId = "unconfigured", status = StandaloneTaskStatus.NEEDS_CONFIGURATION),
            autoStartRecognition = true
        ) { id, _ -> calls += id })
        assertFalse(enqueueCapturedRecognitionIfReady(
            task(providerId = "deepseek", status = StandaloneTaskStatus.AWAITING_CONFIRMATION),
            autoStartRecognition = false
        ) { id, _ -> calls += id })
        assertTrue(calls.isEmpty())
    }

    private fun task(providerId: String, status: String) = StandaloneRecognitionTaskEntity(
        id = "task-1",
        sessionId = "session-1",
        assetBlockId = "asset-1",
        providerId = providerId,
        destination = "https://api.example.test/chat/completions",
        model = "vision-model",
        status = status,
        createdAt = 1,
        updatedAt = 1
    )
}
