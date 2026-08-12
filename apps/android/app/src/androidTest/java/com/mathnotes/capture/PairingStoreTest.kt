package com.mathnotes.capture

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.pairing.PairingCredentialProtector
import com.mathnotes.capture.pairing.PairingStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PairingStoreTest {
    @Test
    fun persistsPrivatelyAndRedactsTokenFromSummary() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val store = PairingStore(context) { "pc-primary" }
        store.clear()
        val config = PairingConfig(
            version = 1,
            host = "192.168.137.1",
            port = 43424,
            token = "0123456789abcdef",
            notebookId = "functional_analysis",
            sessionId = "lecture",
            transport = "private_http"
        )

        assertTrue(store.save(config))

        val stored = store.load()!!
        assertEquals(config.host, stored.host)
        assertEquals("pc-primary", stored.profileId)
        assertEquals("192.168.137.1:43424", stored.computerLabel)
        assertFalse(stored.redactedSummary().contains(config.token))
        val rawProfiles = context.getSharedPreferences("paired_pc", android.content.Context.MODE_PRIVATE)
            .getString("profiles_v3", "")
            .orEmpty()
        assertFalse(rawProfiles.contains(config.token))
        assertTrue(rawProfiles.contains("tokenCiphertext"))
        assertTrue(store.clear())
        assertNull(store.load())
    }

    @Test
    fun keepsMultipleProfilesAndCanSwitchOrRemoveTheActiveComputer() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val ids = ArrayDeque(listOf("pc-a", "pc-b"))
        val store = PairingStore(context) { ids.removeFirst() }
        store.clear()

        assertTrue(store.save(config("192.168.137.1", 43424, "token-a")))
        assertTrue(store.save(config("192.168.137.2", 43425, "token-b")))
        assertEquals(2, store.list().size)
        assertEquals("pc-b", store.load()!!.profileId)

        assertTrue(store.activate("pc-a"))
        assertEquals("token-a", store.load()!!.token)
        assertNotEquals(store.load()!!.profileId, store.load("pc-b")!!.profileId)

        assertTrue(store.remove("pc-a"))
        assertEquals(listOf("pc-b"), store.list().map { it.profileId })
        assertEquals("pc-b", store.load()!!.profileId)
        store.clear()
    }

    @Test
    fun migratesLegacySinglePairingWithoutLosingItsTarget() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        context.getSharedPreferences("paired_pc", android.content.Context.MODE_PRIVATE)
            .edit()
            .clear()
            .putString("host", "192.168.42.1")
            .putInt("port", 12345)
            .putString("token", "legacy-token")
            .putString("notebook", "analysis")
            .putString("session", "lecture-3")
            .putString("target_title", "泛函分析第 3 讲")
            .commit()

        val migrated = PairingStore(context) { "legacy-pc" }.load()!!

        assertEquals("legacy-pc", migrated.profileId)
        assertEquals("analysis", migrated.notebookId)
        assertEquals("lecture-3", migrated.sessionId)
        assertEquals("泛函分析第 3 讲", migrated.targetTitle)
        val preferences = context.getSharedPreferences("paired_pc", android.content.Context.MODE_PRIVATE)
        assertFalse(preferences.contains("token"))
        assertFalse(preferences.getString("profiles_v3", "").orEmpty().contains("legacy-token"))
        PairingStore(context).clear()
    }

    @Test
    fun keepsLegacyCredentialWhenEncryptionIsUnavailable() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val preferences = context.getSharedPreferences("paired_pc", android.content.Context.MODE_PRIVATE)
        preferences.edit()
            .clear()
            .putString("host", "192.168.42.1")
            .putInt("port", 12345)
            .putString("token", "legacy-token")
            .commit()
        val failingProtector = object : PairingCredentialProtector {
            override fun protect(plaintext: String): String = error("keystore unavailable")
            override fun unprotect(ciphertext: String): String = error("keystore unavailable")
        }

        val store = PairingStore(
            context = context,
            credentialProtector = failingProtector,
            idFactory = { "legacy-pc" }
        )

        assertNull(store.load())
        assertEquals("legacy-token", preferences.getString("token", null))
        assertFalse(preferences.contains("profiles_v3"))
        preferences.edit().clear().commit()
    }

    @Test
    fun groupsSameComputerEndpointsWithoutChangingTheSelectedTargetIdentity() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val ids = ArrayDeque(listOf("pc-local", "pc-tailnet", "pc-other"))
        val store = PairingStore(context) { ids.removeFirst() }
        store.clear()

        assertTrue(store.save(config("192.168.137.1", 43424, "shared-token")))
        assertTrue(store.save(config("100.88.1.2", 43424, "shared-token")))
        assertTrue(store.save(config("192.168.137.9", 43424, "other-token")))
        assertTrue(store.activate("pc-local"))

        val active = store.load()!!.copy(
            notebookId = "pde_notes",
            sessionId = "lecture_08",
            targetTitle = "边界层第 8 讲"
        )
        val candidates = store.endpointCandidates(active)

        assertEquals(
            listOf("http://100.88.1.2:43424", "http://192.168.137.1:43424"),
            candidates.map { it.endpointId }
        )
        assertTrue(candidates.all { it.profileId == "pc-local" })
        assertTrue(candidates.all { it.notebookId == "pde_notes" && it.sessionId == "lecture_08" })
        store.clear()
    }

    private fun config(host: String, port: Int, token: String) = PairingConfig(
        version = 1,
        host = host,
        port = port,
        token = token,
        notebookId = "functional_analysis",
        sessionId = "lecture",
        transport = "private_http"
    )
}
