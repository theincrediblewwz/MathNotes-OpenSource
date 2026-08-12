package com.mathnotes.capture.companion

import androidx.room.Entity

@Entity(
    tableName = "companion_sessions",
    primaryKeys = ["profileId", "notebookId", "sessionId"]
)
data class CompanionSessionEntity(
    val profileId: String,
    val notebookId: String,
    val sessionId: String,
    val title: String,
    val revision: String,
    val markdown: String,
    val html: String,
    val updatedAt: String,
    val syncedAt: Long
)
