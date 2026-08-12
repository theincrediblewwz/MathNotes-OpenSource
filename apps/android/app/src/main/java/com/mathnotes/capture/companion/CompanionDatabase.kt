package com.mathnotes.capture.companion

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
interface CompanionSessionDao {
    @Query("SELECT * FROM companion_sessions WHERE profileId = :profileId OR profileId = 'legacy' ORDER BY syncedAt DESC")
    fun observeForProfile(profileId: String): Flow<List<CompanionSessionEntity>>

    @Query("SELECT * FROM companion_sessions WHERE profileId = :profileId")
    suspend fun listForProfile(profileId: String): List<CompanionSessionEntity>

    @Query("SELECT * FROM companion_sessions WHERE profileId = :profileId AND notebookId = :notebookId AND sessionId = :sessionId LIMIT 1")
    suspend fun find(profileId: String, notebookId: String, sessionId: String): CompanionSessionEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(session: CompanionSessionEntity)

    @Query("DELETE FROM companion_sessions WHERE profileId = :profileId AND notebookId = :notebookId AND sessionId = :sessionId")
    suspend fun delete(profileId: String, notebookId: String, sessionId: String)

    @Query("DELETE FROM companion_sessions WHERE profileId = 'legacy'")
    suspend fun deleteLegacy()
}

@Database(entities = [CompanionSessionEntity::class], version = 5, exportSchema = true)
abstract class CompanionDatabase : RoomDatabase() {
    abstract fun sessionDao(): CompanionSessionDao

    companion object {
        @Volatile private var instance: CompanionDatabase? = null

        fun get(context: Context): CompanionDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext,
                CompanionDatabase::class.java,
                "mathnotes-companion-cache.db"
            ).addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5).build().also { instance = it }
        }

        internal val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL(
                    """CREATE TABLE IF NOT EXISTS companion_sessions_v2 (
                        profileId TEXT NOT NULL,
                        notebookId TEXT NOT NULL,
                        sessionId TEXT NOT NULL,
                        title TEXT NOT NULL,
                        revision TEXT NOT NULL,
                        html TEXT NOT NULL,
                        updatedAt TEXT NOT NULL,
                        syncedAt INTEGER NOT NULL,
                        PRIMARY KEY(profileId, notebookId, sessionId)
                    )""".trimIndent()
                )
                database.execSQL(
                    """INSERT INTO companion_sessions_v2
                        (profileId, notebookId, sessionId, title, revision, html, updatedAt, syncedAt)
                        SELECT 'legacy', notebookId, sessionId, title, revision, html, updatedAt, syncedAt
                        FROM companion_sessions""".trimIndent()
                )
                database.execSQL("DROP TABLE companion_sessions")
                database.execSQL("ALTER TABLE companion_sessions_v2 RENAME TO companion_sessions")
            }
        }

        internal val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("ALTER TABLE companion_sessions ADD COLUMN markdown TEXT NOT NULL DEFAULT ''")
            }
        }

        internal val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(database: SupportSQLiteDatabase) {
                // Companion rows are disposable read-only cache. Old builds embedded image bytes
                // in HTML, creating rows too large for CursorWindow to read during refresh.
                database.execSQL("DELETE FROM companion_sessions WHERE instr(lower(html), 'data:image/') > 0")
            }
        }

        internal val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(database: SupportSQLiteDatabase) {
                // Full note bodies live in atomic files from v5 onward. Existing rows are
                // derivative cache, so clear them and the revision to force a fresh snapshot.
                database.execSQL("UPDATE companion_sessions SET markdown = '', html = '', revision = ''")
            }
        }
    }
}
