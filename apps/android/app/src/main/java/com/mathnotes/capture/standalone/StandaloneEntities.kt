package com.mathnotes.capture.standalone

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(tableName = "standalone_sessions")
data class StandaloneSessionEntity(
    @PrimaryKey val id: String,
    val notebookId: String,
    val title: String,
    val createdAt: Long,
    val updatedAt: Long
)

@Entity(
    tableName = "standalone_blocks",
    indices = [Index(value = ["sessionId", "createdAt"])]
)
data class StandaloneBlockEntity(
    @PrimaryKey val id: String,
    val sessionId: String,
    val kind: String,
    val localPath: String,
    val markdown: String,
    val locked: Boolean,
    val createdAt: Long,
    val updatedAt: Long
)

@Entity(
    tableName = "standalone_recognition_tasks",
    indices = [Index(value = ["sessionId", "createdAt"]), Index(value = ["status"])]
)
data class StandaloneRecognitionTaskEntity(
    @PrimaryKey val id: String,
    val sessionId: String,
    val assetBlockId: String,
    val providerId: String,
    val destination: String,
    val model: String,
    val status: String,
    val createdAt: Long,
    val updatedAt: Long,
    val claimedAt: Long? = null,
    val completedAt: Long? = null,
    val resultBlockId: String? = null,
    val lastError: String? = null
)

object StandaloneBlockKind {
    const val IMAGE = "image"
    const val MARKDOWN_DRAFT = "markdown_draft"
}

object StandaloneTaskStatus {
    const val AWAITING_CONFIRMATION = "awaiting_confirmation"
    const val CLAIMED = "claimed"
    const val SUCCEEDED = "succeeded"
    const val FAILED = "failed"
    const val POSSIBLY_CHARGED = "possibly_charged"
    const val CANCELLED = "cancelled"
}
