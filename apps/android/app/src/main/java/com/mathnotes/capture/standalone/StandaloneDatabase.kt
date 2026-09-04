package com.mathnotes.capture.standalone

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import kotlinx.coroutines.flow.Flow

@Dao
interface StandaloneDao {
    @Query("SELECT * FROM standalone_notebooks ORDER BY updatedAt DESC")
    fun observeNotebooks(): Flow<List<StandaloneNotebookEntity>>

    @Query("SELECT * FROM standalone_sessions ORDER BY updatedAt DESC")
    fun observeSessions(): Flow<List<StandaloneSessionEntity>>

    @Query("SELECT * FROM standalone_blocks WHERE sessionId = :sessionId ORDER BY createdAt ASC")
    fun observeBlocks(sessionId: String): Flow<List<StandaloneBlockEntity>>

    @Query("SELECT * FROM standalone_recognition_tasks WHERE sessionId = :sessionId ORDER BY createdAt DESC")
    fun observeTasks(sessionId: String): Flow<List<StandaloneRecognitionTaskEntity>>

    @Query("SELECT * FROM standalone_blocks ORDER BY createdAt ASC")
    fun observeAllBlocks(): Flow<List<StandaloneBlockEntity>>

    @Query("SELECT * FROM standalone_recognition_tasks ORDER BY createdAt DESC")
    fun observeAllTasks(): Flow<List<StandaloneRecognitionTaskEntity>>

    @Query("SELECT * FROM standalone_blocks WHERE id = :id LIMIT 1")
    suspend fun findBlock(id: String): StandaloneBlockEntity?

    @Query("SELECT * FROM standalone_recognition_tasks WHERE id = :id LIMIT 1")
    suspend fun findTask(id: String): StandaloneRecognitionTaskEntity?

    @Query("SELECT * FROM standalone_notebooks WHERE id = :id LIMIT 1")
    suspend fun findNotebook(id: String): StandaloneNotebookEntity?

    @Query("SELECT * FROM standalone_sessions WHERE id = :id LIMIT 1")
    suspend fun findSession(id: String): StandaloneSessionEntity?

    @Query("SELECT * FROM standalone_notebooks ORDER BY updatedAt DESC LIMIT 1")
    suspend fun findLatestNotebook(): StandaloneNotebookEntity?

    @Query("SELECT * FROM standalone_sessions ORDER BY updatedAt DESC LIMIT 1")
    suspend fun findLatestSession(): StandaloneSessionEntity?

    @Query("SELECT * FROM standalone_sessions WHERE notebookId = :notebookId ORDER BY updatedAt DESC")
    suspend fun findSessionsForNotebook(notebookId: String): List<StandaloneSessionEntity>

    @Query("SELECT * FROM standalone_blocks WHERE sessionId = :sessionId ORDER BY createdAt ASC")
    suspend fun findBlocksForSession(sessionId: String): List<StandaloneBlockEntity>

    @Query("SELECT * FROM standalone_recognition_tasks WHERE sessionId = :sessionId ORDER BY createdAt DESC")
    suspend fun findTasksForSession(sessionId: String): List<StandaloneRecognitionTaskEntity>

    @Query("SELECT * FROM standalone_recognition_tasks WHERE assetBlockId = :assetBlockId ORDER BY createdAt DESC")
    suspend fun findTasksForAsset(assetBlockId: String): List<StandaloneRecognitionTaskEntity>

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertNotebook(notebook: StandaloneNotebookEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertSession(session: StandaloneSessionEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertBlock(block: StandaloneBlockEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertTask(task: StandaloneRecognitionTaskEntity)

    @Query("DELETE FROM standalone_recognition_tasks WHERE assetBlockId = :assetBlockId")
    suspend fun deleteTasksForAsset(assetBlockId: String): Int

    @Query("DELETE FROM standalone_blocks WHERE id IN (SELECT resultBlockId FROM standalone_recognition_tasks WHERE assetBlockId = :assetBlockId AND resultBlockId IS NOT NULL)")
    suspend fun deleteResultBlocksForAsset(assetBlockId: String): Int

    @Query("DELETE FROM standalone_blocks WHERE id = :blockId AND kind = 'image'")
    suspend fun deleteImageBlock(blockId: String): Int

    @Query("DELETE FROM standalone_recognition_tasks WHERE sessionId = :sessionId")
    suspend fun deleteTasksForSession(sessionId: String): Int

    @Query("DELETE FROM standalone_blocks WHERE sessionId = :sessionId")
    suspend fun deleteBlocksForSession(sessionId: String): Int

    @Query("DELETE FROM standalone_sessions WHERE id = :sessionId")
    suspend fun deleteSessionById(sessionId: String): Int

    @Query("DELETE FROM standalone_notebooks WHERE id = :notebookId")
    suspend fun deleteNotebookById(notebookId: String): Int

    @Query("UPDATE standalone_notebooks SET title = :title, updatedAt = :updatedAt WHERE id = :notebookId")
    suspend fun renameNotebook(notebookId: String, title: String, updatedAt: Long): Int

    @Query("UPDATE standalone_sessions SET title = :title, updatedAt = :updatedAt WHERE id = :sessionId")
    suspend fun renameSession(sessionId: String, title: String, updatedAt: Long): Int

    @Query("UPDATE standalone_notebooks SET updatedAt = :updatedAt WHERE id = :notebookId")
    suspend fun touchNotebook(notebookId: String, updatedAt: Long)

    @Query("UPDATE standalone_sessions SET updatedAt = :updatedAt WHERE id = :sessionId")
    suspend fun touchSession(sessionId: String, updatedAt: Long)

    @Query("""UPDATE standalone_recognition_tasks
        SET status = 'claimed', claimedAt = :claimedAt, updatedAt = :claimedAt, lastError = NULL
        WHERE id = :taskId AND status = 'awaiting_confirmation'""")
    suspend fun claimAfterUserConfirmation(taskId: String, claimedAt: Long): Int

    @Query("""UPDATE standalone_recognition_tasks
        SET providerId = :providerId, destination = :destination, model = :model,
            status = 'awaiting_confirmation', updatedAt = :updatedAt, lastError = NULL
        WHERE id = :taskId AND status = 'needs_configuration'""")
    suspend fun configureWaitingTask(
        taskId: String,
        providerId: String,
        destination: String,
        model: String,
        updatedAt: Long
    ): Int

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
    entities = [
        StandaloneNotebookEntity::class,
        StandaloneSessionEntity::class,
        StandaloneBlockEntity::class,
        StandaloneRecognitionTaskEntity::class
    ],
    version = 2,
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
            ).addMigrations(MIGRATION_1_2)
                .build().also { instance = it }
        }

        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """CREATE TABLE IF NOT EXISTS `standalone_notebooks` (
                        `id` TEXT NOT NULL,
                        `title` TEXT NOT NULL,
                        `createdAt` INTEGER NOT NULL,
                        `updatedAt` INTEGER NOT NULL,
                        PRIMARY KEY(`id`)
                    )""".trimIndent()
                )
                db.execSQL(
                    """INSERT OR IGNORE INTO `standalone_notebooks` (`id`, `title`, `createdAt`, `updatedAt`)
                        SELECT `notebookId`,
                            CASE WHEN `notebookId` = 'standalone-local' THEN '本机笔记' ELSE `notebookId` END,
                            MIN(`createdAt`), MAX(`updatedAt`)
                        FROM `standalone_sessions`
                        GROUP BY `notebookId`""".trimIndent()
                )
            }
        }
    }
}
