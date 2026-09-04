package com.mathnotes.capture.standalone

import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class StandaloneDatabaseMigrationTest {
    private val databaseName = "standalone-migration-test"

    @get:Rule
    val helper = MigrationTestHelper(
        instrumentation = InstrumentationRegistry.getInstrumentation(),
        databaseClass = StandaloneDatabase::class.java,
        specs = emptyList(),
        openFactory = FrameworkSQLiteOpenHelperFactory()
    )

    @Test
    fun migrationOneToTwoCreatesNotebookWithoutChangingExistingSession() {
        helper.createDatabase(databaseName, 1).apply {
            execSQL(
                """INSERT INTO standalone_sessions (id, notebookId, title, createdAt, updatedAt)
                    VALUES ('session-1', 'standalone-local', '旧手机笔记', 10, 20)""".trimIndent()
            )
            close()
        }

        helper.runMigrationsAndValidate(databaseName, 2, true, StandaloneDatabase.MIGRATION_1_2).use { database ->
            database.query("SELECT title, createdAt, updatedAt FROM standalone_notebooks WHERE id = 'standalone-local'").use { cursor ->
                cursor.moveToFirst()
                assertEquals("本机笔记", cursor.getString(0))
                assertEquals(10L, cursor.getLong(1))
                assertEquals(20L, cursor.getLong(2))
            }
            database.query("SELECT title, notebookId FROM standalone_sessions WHERE id = 'session-1'").use { cursor ->
                cursor.moveToFirst()
                assertEquals("旧手机笔记", cursor.getString(0))
                assertEquals("standalone-local", cursor.getString(1))
            }
        }
    }
}
