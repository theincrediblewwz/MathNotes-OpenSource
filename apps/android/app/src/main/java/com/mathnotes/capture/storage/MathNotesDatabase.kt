package com.mathnotes.capture.storage

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(entities = [CaptureEntity::class], version = 3, exportSchema = true)
abstract class MathNotesDatabase : RoomDatabase() {
    abstract fun captureDao(): CaptureDao

    companion object {
        @Volatile private var instance: MathNotesDatabase? = null

        fun get(context: Context): MathNotesDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext,
                MathNotesDatabase::class.java,
                "mathnotes-capture.db"
            ).addMigrations(MIGRATION_1_2, MIGRATION_2_3)
                .build()
                .also { instance = it }
        }

        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE capture_queue ADD COLUMN materialType TEXT NOT NULL DEFAULT 'image'")
                db.execSQL("ALTER TABLE capture_queue ADD COLUMN captureSource TEXT NOT NULL DEFAULT 'camera'")
                db.execSQL("ALTER TABLE capture_queue ADD COLUMN sourceName TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE capture_queue ADD COLUMN pairingProfileId TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE capture_queue ADD COLUMN computerLabel TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE capture_queue ADD COLUMN targetTitle TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE capture_queue ADD COLUMN localCopyAvailable INTEGER NOT NULL DEFAULT 1")
                db.execSQL("ALTER TABLE capture_queue ADD COLUMN completedAt INTEGER DEFAULT NULL")
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS index_capture_queue_pairingProfileId_notebookId_createdAt " +
                        "ON capture_queue(pairingProfileId, notebookId, createdAt)"
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS index_capture_queue_state_createdAt " +
                        "ON capture_queue(state, createdAt)"
                )
            }
        }

        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "ALTER TABLE capture_queue ADD COLUMN hiddenFromRecent INTEGER NOT NULL DEFAULT 0"
                )
            }
        }
    }
}
