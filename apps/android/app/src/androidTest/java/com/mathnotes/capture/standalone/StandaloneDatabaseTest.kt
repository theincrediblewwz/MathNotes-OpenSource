package com.mathnotes.capture.standalone

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class StandaloneDatabaseTest {
    private lateinit var database: StandaloneDatabase

    @Before fun setUp() {
        database = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            StandaloneDatabase::class.java
        ).allowMainThreadQueries().build()
    }

    @After fun tearDown() = database.close()

    @Test fun taskClaimIsOneShotAndInterruptedClaimIsNotReplayed() = runBlocking {
        val dao = database.dao()
        dao.insertSession(StandaloneSessionEntity("session", "notebook", "title", 1, 1))
        dao.insertBlock(StandaloneBlockEntity("asset", "session", StandaloneBlockKind.IMAGE, "/tmp/a.jpg", "", false, 1, 1))
        dao.insertTask(StandaloneRecognitionTaskEntity(
            id = "task", sessionId = "session", assetBlockId = "asset",
            providerId = "fixture", destination = "local://fixture", model = "fixture",
            status = StandaloneTaskStatus.AWAITING_CONFIRMATION, createdAt = 1, updatedAt = 1
        ))

        assertEquals(1, dao.claimAfterUserConfirmation("task", 2))
        assertEquals(0, dao.claimAfterUserConfirmation("task", 3))
        assertEquals(1, dao.recoverInterruptedClaims(4))
        assertEquals(StandaloneTaskStatus.POSSIBLY_CHARGED, dao.findTask("task")?.status)
    }
}
