package com.mathnotes.capture

import org.junit.Assert.assertEquals
import org.junit.Test

class CaptureRecognitionRoutingTest {
    @Test
    fun `windows route requires preference verified connection and target together`() {
        for (preferWindows in listOf(false, true)) {
            for (verified in listOf(false, true)) {
                for (hasTarget in listOf(false, true)) {
                    val expected = if (preferWindows && verified && hasTarget) {
                        CaptureRecognitionDestination.WINDOWS_SESSION
                    } else {
                        CaptureRecognitionDestination.ANDROID_LOCAL_DRAFT
                    }
                    assertEquals(
                        "prefer=$preferWindows verified=$verified target=$hasTarget",
                        expected,
                        resolveCaptureRecognitionDestination(preferWindows, verified, hasTarget)
                    )
                }
            }
        }
    }
}
