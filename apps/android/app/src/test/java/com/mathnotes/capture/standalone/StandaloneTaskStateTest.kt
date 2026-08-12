package com.mathnotes.capture.standalone

import org.junit.Assert.assertEquals
import org.junit.Test

class StandaloneTaskStateTest {
    @Test fun `unknown paid result is never described as retryable`() {
        assertEquals("结果未知，可能已经计费", taskStatusLabel(StandaloneTaskStatus.POSSIBLY_CHARGED))
    }

    @Test fun `new task waits for explicit confirmation`() {
        assertEquals("等待你确认", taskStatusLabel(StandaloneTaskStatus.AWAITING_CONFIRMATION))
    }
}
