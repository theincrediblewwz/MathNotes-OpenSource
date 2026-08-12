package com.mathnotes.capture.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface CaptureDao {
    @Query("SELECT * FROM capture_queue ORDER BY createdAt DESC")
    fun observeAll(): Flow<List<CaptureEntity>>

    @Query("SELECT * FROM capture_queue WHERE captureId = :captureId")
    suspend fun find(captureId: String): CaptureEntity?

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(capture: CaptureEntity)

    @Update
    suspend fun update(capture: CaptureEntity)

    @Query("SELECT * FROM capture_queue WHERE state IN ('pending', 'uploading', 'retryable') ORDER BY createdAt ASC")
    suspend fun findRecoverable(): List<CaptureEntity>

    @Query(
        "SELECT * FROM capture_queue " +
            "WHERE pairingProfileId = :profileId AND notebookId = :notebookId " +
            "ORDER BY createdAt DESC"
    )
    fun observeHistory(profileId: String, notebookId: String): Flow<List<CaptureEntity>>

    @Query("SELECT * FROM capture_queue WHERE state = 'uploaded'")
    suspend fun listUploaded(): List<CaptureEntity>

    @Query("SELECT * FROM capture_queue WHERE state = 'blocked_auth' AND pairingProfileId = :profileId ORDER BY createdAt ASC")
    suspend fun findBlockedAuth(profileId: String): List<CaptureEntity>

    @Query("DELETE FROM capture_queue WHERE state = 'uploaded'")
    suspend fun deleteUploaded()

    @Query("UPDATE capture_queue SET hiddenFromRecent = 1 WHERE state = 'uploaded' AND hiddenFromRecent = 0")
    suspend fun hideUploadedFromRecent(): Int
}
