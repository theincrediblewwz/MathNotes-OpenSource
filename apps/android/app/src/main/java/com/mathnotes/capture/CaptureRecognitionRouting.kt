package com.mathnotes.capture

import android.content.Context

internal enum class CaptureRecognitionDestination { WINDOWS_SESSION, ANDROID_LOCAL_DRAFT }

internal fun resolveCaptureRecognitionDestination(
    preferWindows: Boolean,
    windowsConnectionVerified: Boolean,
    hasWindowsTarget: Boolean
): CaptureRecognitionDestination =
    if (preferWindows && windowsConnectionVerified && hasWindowsTarget) {
        CaptureRecognitionDestination.WINDOWS_SESSION
    } else {
        CaptureRecognitionDestination.ANDROID_LOCAL_DRAFT
    }

internal class CaptureRoutingPreferences(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    fun preferWindows(): Boolean = preferences.getBoolean(PREFER_WINDOWS, true)

    fun setPreferWindows(value: Boolean): Boolean = preferences.edit().putBoolean(PREFER_WINDOWS, value).commit()

    private companion object {
        const val PREFERENCES = "mathnotes_capture_routing_v1"
        const val PREFER_WINDOWS = "prefer_windows_recognition"
    }
}
