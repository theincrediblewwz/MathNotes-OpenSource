package com.mathnotes.capture.pairing

enum class LocalNetworkPermissionState {
    NOT_REQUIRED,
    REQUIRED_NOT_GRANTED,
    GRANTED;

    companion object {
        fun resolve(sdkInt: Int, granted: Boolean): LocalNetworkPermissionState = when {
            sdkInt < 37 -> NOT_REQUIRED
            granted -> GRANTED
            else -> REQUIRED_NOT_GRANTED
        }
    }
}
