package com.mathnotes.capture.notification

enum class NotificationPermissionAction {
    NONE,
    REQUEST,
    OPEN_SETTINGS
}

data class NotificationPermissionState(
    val title: String,
    val detail: String,
    val action: NotificationPermissionAction,
    val actionLabel: String? = null
)

fun resolveNotificationPermissionState(
    sdkInt: Int,
    granted: Boolean,
    requestedBefore: Boolean,
    shouldShowRationale: Boolean
): NotificationPermissionState = when {
    sdkInt < 33 -> NotificationPermissionState(
        title = "系统已支持上传通知",
        detail = "此 Android 版本不需要单独授权。",
        action = NotificationPermissionAction.NONE
    )
    granted -> NotificationPermissionState(
        title = "上传通知已开启",
        detail = "发送照片时会显示进度和暂停入口。",
        action = NotificationPermissionAction.NONE
    )
    !requestedBefore || shouldShowRationale -> NotificationPermissionState(
        title = "上传通知未开启",
        detail = "上传仍会继续；开启后可在通知栏查看进度并暂停。",
        action = NotificationPermissionAction.REQUEST,
        actionLabel = "开启通知"
    )
    else -> NotificationPermissionState(
        title = "上传通知已被关闭",
        detail = "上传仍会继续；可在系统设置中重新开启通知。",
        action = NotificationPermissionAction.OPEN_SETTINGS,
        actionLabel = "前往系统设置"
    )
}
