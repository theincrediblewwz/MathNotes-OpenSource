package com.mathnotes.capture.standalone

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow

@Dao
interface StandaloneDao {
    @Query("SELECT * FROM standalone_sessions ORDER BY updatedAt DESC")
    fun observeSessions(): Flow<List<StandaloneSessionEntity>>

    @Query("SELECT * FROM standalone_blocks WHERE sessionId = :sessionId ORDER BY createdAt ASC")
    fun observeBlocks(sessionId: String): Flow<List<StandaloneBlockEntity>>

    @Query("SELECT * FROM standalone_recognition_tasks WHERE sessionId = :sessionId ORDER BY createdAt DESC")
    fun observeTasks(sessionId: String): Flow<List<StandaloneRecognitionTaskEntity>>

    @Query("SELECT * FROM standalone_blocks WHERE id = :id LIMIT 1")
    suspend fun findBlock(id: String): StandaloneBlockEntity?

    @Query("SELECT * FROM standalone_recognition_tasks WHERE id = :id LIMIT 1")
    suspend fun findTask(id: String): StandaloneRecognitionTaskEntity?

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertSession(session: StandaloneSessionEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertBlock(block: StandaloneBlockEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertTask(task: StandaloneRecognitionTaskEntity)

    @Query("UPDATE standalone_sessions SET updatedAt = :updatedAt WHERE id = :sessionId")
    suspend fun touchSession(sessionId: String, updatedAt: Long)

    @Query("""UPDATE standalone_recognition_tasks
        SET status = 'claimed', claimedAt = :claimedAt, updatedAt = :claimedAt, lastError = NULL
        WHERE id = :taskId AND status = 'awaiting_confirmation'""")
    suspend fun claimAfterUserConfirmation(taskId: String, claimedAt: Long): Int

    @Query("""UPDATE standalone_recognition_tasks
        SET status = 'succeeded', resultBlockId = :resultBlockId,
            completedAt = :completedAt, updatedAt = :completedAt, lastError = NULL
        WHERE id = :taskId AND status = 'claimed'""")
    suspend fun markSucceeded(taskId: String, resultBlockId: String, completedAt: Long): Int

    @Query("""UPDATE standalone_recognition_tasks
        SET status = :status, updatedAt = :updatedAt, lastError = :message
        WHERE id = :taskId AND status = 'claimed'""")
    suspend fun markClaimFailure(taskId: String, status: String, message: String, updatedAt: Long): Int

    @Query("""UPDATE standalone_recognition_tasks
        SET status = 'possibly_charged', updatedAt = :updatedAt,
            lastError = '上次识别在完成前中断；为避免重复调用，已停止自动恢复'
        WHERE status = 'claimed'""")
    suspend fun recoverInterruptedClaims(updatedAt: Long): Int
}

@Database(
    entities = [StandaloneSessionEntity::class, StandaloneBlockEntity::class, StandaloneRecognitionTaskEntity::class],
    version = 1,
    exportSchema = true
)
abstract class StandaloneDatabase : RoomDatabase() {
    abstract fun dao(): StandaloneDao

    companion object {
        @Volatile private var instance: StandaloneDatabase? = null

        fun get(context: Context): StandaloneDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext,
                StandaloneDatabase::class.java,
                "mathnotes-standalone-v1.db"
            ).build().also { instance = it }
        }
    }
}
