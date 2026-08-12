package com.mathnotes.capture.storage

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "capture_queue",
    indices = [
        Index(value = ["pairingProfileId", "notebookId", "createdAt"]),
        Index(value = ["state", "createdAt"])
    ]
)
data class CaptureEntity(
    @PrimaryKey val captureId: String,
    val deviceId: String,
    val localPath: String,
    val mimeType: String,
    val byteLength: Long,
    val sha256: String,
    val notebookId: String,
    val sessionId: String,
    val endpointId: String,
    val state: String,
    val attemptCount: Int,
    val nextAttemptAt: Long?,
    val lastHttpStatus: Int?,
    val lastError: String?,
    val remoteUploadId: String?,
    val remoteRecognitionJobId: String?,
    val createdAt: Long,
    val updatedAt: Long,
    val materialType: String = MaterialType.IMAGE,
    val captureSource: String = CaptureSource.CAMERA,
    val sourceName: String = "",
    val pairingProfileId: String = "",
    val computerLabel: String = "",
    val targetTitle: String = "",
    val localCopyAvailable: Boolean = true,
    val completedAt: Long? = null,
    val hiddenFromRecent: Boolean = false
)

object MaterialType {
    const val IMAGE = "image"
    const val PDF = "pdf"
}

object CaptureSource {
    const val CAMERA = "camera"
    const val GALLERY = "gallery"
    const val DOCUMENT_PICKER = "document_picker"
}

object CaptureState {
    const val PENDING = "pending"
    const val UPLOADING = "uploading"
    const val UPLOADED = "uploaded"
    const val RETRYABLE = "retryable"
    const val PAUSED = "paused"
    const val BLOCKED_AUTH = "blocked_auth"
    const val FAILED_PERMANENT = "failed_permanent"
}
