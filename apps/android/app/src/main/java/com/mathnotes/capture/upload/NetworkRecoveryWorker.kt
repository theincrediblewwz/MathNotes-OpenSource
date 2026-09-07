package com.mathnotes.capture.upload

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.mathnotes.capture.pairing.PairingStore
import com.mathnotes.capture.storage.CaptureRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.TimeUnit

class NetworkRecoveryWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = try {
        if (recoverQueuedUploads(applicationContext) == null) Result.retry() else Result.success()
    } catch (cancelled: CancellationException) { throw cancelled }
    catch (error: Exception) {
        Log.w("MathNotesUpload", "Queue recovery will retry", error)
        Result.retry()
    }

    companion object {
        const val WORK_NAME = "mathnotes-upload-network-recovery"
        fun enqueue(context: Context, networkEvent: Boolean = false) = WorkManager.getInstance(context).enqueueUniqueWork(
            WORK_NAME, if (networkEvent) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP, OneTimeWorkRequestBuilder<NetworkRecoveryWorker>()
                .setBackoffCriteria(BackoffPolicy.LINEAR, 15, TimeUnit.SECONDS).build())
    }
}

internal suspend fun recoverQueuedUploads(
    context: Context,
    repository: CaptureRepository = CaptureRepository(context),
    scheduler: UploadScheduler = UploadScheduler(context),
    budgetMillis: Long = 30_000
): Int? = withTimeoutOrNull(budgetMillis) {
    UploadQueueLock.mutex.withLock {
        val pairing = PairingStore(context)
        val manager = WorkManager.getInstance(context)
        var count = 0
        var eligible = false
        val online = hasConnectedUploadNetwork(context)
        for (candidate in repository.recoverable()) {
            val capture = repository.find(candidate.captureId) ?: continue
            if (!isAutomaticUploadState(capture.state) || capture.attemptCount >= UploadPolicy.MAX_AUTOMATIC_ATTEMPTS) continue
            if (pairing.findForCapture(capture.pairingProfileId, capture.endpointId) == null) continue
            eligible = true
            val work = withContext(Dispatchers.IO) {
                manager.getWorkInfosForUniqueWork(UploadScheduler.workName(capture.captureId)).get(10, TimeUnit.SECONDS)
            }
            if (work.any { it.state == WorkInfo.State.RUNNING }) continue
            // Any ENQUEUED->RUNNING race now waits on our lock: no attempt, FGS or POST has begun.
            val delay = maxOf(0L, (capture.nextAttemptAt ?: 0L) - System.currentTimeMillis())
            withContext(Dispatchers.IO) {
                scheduler.enqueue(capture.captureId, replace = online, initialDelayMillis = delay).result.get(10, TimeUnit.SECONDS)
            }
            count++
        }
        if (eligible && !online) {
            if (!OfflineNetworkWake.arm(context)) return@withTimeoutOrNull null
        }
        else OfflineNetworkWake.disarm(context)
        count
    }
}
