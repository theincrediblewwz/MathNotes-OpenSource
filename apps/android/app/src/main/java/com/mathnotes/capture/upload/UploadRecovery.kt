package com.mathnotes.capture.upload

import com.mathnotes.capture.storage.CaptureRepository

class UploadRecovery(
    private val repository: CaptureRepository,
    private val scheduler: UploadScheduler
) {
    suspend fun enqueueOutstanding(): Int {
        return recoverQueuedUploads(scheduler.applicationContext, repository, scheduler) ?: run {
            NetworkRecoveryWorker.enqueue(scheduler.applicationContext)
            0
        }
    }
}
