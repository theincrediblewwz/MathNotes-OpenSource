package com.mathnotes.capture.standalone

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import androidx.work.Constraints
import androidx.work.NetworkType
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext

class StandaloneRecognitionWorker(appContext: Context, params: WorkerParameters) :
    CoroutineWorker(appContext, params) {
    private val repository = StandaloneRepository(appContext)
    private val profileStore = StandaloneProviderProfileStore(appContext)

    override suspend fun doWork(): Result {
        val taskId = inputData.getString(TASK_ID) ?: return Result.failure()
        val task = repository.claimAfterUserConfirmation(taskId) ?: return Result.success()
        return try {
            if (task.providerId == "local-fake") {
                repository.completeFakeRecognition(task)
                Result.success()
            } else {
                val profile = profileStore.load()
                    ?: throw KnownProviderFailure("Provider 配置不存在，请重新保存")
                if (!profile.enabled || profile.providerId != task.providerId || profile.destination != task.destination || profile.model != task.model) {
                    throw KnownProviderFailure("Provider 配置已变化；旧任务不会自动改用新目标")
                }
                val asset = repository.findBlock(task.assetBlockId)
                    ?: throw KnownProviderFailure("识别图片已不存在")
                val markdown = OpenAiCompatibleStandaloneTransport().transcribe(
                    task,
                    java.io.File(asset.localPath),
                    profileStore.secret(profile)
                )
                repository.completeRecognition(task, markdown)
                Result.success()
            }
        } catch (cancelled: CancellationException) {
            withContext(NonCancellable) {
                repository.markPossiblyCharged(taskId, "识别在完成前中断；为避免重复计费，必须人工决定是否重试")
            }
            throw cancelled
        } catch (known: KnownProviderFailure) {
            repository.markFailed(taskId, known.message ?: "Provider 请求失败")
            Result.failure()
        } catch (error: Throwable) {
            if (task.providerId == "local-fake") repository.markFailed(taskId, error.message ?: "本地识别失败")
            else repository.markPossiblyCharged(taskId, "Provider 结果未知；为避免重复计费，必须人工决定是否重试")
            Result.failure()
        }
    }

    companion object {
        const val TASK_ID = "standalone_task_id"
    }
}

class StandaloneRecognitionScheduler(context: Context) {
    private val workManager = WorkManager.getInstance(context.applicationContext)

    fun enqueueAfterUserConfirmation(taskId: String, requiresNetwork: Boolean) {
        val builder = OneTimeWorkRequestBuilder<StandaloneRecognitionWorker>()
            .setInputData(workDataOf(StandaloneRecognitionWorker.TASK_ID to taskId))
        if (requiresNetwork) builder.setConstraints(
            Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        )
        val request = builder.build()
        workManager.enqueueUniqueWork("standalone-recognition-$taskId", ExistingWorkPolicy.KEEP, request)
    }
}
