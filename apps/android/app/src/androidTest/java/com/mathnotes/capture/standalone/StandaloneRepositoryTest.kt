package com.mathnotes.capture.standalone

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class StandaloneRepositoryTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private lateinit var database: StandaloneDatabase
    private lateinit var repository: StandaloneRepository
    private val cleanup = mutableListOf<File>()

    @Before
    fun setUp() {
        database = Room.inMemoryDatabaseBuilder(context, StandaloneDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        repository = StandaloneRepository(context, database)
    }

    @After
    fun tearDown() {
        database.close()
        cleanup.forEach(File::delete)
    }

    @Test
    fun notebookOwnsRenameableSessionsAndDeletionRemovesOnlyItsLocalMaterial() = runBlocking {
        val notebook = repository.createNotebook("泛函分析")
        val first = repository.createSession(notebook.id, "第 3 讲")
        val second = repository.createSession(notebook.id, "第 4 讲")
        assertTrue(repository.renameNotebook(notebook.id, "泛函分析课程"))
        assertTrue(repository.renameSession(first.id, "一致有界原理"))

        val source = temporaryImage("standalone-session")
        val task = repository.importCapturedFile(first.id, source, configuredProvider())
        val asset = requireNotNull(repository.findBlock(task.assetBlockId))
        cleanup += File(asset.localPath)

        assertEquals(StandaloneTaskStatus.AWAITING_CONFIRMATION, task.status)
        assertTrue(File(asset.localPath).isFile)
        assertEquals("泛函分析课程", database.dao().findNotebook(notebook.id)?.title)
        assertEquals("一致有界原理", database.dao().findSession(first.id)?.title)

        assertTrue(repository.deleteSession(first.id))
        assertNull(database.dao().findSession(first.id))
        assertNull(repository.findTask(task.id))
        assertNull(repository.findBlock(asset.id))
        assertFalse(File(asset.localPath).exists())
        assertNotNull(database.dao().findSession(second.id))

        assertTrue(repository.deleteNotebook(notebook.id))
        assertNull(database.dao().findNotebook(notebook.id))
        assertNull(database.dao().findSession(second.id))
    }

    @Test
    fun claimedRecognitionProtectsSessionAndPhotoFromDeletion() = runBlocking {
        val notebook = repository.createNotebook("受保护任务")
        val session = repository.createSession(notebook.id, "识别中")
        val source = temporaryImage("standalone-claimed")
        val task = repository.importCapturedFile(session.id, source, configuredProvider())
        val asset = requireNotNull(repository.findBlock(task.assetBlockId))
        cleanup += File(asset.localPath)
        assertNotNull(repository.claimAfterUserConfirmation(task.id))

        val failure = runCatching { repository.deleteSession(session.id) }.exceptionOrNull()

        assertTrue(failure is IllegalArgumentException)
        assertNotNull(database.dao().findSession(session.id))
        assertNotNull(repository.findTask(task.id))
        assertTrue(File(asset.localPath).isFile)
    }

    private fun configuredProvider() = StandaloneProviderProfile(
        providerId = "deepseek",
        destination = "https://api.deepseek.com/chat/completions",
            model = "deepseek-v4-flash-exp",
        enabled = true,
        hasSecret = true
    )

    private fun temporaryImage(prefix: String): File = File(
        context.cacheDir,
        "$prefix-${UUID.randomUUID()}.jpg"
    ).also {
        it.writeBytes("not-empty-image".toByteArray())
        cleanup += it
    }
}
