package com.mathnotes.capture.notification

import org.junit.Assert.assertEquals
import org.junit.Test

class NotificationPermissionStateTest {
    @Test
    fun olderAndroidNeedsNoRuntimePermission() {
        val state = resolveNotificationPermissionState(32, false, false, false)
        assertEquals(NotificationPermissionAction.NONE, state.action)
    }

    @Test
    fun grantedPermissionNeedsNoAction() {
        val state = resolveNotificationPermissionState(35, true, true, false)
        assertEquals(NotificationPermissionAction.NONE, state.action)
        assertEquals("上传通知已开启", state.title)
    }

    @Test
    fun firstUseRequestsPermissionContextually() {
        val state = resolveNotificationPermissionState(35, false, false, false)
        assertEquals(NotificationPermissionAction.REQUEST, state.action)
        assertEquals("开启通知", state.actionLabel)
    }

    @Test
    fun rationaleAllowsAnotherRequest() {
        val state = resolveNotificationPermissionState(35, false, true, true)
        assertEquals(NotificationPermissionAction.REQUEST, state.action)
    }

    @Test
    fun permanentlyDeniedPermissionOpensSystemSettings() {
        val state = resolveNotificationPermissionState(35, false, true, false)
        assertEquals(NotificationPermissionAction.OPEN_SETTINGS, state.action)
        assertEquals("前往系统设置", state.actionLabel)
    }
}
