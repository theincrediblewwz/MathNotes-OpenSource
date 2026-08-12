package com.mathnotes.capture.upload

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.Operation
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

class UploadScheduler(context: Context) {
    private val workManager = WorkManager.getInstance(context.applicationContext)

    fun enqueue(captureId: String, replace: Boolean = false, initialDelayMillis: Long = 0): Operation {
        val requestBuilder = OneTimeWorkRequestBuilder<UploadWorker>()
            .setInputData(Data.Builder().putString(UploadWorker.CAPTURE_ID, captureId).build())
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build()
            )
            .setBackoffCriteria(
                BackoffPolicy.EXPONENTIAL,
                UploadPolicy.INITIAL_BACKOFF_MILLIS,
                TimeUnit.MILLISECONDS
            )
            .addTag(UPLOAD_TAG)
        if (initialDelayMillis > 0) {
            requestBuilder.setInitialDelay(initialDelayMillis, TimeUnit.MILLISECONDS)
        }
        val request = requestBuilder.build()
        return workManager.enqueueUniqueWork(
            workName(captureId),
            if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP,
            request
        )
    }

    fun cancel(captureId: String): Operation {
        return workManager.cancelUniqueWork(workName(captureId))
    }

    companion object {
        const val UPLOAD_TAG = "mathnotes-photo-upload"
        fun workName(captureId: String): String = "mathnotes-upload-$captureId"
    }
}
