package com.mathnotes.capture

import android.content.Context
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.mathnotes.capture.storage.MathNotesDatabase
import java.io.IOException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MathNotesDatabaseMigrationTest {
    private val databaseName = "capture-migration-test"
    private val context: Context = ApplicationProvider.getApplicationContext()

    @get:Rule
    val helper = MigrationTestHelper(
        instrumentation = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation(),
        databaseClass = MathNotesDatabase::class.java,
        specs = emptyList(),
        openFactory = FrameworkSQLiteOpenHelperFactory()
    )

    @After
    fun tearDown() {
        context.deleteDatabase(databaseName)
    }

    @Test
    @Throws(IOException::class)
    fun migratesExistingCaptureWithoutLosingReceiptOrLocalFileState() {
        helper.createDatabase(databaseName, 1).apply {
            execSQL(
                "INSERT INTO capture_queue " +
                    "(captureId, deviceId, localPath, mimeType, byteLength, sha256, notebookId, sessionId, " +
                    "endpointId, state, attemptCount, nextAttemptAt, lastHttpStatus, lastError, remoteUploadId, " +
                    "remoteRecognitionJobId, createdAt, updatedAt) VALUES " +
                    "('legacy-1', 'phone-1', '/data/legacy.jpg', 'image/jpeg', 123, 'abc', 'analysis', " +
                    "'lecture', '192.168.137.1:43424', 'uploaded', 1, NULL, 202, NULL, 'upload-1', " +
                    "'recognition-1', 1000, 2000)"
            )
            close()
        }

        val database = Room.databaseBuilder(context, MathNotesDatabase::class.java, databaseName)
            .addMigrations(MathNotesDatabase.MIGRATION_1_2, MathNotesDatabase.MIGRATION_2_3)
            .build()
        val migrated = kotlinx.coroutines.runBlocking { database.captureDao().find("legacy-1")!! }

        assertEquals("upload-1", migrated.remoteUploadId)
        assertEquals("recognition-1", migrated.remoteRecognitionJobId)
        assertEquals("image", migrated.materialType)
        assertEquals("camera", migrated.captureSource)
        assertTrue(migrated.localCopyAvailable)
        assertNull(migrated.completedAt)
        assertFalse(migrated.hiddenFromRecent)
        database.close()
    }

    @Test
    @Throws(IOException::class)
    fun migrationTwoToThreeKeepsExistingRowsVisibleInRecent() {
        helper.createDatabase(databaseName, 2).apply {
            execSQL(
                "INSERT INTO capture_queue " +
                    "(captureId, deviceId, localPath, mimeType, byteLength, sha256, notebookId, sessionId, " +
                    "endpointId, state, attemptCount, nextAttemptAt, lastHttpStatus, lastError, remoteUploadId, " +
                    "remoteRecognitionJobId, createdAt, updatedAt, materialType, captureSource, sourceName, " +
                    "pairingProfileId, computerLabel, targetTitle, localCopyAvailable, completedAt) VALUES " +
                    "('v2-row', 'phone-1', '/data/photo.jpg', 'image/jpeg', 123, 'abc', 'analysis', 'lecture', " +
                    "'pc', 'uploaded', 1, NULL, 202, NULL, 'upload-1', 'recognition-1', 1000, 2000, " +
                    "'image', 'camera', 'photo.jpg', 'pc-1', '课堂电脑', '泛函分析', 1, 2000)"
            )
            close()
        }

        val database = Room.databaseBuilder(context, MathNotesDatabase::class.java, databaseName)
            .addMigrations(MathNotesDatabase.MIGRATION_2_3)
            .build()
        val migrated = kotlinx.coroutines.runBlocking { database.captureDao().find("v2-row")!! }

        assertFalse(migrated.hiddenFromRecent)
        database.close()
    }
}
