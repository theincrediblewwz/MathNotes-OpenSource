package com.mathnotes.capture.upload

import com.mathnotes.capture.storage.CaptureRepository
import com.mathnotes.capture.storage.CaptureState

class UploadRecovery(
    private val repository: CaptureRepository,
    private val scheduler: UploadScheduler
) {
    suspend fun enqueueOutstanding(): Int {
        val outstanding = repository.recoverable().filter {
            it.attemptCount < UploadPolicy.MAX_AUTOMATIC_ATTEMPTS
        }
        val now = System.currentTimeMillis()
        outstanding.forEach { capture ->
            if (capture.state == CaptureState.UPLOADING) {
                repository.markFailure(
                    capture.captureId,
                    CaptureState.RETRYABLE,
                    capture.lastHttpStatus,
                    "上次上传被中断，正在恢复",
                    null
                )
            }
            scheduler.enqueue(
                capture.captureId,
                initialDelayMillis = maxOf(0L, (capture.nextAttemptAt ?: now) - now)
            )
        }
        return outstanding.size
    }
}
