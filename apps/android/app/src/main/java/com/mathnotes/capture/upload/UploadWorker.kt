package com.mathnotes.capture.upload

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.pm.ServiceInfo
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.pairing.PairingStore
import com.mathnotes.capture.storage.CaptureRepository
import com.mathnotes.capture.storage.CaptureState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File

class UploadWorker internal constructor(
    appContext: Context,
    params: WorkerParameters,
    private val runtime: UploadRuntime
) : CoroutineWorker(appContext, params) {
    constructor(appContext: Context, params: WorkerParameters) : this(appContext, params, UploadRuntime())

    private val repository = CaptureRepository(appContext)

    override suspend fun doWork(): Result {
        val startedAt = runtime.elapsedRealtime()
        val captureId = inputData.getString(CAPTURE_ID) ?: return Result.failure()
        var locked = false
        return try {
            val acquired = withTimeoutOrNull(runtime.backgroundBudgetMillis) {
                UploadQueueLock.mutex.lock()
                locked = true
                true
            } ?: false
            if (!acquired) return Result.retry()
            uploadLocked(captureId, startedAt)
        } finally {
            if (locked) UploadQueueLock.mutex.unlock()
        }
    }

    private suspend fun uploadLocked(captureId: String, startedAt: Long): Result {
        // Recovery and upload share this lock; waiting workers reread every decision here.
        val queued = repository.find(captureId) ?: return Result.success()
        if (!isAutomaticUploadState(queued.state)) return Result.success()
        if (queued.attemptCount >= UploadPolicy.MAX_AUTOMATIC_ATTEMPTS) {
            repository.markFailure(
                captureId,
                CaptureState.RETRYABLE,
                queued.lastHttpStatus,
                queued.lastError ?: "自动重试已暂停，请手动重试",
                null
            )
            return Result.failure()
        }

        val pairingStore = PairingStore(applicationContext)
        val pairing = pairingStore.findForCapture(queued.pairingProfileId, queued.endpointId)
        if (pairing == null) {
            repository.markFailure(
                captureId,
                CaptureState.BLOCKED_AUTH,
                null,
                "目标电脑已变化，请重新配对后重试",
                null
            )
            return Result.failure()
        }

        // An offline scheduling wake-up is not an upload attempt and must not exhaust the queue.
        if ((queued.nextAttemptAt ?: 0L) > System.currentTimeMillis()) return Result.retry()
        if (!runtime.hasConnectedNetwork(applicationContext)) {
            runtime.armOfflineWake(applicationContext)
            return Result.retry()
        }
            var attemptStarted = false
            return try {
                setProgress(workDataOf(PROGRESS to 5))
                val foreground = tryUploadForeground { setForeground(createForegroundInfo(queued.localPath)) }
                val remaining = runtime.backgroundBudgetMillis - (runtime.elapsedRealtime() - startedAt)
                if (!foreground && remaining <= 0) return Result.retry()
                val active = repository.markAttemptStarted(captureId) ?: return Result.success()
                if (active.state != CaptureState.UPLOADING) return Result.success()
                attemptStarted = true
                val (outcome, resolvedPairing) = if (foreground) {
                    uploadWithBoundedFallback(active, pairingStore, pairing)
                } else {
                    // Cancellation reaches OkHttp Call.cancel() through its await implementation.
                    withTimeoutOrNull(remaining) { uploadWithBoundedFallback(active, pairingStore, pairing) }
                        ?: (UploadOutcome.Retryable(null, "本次后台上传超时，将稍后重试") to pairing)
                }
                when (outcome) {
                is UploadOutcome.Accepted -> {
                    pairingStore.save(resolvedPairing)
                    repository.markUploaded(
                        captureId,
                        outcome.httpStatus,
                        outcome.receipt.uploadId,
                        outcome.receipt.recognitionJobId
                    )
                    setProgress(workDataOf(PROGRESS to 100))
                    Result.success()
                }
                is UploadOutcome.Retryable -> handleRetryable(captureId, active.attemptCount, outcome)
                is UploadOutcome.BlockedAuth -> {
                    repository.markFailure(
                        captureId,
                        CaptureState.BLOCKED_AUTH,
                        outcome.httpStatus,
                        outcome.message,
                        null
                    )
                    Result.failure()
                }
                is UploadOutcome.PermanentFailure -> {
                    repository.markFailure(
                        captureId,
                        CaptureState.FAILED_PERMANENT,
                        outcome.httpStatus,
                        outcome.message,
                        null
                    )
                    Result.failure()
                }
                }
            } catch (cancelled: CancellationException) {
                if (attemptStarted) withContext(NonCancellable) { repository.markCancelled(captureId) }
                throw cancelled
            }
    }

    private suspend fun uploadWithBoundedFallback(
        capture: com.mathnotes.capture.storage.CaptureEntity,
        pairingStore: PairingStore,
        pairing: PairingConfig
    ): Pair<UploadOutcome, PairingConfig> {
        val candidates = pairingStore.endpointCandidates(pairing).take(MAX_ENDPOINT_CANDIDATES)
        var lastRetryable: UploadOutcome.Retryable? = null
        for (candidate in candidates) {
            when (val outcome = runtime.transport().upload(capture, candidate)) {
                is UploadOutcome.Retryable -> lastRetryable = outcome
                else -> return outcome to candidate
            }
        }
        return (lastRetryable ?: UploadOutcome.Retryable(null, "当前所有连接地址均不可达")) to pairing
    }

    private suspend fun handleRetryable(
        captureId: String,
        attempt: Int,
        outcome: UploadOutcome.Retryable
    ): Result {
        val automaticRetry = attempt < UploadPolicy.MAX_AUTOMATIC_ATTEMPTS
        val nextAttemptAt = if (automaticRetry) {
            System.currentTimeMillis() + UploadPolicy.backoffMillis(attempt)
        } else null
        val message = if (automaticRetry) outcome.message else "${outcome.message}；自动重试已暂停"
        repository.markFailure(
            captureId,
            CaptureState.RETRYABLE,
            outcome.httpStatus,
            message,
            nextAttemptAt
        )
        return if (automaticRetry) Result.retry() else Result.failure()
    }

    private fun createForegroundInfo(localPath: String): ForegroundInfo {
        val manager = applicationContext.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "素材上传", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val cancelIntent = UploadPauseReceiver.pendingIntent(applicationContext, inputData.getString(CAPTURE_ID).orEmpty())
        val fileName = File(localPath).name
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("正在发送素材到电脑")
            .setContentText(fileName)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setProgress(100, 0, true)
            .addAction(android.R.drawable.ic_delete, "暂停", cancelIntent)
            .build()
        return ForegroundInfo(
            NOTIFICATION_BASE + id.hashCode().ushr(1) % 10_000,
            notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        )
    }

    companion object {
        const val CAPTURE_ID = "capture_id"
        const val PROGRESS = "progress"
        private const val CHANNEL_ID = "mathnotes_uploads"
        private const val NOTIFICATION_BASE = 4_200
        private const val MAX_ENDPOINT_CANDIDATES = 6
    }
}

internal fun isAutomaticUploadState(state: String): Boolean = state == CaptureState.PENDING ||
    state == CaptureState.UPLOADING ||
    state == CaptureState.RETRYABLE
