package com.mathnotes.capture.companion

import android.content.Context
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.IOException
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CompanionDatabaseMigrationTest {
    private val databaseName = "companion-migration-test"
    private val context: Context = ApplicationProvider.getApplicationContext()

    @get:Rule
    val helper = MigrationTestHelper(
        instrumentation = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation(),
        databaseClass = CompanionDatabase::class.java,
        specs = emptyList(),
        openFactory = FrameworkSQLiteOpenHelperFactory()
    )

    @After
    fun tearDown() {
        context.deleteDatabase(databaseName)
    }

    @Test
    @Throws(IOException::class)
    fun migrationPreservesLegacyOfflineSnapshotUntilCatalogReconciliation() {
        helper.createDatabase(databaseName, 1).apply {
            execSQL(
                "INSERT INTO companion_sessions " +
                    "(notebookId, sessionId, title, revision, html, updatedAt, syncedAt) VALUES " +
                    "('analysis', 'lecture', '泛函分析', 'r1', '<p>note</p>', 'now', 1000)"
            )
            close()
        }

        val database = Room.databaseBuilder(context, CompanionDatabase::class.java, databaseName)
            .addMigrations(
                CompanionDatabase.MIGRATION_1_2,
                CompanionDatabase.MIGRATION_2_3,
                CompanionDatabase.MIGRATION_3_4,
                CompanionDatabase.MIGRATION_4_5
            )
            .build()
        val migrated = runBlocking {
            database.sessionDao().observeForProfile("new-profile").first().single()
        }

        assertEquals("legacy", migrated.profileId)
        assertEquals("", migrated.revision)
        assertEquals("", migrated.markdown)
        assertEquals("", migrated.html)
        database.close()
    }

    @Test
    @Throws(IOException::class)
    fun migrationDropsOnlyLegacyInlineImageSnapshotsBeforeRoomReadsThem() {
        helper.createDatabase(databaseName, 3).apply {
            execSQL(
                "INSERT INTO companion_sessions " +
                    "(profileId, notebookId, sessionId, title, revision, html, updatedAt, syncedAt, markdown) VALUES " +
                    "('profile', 'analysis', 'inline', '旧内联图片', 'r-inline', " +
                    "'<img src=\"data:image/png;base64,AAAA\">', 'now', 1000, '# old')"
            )
            execSQL(
                "INSERT INTO companion_sessions " +
                    "(profileId, notebookId, sessionId, title, revision, html, updatedAt, syncedAt, markdown) VALUES " +
                    "('profile', 'analysis', 'lightweight', '轻量缓存', 'r-light', " +
                    "'<p>note</p>', 'now', 1001, '# note')"
            )
            close()
        }

        val database = Room.databaseBuilder(context, CompanionDatabase::class.java, databaseName)
            .addMigrations(CompanionDatabase.MIGRATION_3_4, CompanionDatabase.MIGRATION_4_5)
            .build()
        val migrated = runBlocking { database.sessionDao().listForProfile("profile") }

        assertEquals(listOf("lightweight"), migrated.map { it.sessionId })
        assertEquals("", migrated.single().markdown)
        assertEquals("", migrated.single().html)
        assertEquals("", migrated.single().revision)
        database.close()
    }

    @Test
    @Throws(IOException::class)
    fun migrationClearsDatabaseBodiesAndForcesFileBackedRefresh() {
        helper.createDatabase(databaseName, 4).apply {
            execSQL(
                "INSERT INTO companion_sessions " +
                    "(profileId, notebookId, sessionId, title, revision, html, updatedAt, syncedAt, markdown) VALUES " +
                    "('profile', 'analysis', 'long', '长篇缓存', 'r-large', '<p>old</p>', 'now', 1000, '# old')"
            )
            close()
        }

        val database = Room.databaseBuilder(context, CompanionDatabase::class.java, databaseName)
            .addMigrations(CompanionDatabase.MIGRATION_4_5)
            .build()
        val migrated = runBlocking { database.sessionDao().listForProfile("profile").single() }

        assertEquals("", migrated.revision)
        assertEquals("", migrated.markdown)
        assertEquals("", migrated.html)
        database.close()
    }
}
