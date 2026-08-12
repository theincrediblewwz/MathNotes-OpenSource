package com.mathnotes.capture.pairing

import org.junit.Assert.assertEquals
import org.junit.Test

class LocalNetworkPermissionStateTest {
    @Test
    fun `permission becomes mandatory only at Android 17 target runtime`() {
        assertEquals(LocalNetworkPermissionState.NOT_REQUIRED, LocalNetworkPermissionState.resolve(36, false))
        assertEquals(LocalNetworkPermissionState.REQUIRED_NOT_GRANTED, LocalNetworkPermissionState.resolve(37, false))
        assertEquals(LocalNetworkPermissionState.GRANTED, LocalNetworkPermissionState.resolve(37, true))
    }
}
