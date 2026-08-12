package com.mathnotes.capture.storage

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.imageedit.AndroidImageTransformer
import com.mathnotes.capture.imageedit.ImageEditDraft
import com.mathnotes.capture.imageedit.ImageAnnotationObject
import com.mathnotes.capture.imageedit.NormalizedPoint
import com.mathnotes.capture.imageedit.NormalizedRect
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest
import java.util.UUID

class CaptureRepository(
    private val context: Context,
    private val dao: CaptureDao = MathNotesDatabase.get(context).captureDao()
) {
    val captures: Flow<List<CaptureEntity>> = dao.observeAll()

    fun createOutputFile(now: Long = System.currentTimeMillis()): File {
        val directory = File(context.filesDir, "captures").apply { mkdirs() }
        return File(directory, "IMG_${now}_${UUID.randomUUID()}.jpg")
    }

    suspend fun commitCapturedFile(file: File, pairing: PairingConfig, now: Long = System.currentTimeMillis()): CaptureEntity =
        withContext(Dispatchers.IO) {
            commitFile(
                file = file,
                pairing = pairing,
                mimeType = "image/jpeg",
                captureSource = CaptureSource.CAMERA,
                sourceName = file.name,
                materialType = MaterialType.IMAGE,
                now = now
            )
        }

    suspend fun importImage(uri: Uri, pairing: PairingConfig, now: Long = System.currentTimeMillis()): CaptureEntity =
        withContext(Dispatchers.IO) {
            val draft = stageImage(uri, now)
            try {
                commitFile(
                    file = draft.sourceFile,
                    pairing = pairing,
                    mimeType = draft.mimeType,
                    captureSource = draft.captureSource,
                    sourceName = draft.sourceName,
                    materialType = MaterialType.IMAGE,
                    now = now
                )
            } catch (error: Throwable) {
                draft.sourceFile.delete()
                throw error
            }
        }

    suspend fun stageImage(uri: Uri, now: Long = System.currentTimeMillis()): ImageEditDraft =
        withContext(Dispatchers.IO) {
            val resolver = context.contentResolver
            val mimeType = resolver.getType(uri).orEmpty().ifBlank { "image/jpeg" }
            require(mimeType.startsWith("image/")) { "Selected material is not an image" }
            val sourceName = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }.orEmpty().ifBlank { "selected-image" }
            val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType)
                ?: sourceName.substringAfterLast('.', "jpg")
            val directory = File(context.filesDir, "captures").apply { mkdirs() }
            val file = File(directory, "IMG_${now}_${UUID.randomUUID()}.$extension")
            try {
                resolver.openInputStream(uri)?.buffered()?.use { input ->
                    file.outputStream().buffered().use { output -> input.copyTo(output) }
                } ?: error("Unable to read selected image")
                ImageEditDraft(file, sourceName, mimeType, CaptureSource.GALLERY)
            } catch (error: Throwable) {
                file.delete()
                throw error
            }
        }

    suspend fun stageCapturedFile(file: File): ImageEditDraft = withContext(Dispatchers.IO) {
        require(file.isFile && file.length() > 0) { "Captured image is missing or empty" }
        ImageEditDraft(file, file.name, "image/jpeg", CaptureSource.CAMERA)
    }

    suspend fun commitImageDraft(
        draft: ImageEditDraft,
        pairing: PairingConfig,
        rotationQuarterTurns: Int,
        perspectiveCorners: List<NormalizedPoint>? = null,
        cropRect: NormalizedRect?,
        lassoPoints: List<NormalizedPoint>? = null,
        annotations: List<ImageAnnotationObject> = emptyList(),
        now: Long = System.currentTimeMillis()
    ): CaptureEntity = withContext(Dispatchers.IO) {
        val rendered = AndroidImageTransformer.render(
            draft = draft,
            outputDirectory = File(context.filesDir, "captures/derived"),
            rotationQuarterTurns = rotationQuarterTurns,
            perspectiveCorners = perspectiveCorners,
            cropRect = cropRect,
            lassoPoints = lassoPoints,
            annotations = annotations
        )
        try {
            commitFile(
                file = rendered.outputFile,
                pairing = pairing,
                mimeType = "image/png",
                captureSource = draft.captureSource,
                sourceName = draft.sourceName.substringBeforeLast('.', draft.sourceName) + ".png",
                materialType = MaterialType.IMAGE,
                now = now
            )
        } catch (error: Throwable) {
            rendered.outputFile.delete()
            rendered.sidecarFile.delete()
            throw error
        }
    }

    fun discardImageDraft(draft: ImageEditDraft) {
        draft.sourceFile.delete()
        draft.stageHistory.forEach { it.sourceFile.delete() }
        draft.cleanupFiles.forEach(File::delete)
    }

    suspend fun importPdf(uri: Uri, pairing: PairingConfig, now: Long = System.currentTimeMillis()): CaptureEntity =
        withContext(Dispatchers.IO) {
            val resolver = context.contentResolver
            val mimeType = resolver.getType(uri).orEmpty().ifBlank { "application/pdf" }
            require(mimeType == "application/pdf") { "Selected material is not a PDF" }
            val sourceName = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }.orEmpty().ifBlank { "document.pdf" }
            val directory = File(context.filesDir, "documents").apply { mkdirs() }
            val file = File(directory, "PDF_${now}_${UUID.randomUUID()}.pdf")
            try {
                resolver.openInputStream(uri)?.buffered()?.use { input ->
                    file.outputStream().buffered().use { output -> input.copyTo(output) }
                } ?: error("Unable to read selected PDF")
                commitFile(
                    file = file,
                    pairing = pairing,
                    mimeType = "application/pdf",
                    captureSource = CaptureSource.DOCUMENT_PICKER,
                    sourceName = sourceName,
                    materialType = MaterialType.PDF,
                    now = now
                )
            } catch (error: Throwable) {
                file.delete()
                throw error
            }
        }

    private suspend fun commitFile(
        file: File,
        pairing: PairingConfig,
        mimeType: String,
        captureSource: String,
        sourceName: String,
        materialType: String,
        now: Long
    ): CaptureEntity {
        require(file.isFile && file.length() > 0) { "Captured material is missing or empty" }
        val entity = CaptureEntity(
                captureId = UUID.randomUUID().toString(),
                deviceId = deviceId(),
                localPath = file.absolutePath,
                mimeType = mimeType,
                byteLength = file.length(),
                sha256 = sha256(file),
                notebookId = pairing.notebookId,
                sessionId = pairing.sessionId,
                endpointId = pairing.endpointId,
                state = CaptureState.PENDING,
                attemptCount = 0,
                nextAttemptAt = null,
                lastHttpStatus = null,
                lastError = null,
                remoteUploadId = null,
                remoteRecognitionJobId = null,
                createdAt = now,
                updatedAt = now,
                materialType = materialType,
                captureSource = captureSource,
                sourceName = sourceName,
                pairingProfileId = pairing.profileId.ifBlank { pairing.endpointId },
                computerLabel = pairing.computerLabel.ifBlank { pairing.host },
                targetTitle = pairing.targetTitle.ifBlank { pairing.sessionId }
            )
        dao.insert(entity)
        return entity
    }

    suspend fun deleteAcknowledged(capture: CaptureEntity): Boolean = withContext(Dispatchers.IO) {
        if (capture.state != CaptureState.UPLOADED) return@withContext false
        val file = File(capture.localPath)
        if (file.exists() && !file.delete()) return@withContext false
        dao.update(
            capture.copy(
                localCopyAvailable = false,
                updatedAt = System.currentTimeMillis()
            )
        )
        true
    }

    suspend fun clearUploadedHistory() = withContext(Dispatchers.IO) {
        dao.listUploaded().forEach { capture ->
            if (capture.localCopyAvailable) File(capture.localPath).delete()
        }
        dao.deleteUploaded()
    }

    suspend fun clearRecentUploaded(): Int = withContext(Dispatchers.IO) {
        dao.hideUploadedFromRecent()
    }

    suspend fun find(captureId: String): CaptureEntity? = withContext(Dispatchers.IO) {
        dao.find(captureId)
    }

    suspend fun recoverable(): List<CaptureEntity> = withContext(Dispatchers.IO) {
        dao.findRecoverable()
    }

    suspend fun markAttemptStarted(captureId: String, now: Long = System.currentTimeMillis()): CaptureEntity? =
        update(captureId) { capture ->
            capture.copy(
                state = CaptureState.UPLOADING,
                attemptCount = capture.attemptCount + 1,
                nextAttemptAt = null,
                lastError = null,
                updatedAt = now
            )
        }

    suspend fun markUploaded(
        captureId: String,
        httpStatus: Int,
        uploadId: String,
        recognitionJobId: String?,
        now: Long = System.currentTimeMillis()
    ) {
        update(captureId) { capture ->
            capture.copy(
                state = CaptureState.UPLOADED,
                nextAttemptAt = null,
                lastHttpStatus = httpStatus,
                lastError = null,
                remoteUploadId = uploadId,
                remoteRecognitionJobId = recognitionJobId,
                completedAt = now,
                hiddenFromRecent = false,
                updatedAt = now
            )
        }
    }

    suspend fun markFailure(
        captureId: String,
        state: String,
        httpStatus: Int?,
        message: String,
        nextAttemptAt: Long?,
        now: Long = System.currentTimeMillis()
    ) {
        update(captureId) { capture ->
            capture.copy(
                state = state,
                nextAttemptAt = nextAttemptAt,
                lastHttpStatus = httpStatus,
                lastError = message,
                updatedAt = now
            )
        }
    }

    suspend fun prepareManualRetry(
        captureId: String,
        pairing: PairingConfig,
        now: Long = System.currentTimeMillis()
    ): Boolean {
        return update(captureId) { capture ->
            capture.copy(
                endpointId = pairing.endpointId,
                state = CaptureState.PENDING,
                attemptCount = 0,
                nextAttemptAt = null,
                lastHttpStatus = null,
                lastError = null,
                remoteUploadId = null,
                remoteRecognitionJobId = null,
                pairingProfileId = pairing.profileId.ifBlank { pairing.endpointId },
                computerLabel = pairing.computerLabel.ifBlank { pairing.host },
                completedAt = null,
                hiddenFromRecent = false,
                updatedAt = now
            )
        } != null
    }

    suspend fun prepareBlockedAuthRetries(
        pairing: PairingConfig,
        now: Long = System.currentTimeMillis()
    ): List<String> = withContext(Dispatchers.IO) {
        val profileId = pairing.profileId.ifBlank { pairing.endpointId }
        dao.findBlockedAuth(profileId).map { capture ->
            dao.update(
                capture.copy(
                    endpointId = pairing.endpointId,
                    state = CaptureState.PENDING,
                    attemptCount = 0,
                    nextAttemptAt = null,
                    lastHttpStatus = null,
                    lastError = null,
                    remoteUploadId = null,
                    remoteRecognitionJobId = null,
                    pairingProfileId = profileId,
                    computerLabel = pairing.computerLabel.ifBlank { pairing.host },
                    completedAt = null,
                    hiddenFromRecent = false,
                    updatedAt = now
                )
            )
            capture.captureId
        }
    }

    suspend fun markCancelled(captureId: String, now: Long = System.currentTimeMillis()) {
        update(captureId) { capture ->
            if (capture.state == CaptureState.UPLOADED) capture else capture.copy(
                state = CaptureState.PAUSED,
                nextAttemptAt = null,
                lastError = "上传已暂停，可手动重试",
                updatedAt = now
            )
        }
    }

    private suspend fun update(
        captureId: String,
        transform: (CaptureEntity) -> CaptureEntity
    ): CaptureEntity? = withContext(Dispatchers.IO) {
        val current = dao.find(captureId) ?: return@withContext null
        transform(current).also { dao.update(it) }
    }

    private fun deviceId(): String {
        val preferences = context.getSharedPreferences("capture_identity", Context.MODE_PRIVATE)
        return preferences.getString("device_id", null) ?: UUID.randomUUID().toString().also {
            preferences.edit().putString("device_id", it).commit()
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
