package com.mathnotes.capture

import org.junit.Assert.assertEquals
import org.junit.Test

class CaptureQueueStateTest {
    @Test
    fun `every durable state has user-facing copy`() {
        val labels = CaptureQueueState.entries.map(CaptureQueueState::statusLabel)

        assertEquals(CaptureQueueState.entries.size, labels.toSet().size)
        assertEquals("已发送到电脑", CaptureQueueState.UPLOADED.statusLabel())
        assertEquals("需要重新配对", CaptureQueueState.BLOCKED_AUTH.statusLabel())
    }
}
