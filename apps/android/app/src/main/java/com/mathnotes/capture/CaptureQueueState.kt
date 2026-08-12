package com.mathnotes.capture

enum class CaptureQueueState {
    READY,
    PENDING,
    UPLOADING,
    UPLOADED,
    RETRYABLE,
    BLOCKED_AUTH,
    FAILED_PERMANENT
}

fun CaptureQueueState.statusLabel(): String = when (this) {
    CaptureQueueState.READY -> "等待拍照"
    CaptureQueueState.PENDING -> "等待上传"
    CaptureQueueState.UPLOADING -> "正在上传"
    CaptureQueueState.UPLOADED -> "已发送到电脑"
    CaptureQueueState.RETRYABLE -> "等待重试"
    CaptureQueueState.BLOCKED_AUTH -> "需要重新配对"
    CaptureQueueState.FAILED_PERMANENT -> "无法上传"
}
