package com.mathnotes.capture

import org.junit.Assert.assertEquals
import org.junit.Test

class SystemCameraContractTest {
    @Test
    fun fileProviderAuthorityMatchesManifestContract() {
        assertEquals(
            "com.mathnotes.capture.files",
            systemCameraAuthority("com.mathnotes.capture")
        )
    }
}
