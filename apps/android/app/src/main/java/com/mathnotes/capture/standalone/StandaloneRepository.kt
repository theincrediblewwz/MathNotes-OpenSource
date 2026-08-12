package com.mathnotes.capture.standalone

import android.content.Context
import android.net.Uri
import androidx.room.withTransaction
import java.io.File
import java.util.UUID

class StandaloneRepository(private val context: Context) {
    private val database = StandaloneDatabase.get(context)
    private val dao = database.dao()

    val sessions = dao.observeSessions()
    fun blocks(sessionId: String) = dao.observeBlocks(sessionId)
    fun tasks(sessionId: String) = dao.observeTasks(sessionId)

    suspend fun createSession(title: String = "手机独立笔记"): StandaloneSessionEntity {
        val now = System.currentTimeMillis()
        val session = StandaloneSessionEntity(
            id = UUID.randomUUID().toString(),
            notebookId = "standalone-local",
            title = title.trim().ifBlank { "手机独立笔记" },
            createdAt = now,
            updatedAt = now
        )
        dao.insertSession(session)
        return session
    }

    suspend fun importImage(
        sessionId: String,
        source: Uri,
        provider: StandaloneProviderProfile? = null
    ): StandaloneRecognitionTaskEntity {
        val now = System.currentTimeMillis()
        val assetId = UUID.randomUUID().toString()
        val taskId = UUID.randomUUID().toString()
        val directory = File(context.filesDir, "standalone/assets/$sessionId").apply { mkdirs() }
        val target = File(directory, "$assetId.jpg")
        context.contentResolver.openInputStream(source).use { input ->
            requireNotNull(input) { "无法读取所选图片" }
            target.outputStream().use(input::copyTo)
        }
        require(target.length() > 0L) { "所选图片为空" }
        val asset = StandaloneBlockEntity(
            id = assetId,
            sessionId = sessionId,
            kind = StandaloneBlockKind.IMAGE,
            localPath = target.absolutePath,
            markdown = "",
            locked = false,
            createdAt = now,
            updatedAt = now
        )
        val task = StandaloneRecognitionTaskEntity(
            id = taskId,
            sessionId = sessionId,
            assetBlockId = assetId,
            providerId = provider?.takeIf { it.enabled }?.providerId ?: "local-fake",
            destination = provider?.takeIf { it.enabled }?.destination ?: "local://fake-recognition",
            model = provider?.takeIf { it.enabled }?.model ?: "faithful-transcription-fixture-v1",
            status = StandaloneTaskStatus.AWAITING_CONFIRMATION,
            createdAt = now,
            updatedAt = now
        )
        database.withTransaction {
            dao.insertBlock(asset)
            dao.insertTask(task)
            dao.touchSession(sessionId, now)
        }
        return task
    }

    suspend fun findTask(taskId: String) = dao.findTask(taskId)
    suspend fun findBlock(blockId: String) = dao.findBlock(blockId)

    suspend fun claimAfterUserConfirmation(taskId: String): StandaloneRecognitionTaskEntity? {
        val claimed = dao.claimAfterUserConfirmation(taskId, System.currentTimeMillis())
        return if (claimed == 1) dao.findTask(taskId) else null
    }

    suspend fun completeFakeRecognition(task: StandaloneRecognitionTaskEntity) {
        val asset = dao.findBlock(task.assetBlockId) ?: error("识别素材已不存在")
        completeRecognition(task, "# 识别草稿\n\n[本地假识别] 已读取 ${File(asset.localPath).name}。\n\n此草稿用于验证手机独立任务闭环，不曾调用付费 Provider。")
    }

    suspend fun completeRecognition(task: StandaloneRecognitionTaskEntity, markdown: String) {
        require(markdown.isNotBlank()) { "识别草稿不能为空" }
        val now = System.currentTimeMillis()
        val resultId = UUID.randomUUID().toString()
        val draft = StandaloneBlockEntity(
            id = resultId,
            sessionId = task.sessionId,
            kind = StandaloneBlockKind.MARKDOWN_DRAFT,
            localPath = "",
            markdown = markdown,
            locked = false,
            createdAt = now,
            updatedAt = now
        )
        database.withTransaction {
            dao.insertBlock(draft)
            check(dao.markSucceeded(task.id, resultId, now) == 1) { "识别任务状态已经变化" }
            dao.touchSession(task.sessionId, now)
        }
    }

    suspend fun markPossiblyCharged(taskId: String, message: String) {
        dao.markClaimFailure(taskId, StandaloneTaskStatus.POSSIBLY_CHARGED, message, System.currentTimeMillis())
    }

    suspend fun markFailed(taskId: String, message: String) {
        dao.markClaimFailure(taskId, StandaloneTaskStatus.FAILED, message, System.currentTimeMillis())
    }

    suspend fun recoverInterruptedClaims(): Int = dao.recoverInterruptedClaims(System.currentTimeMillis())
}
