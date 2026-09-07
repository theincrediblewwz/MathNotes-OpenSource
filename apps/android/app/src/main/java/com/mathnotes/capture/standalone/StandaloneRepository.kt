package com.mathnotes.capture.standalone

import android.content.Context
import android.net.Uri
import androidx.room.withTransaction
import java.io.File
import java.util.UUID

class StandaloneRepository(
    private val context: Context,
    private val database: StandaloneDatabase = StandaloneDatabase.get(context)
) {
    private val dao = database.dao()

    val notebooks = dao.observeNotebooks()
    val sessions = dao.observeSessions()
    val allBlocks = dao.observeAllBlocks()
    val allTasks = dao.observeAllTasks()
    fun blocks(sessionId: String) = dao.observeBlocks(sessionId)
    fun tasks(sessionId: String) = dao.observeTasks(sessionId)

    suspend fun createNotebook(title: String = "本机笔记"): StandaloneNotebookEntity {
        val now = System.currentTimeMillis()
        val notebook = StandaloneNotebookEntity(
            id = UUID.randomUUID().toString(),
            title = title.trim().ifBlank { "本机笔记" },
            createdAt = now,
            updatedAt = now
        )
        dao.insertNotebook(notebook)
        return notebook
    }

    suspend fun createSession(
        notebookId: String,
        title: String = "未命名 Session"
    ): StandaloneSessionEntity {
        requireNotNull(dao.findNotebook(notebookId)) { "Notebook 已不存在" }
        val now = System.currentTimeMillis()
        val session = StandaloneSessionEntity(
            id = UUID.randomUUID().toString(),
            notebookId = notebookId,
            title = title.trim().ifBlank { "未命名 Session" },
            createdAt = now,
            updatedAt = now
        )
        database.withTransaction {
            dao.insertSession(session)
            dao.touchNotebook(notebookId, now)
        }
        return session
    }

    suspend fun ensureCaptureSession(): StandaloneSessionEntity {
        dao.findLatestSession()?.let { return it }
        val notebook = dao.findLatestNotebook() ?: createNotebook("本机笔记")
        return createSession(notebook.id, "本机拍摄")
    }

    suspend fun renameNotebook(notebookId: String, title: String): Boolean {
        val normalized = title.trim()
        require(normalized.isNotBlank()) { "Notebook 名称不能为空" }
        return dao.renameNotebook(notebookId, normalized, System.currentTimeMillis()) == 1
    }

    suspend fun renameSession(sessionId: String, title: String): Boolean {
        val normalized = title.trim()
        require(normalized.isNotBlank()) { "Session 名称不能为空" }
        val session = dao.findSession(sessionId) ?: return false
        val now = System.currentTimeMillis()
        val renamed = dao.renameSession(sessionId, normalized, now) == 1
        if (renamed) dao.touchNotebook(session.notebookId, now)
        return renamed
    }

    suspend fun exportNotebookMarkdown(notebookId: String, target: Uri): Int {
        val notebook = requireNotNull(dao.findNotebook(notebookId)) { "Notebook 已不存在" }
        val sessions = dao.findSessionsForNotebook(notebookId)
        val blocksBySession = sessions.associate { session -> session.id to dao.findBlocksForSession(session.id) }
        val parts = standaloneNotebookExportParts(notebook, sessions, blocksBySession)
        context.contentResolver.openOutputStream(target, "wt").use { output ->
            requireNotNull(output) { "无法打开导出位置" }
            parts.forEach { part ->
                val images = part.sessionId?.let { sessionId ->
                    standaloneReaderImages(context, sessionId, blocksBySession[sessionId].orEmpty(), dao.findTasksForSession(sessionId))
                }.orEmpty()
                writeStandalonePortableMarkdown(output, part.markdown, images)
            }
        }
        return sessions.size
    }

    suspend fun exportSessionMarkdown(sessionId: String, target: Uri) {
        val session = requireNotNull(dao.findSession(sessionId)) { "Session 已不存在" }
        val blocks = dao.findBlocksForSession(sessionId)
        val markdown = buildStandaloneSessionExportMarkdown(session, blocks)
        val images = standaloneReaderImages(context, sessionId, blocks, dao.findTasksForSession(sessionId))
        context.contentResolver.openOutputStream(target, "wt").use { output ->
            requireNotNull(output) { "无法打开导出位置" }
            writeStandalonePortableMarkdown(output, markdown, images)
        }
    }

    suspend fun deleteSession(sessionId: String): Boolean {
        val session = dao.findSession(sessionId) ?: return false
        val tasks = dao.findTasksForSession(sessionId)
        require(tasks.none { it.status == StandaloneTaskStatus.CLAIMED }) { "Session 中仍有正在识别的任务" }
        val stagedFiles = stageManagedFiles(dao.findBlocksForSession(sessionId)) ?: return false
        return try {
            database.withTransaction {
                dao.deleteTasksForSession(sessionId)
                dao.deleteBlocksForSession(sessionId)
                check(dao.deleteSessionById(sessionId) == 1) { "Session 已经变化" }
                dao.touchNotebook(session.notebookId, System.currentTimeMillis())
            }
            stagedFiles.forEach { it.staged.delete() }
            true
        } catch (error: Throwable) {
            restoreManagedFiles(stagedFiles)
            throw error
        }
    }

    suspend fun deleteNotebook(notebookId: String): Boolean {
        if (dao.findNotebook(notebookId) == null) return false
        val sessions = dao.findSessionsForNotebook(notebookId)
        val tasks = sessions.flatMap { dao.findTasksForSession(it.id) }
        require(tasks.none { it.status == StandaloneTaskStatus.CLAIMED }) { "Notebook 中仍有正在识别的任务" }
        val blocks = sessions.flatMap { dao.findBlocksForSession(it.id) }
        val stagedFiles = stageManagedFiles(blocks) ?: return false
        return try {
            database.withTransaction {
                sessions.forEach { session ->
                    dao.deleteTasksForSession(session.id)
                    dao.deleteBlocksForSession(session.id)
                    dao.deleteSessionById(session.id)
                }
                check(dao.deleteNotebookById(notebookId) == 1) { "Notebook 已经变化" }
            }
            stagedFiles.forEach { it.staged.delete() }
            true
        } catch (error: Throwable) {
            restoreManagedFiles(stagedFiles)
            throw error
        }
    }

    suspend fun importImage(
        sessionId: String,
        source: Uri,
        provider: StandaloneProviderProfile? = null
    ): StandaloneRecognitionTaskEntity {
        val assetId = UUID.randomUUID().toString()
        val directory = File(context.filesDir, "standalone/assets/$sessionId").apply { mkdirs() }
        val target = File(directory, "$assetId.jpg")
        context.contentResolver.openInputStream(source).use { input ->
            requireNotNull(input) { "无法读取所选图片" }
            target.outputStream().use(input::copyTo)
        }
        return try {
            require(target.length() > 0L) { "所选图片为空" }
            persistImportedImage(sessionId, target, provider)
        } catch (error: Throwable) {
            target.delete()
            throw error
        }
    }

    suspend fun importCapturedFile(
        sessionId: String,
        source: File,
        provider: StandaloneProviderProfile? = null
    ): StandaloneRecognitionTaskEntity {
        require(source.isFile && source.length() > 0L) { "拍摄图片不存在或为空" }
        val assetId = UUID.randomUUID().toString()
        val extension = source.extension.lowercase().takeIf { it in setOf("jpg", "jpeg", "png", "webp") } ?: "jpg"
        val directory = File(context.filesDir, "standalone/assets/$sessionId").apply { mkdirs() }
        val target = File(directory, "$assetId.$extension")
        return try {
            source.inputStream().use { input -> target.outputStream().use(input::copyTo) }
            require(target.length() == source.length()) { "拍摄图片保存不完整" }
            persistImportedImage(sessionId, target, provider, assetId)
        } catch (error: Throwable) {
            target.delete()
            throw error
        }
    }

    private suspend fun persistImportedImage(
        sessionId: String,
        target: File,
        provider: StandaloneProviderProfile?,
        assetId: String = target.nameWithoutExtension,
        now: Long = System.currentTimeMillis()
    ): StandaloneRecognitionTaskEntity {
        val taskId = UUID.randomUUID().toString()
        val configured = provider?.takeIf { it.enabled && it.hasSecret }
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
            providerId = configured?.providerId ?: "unconfigured",
            destination = configured?.destination ?: "",
            model = configured?.model ?: "",
            status = if (configured == null) StandaloneTaskStatus.NEEDS_CONFIGURATION else StandaloneTaskStatus.AWAITING_CONFIRMATION,
            createdAt = now,
            updatedAt = now
        )
        database.withTransaction {
            dao.insertBlock(asset)
            dao.insertTask(task)
            dao.touchSession(sessionId, now)
            dao.findSession(sessionId)?.let { dao.touchNotebook(it.notebookId, now) }
        }
        return task
    }

    suspend fun findTask(taskId: String) = dao.findTask(taskId)
    suspend fun findBlock(blockId: String) = dao.findBlock(blockId)

    suspend fun claimAfterUserConfirmation(taskId: String): StandaloneRecognitionTaskEntity? {
        val claimed = dao.claimAfterUserConfirmation(taskId, System.currentTimeMillis())
        return if (claimed == 1) dao.findTask(taskId) else null
    }

    suspend fun configureWaitingTask(taskId: String, provider: StandaloneProviderProfile): Boolean {
        require(provider.enabled && provider.hasSecret) { "请先在设置中保存本机识别模型" }
        return dao.configureWaitingTask(
            taskId,
            provider.providerId,
            provider.destination,
            provider.model,
            System.currentTimeMillis()
        ) == 1
    }

    suspend fun deleteImage(blockId: String): Boolean {
        val block = dao.findBlock(blockId) ?: return false
        if (block.kind != StandaloneBlockKind.IMAGE) return false
        val tasks = dao.findTasksForAsset(blockId)
        if (tasks.any { it.status == StandaloneTaskStatus.CLAIMED }) return false
        val file = File(block.localPath)
        val staged = if (file.exists()) File(file.parentFile, ".${file.name}.${UUID.randomUUID()}.deleting") else null
        if (staged != null && !file.renameTo(staged)) return false
        return try {
            database.withTransaction {
                dao.deleteResultBlocksForAsset(blockId)
                dao.deleteTasksForAsset(blockId)
                check(dao.deleteImageBlock(blockId) == 1) { "照片历史已经变化" }
                val now = System.currentTimeMillis()
                dao.touchSession(block.sessionId, now)
                dao.findSession(block.sessionId)?.let { dao.touchNotebook(it.notebookId, now) }
            }
            staged?.delete()
            true
        } catch (error: Throwable) {
            if (staged != null && staged.exists()) staged.renameTo(file)
            throw error
        }
    }

    suspend fun completeFakeRecognition(task: StandaloneRecognitionTaskEntity) {
        val asset = dao.findBlock(task.assetBlockId) ?: error("识别素材已不存在")
        completeRecognition(task, "# 识别草稿\n\n[本地假识别] 已读取 ${File(asset.localPath).name}。\n\n此草稿用于验证手机独立任务闭环，不曾调用付费 Provider。")
    }

    suspend fun completeRecognition(task: StandaloneRecognitionTaskEntity, markdown: String, actualImage: File? = null) {
        require(markdown.isNotBlank()) { "识别草稿不能为空" }
        val now = System.currentTimeMillis()
        val resultId = UUID.randomUUID().toString()
        val storedTask = dao.findTask(task.id)
        val asset = dao.findBlock(task.assetBlockId).takeIf {
            storedTask?.assetBlockId == task.assetBlockId && storedTask.sessionId == task.sessionId
        }
        val trustedFile = asset?.let { trustedStandaloneSourceFile(context, task.sessionId, it) }
        val trustedLink = if (actualImage != null && trustedFile != null && runCatching { actualImage.canonicalFile == trustedFile }.getOrDefault(false)) {
            recognitionSourceImageLink(task.id, task.assetBlockId)
        } else null
        val draft = StandaloneBlockEntity(
            id = resultId,
            sessionId = task.sessionId,
            kind = StandaloneBlockKind.MARKDOWN_DRAFT,
            localPath = "",
            markdown = resolveRecognitionSourceImage(markdown, trustedLink),
            locked = false,
            createdAt = now,
            updatedAt = now
        )
        database.withTransaction {
            dao.insertBlock(draft)
            check(dao.markSucceeded(task.id, resultId, now) == 1) { "识别任务状态已经变化" }
            dao.touchSession(task.sessionId, now)
            dao.findSession(task.sessionId)?.let { dao.touchNotebook(it.notebookId, now) }
        }
    }

    suspend fun markPossiblyCharged(taskId: String, message: String) {
        dao.markClaimFailure(taskId, StandaloneTaskStatus.POSSIBLY_CHARGED, message, System.currentTimeMillis())
    }

    suspend fun markFailed(taskId: String, message: String) {
        dao.markClaimFailure(taskId, StandaloneTaskStatus.FAILED, message, System.currentTimeMillis())
    }

    suspend fun recoverInterruptedClaims(): Int = dao.recoverInterruptedClaims(System.currentTimeMillis())

    private data class StagedManagedFile(val original: File, val staged: File)

    private fun stageManagedFiles(blocks: List<StandaloneBlockEntity>): List<StagedManagedFile>? {
        val staged = mutableListOf<StagedManagedFile>()
        for (block in blocks) {
            if (block.kind != StandaloneBlockKind.IMAGE || block.localPath.isBlank()) continue
            val original = File(block.localPath)
            if (!original.exists()) continue
            val stagedFile = File(original.parentFile, ".${original.name}.${UUID.randomUUID()}.deleting")
            if (!original.renameTo(stagedFile)) {
                restoreManagedFiles(staged)
                return null
            }
            staged += StagedManagedFile(original, stagedFile)
        }
        return staged
    }

    private fun restoreManagedFiles(files: List<StagedManagedFile>) {
        files.asReversed().forEach { item ->
            if (item.staged.exists()) item.staged.renameTo(item.original)
        }
    }
}
