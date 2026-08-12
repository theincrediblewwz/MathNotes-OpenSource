package com.mathnotes.capture.companion

import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.pairing.PairingTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionLayoutContractTest {
    @Test
    fun readerKeepsEnoughSpaceAboveFloatingNavigation() {
        assertTrue(COMPANION_READER_BOTTOM_INSET.value >= 96f)
    }

    @Test
    fun eventStreamReconnectsPromptlyWithoutBusyLooping() {
        assertTrue(COMPANION_EVENT_RECONNECT_DELAY_MS in 1_000L..10_000L)
    }

    @Test
    fun verifiedCatalogKeepsTheRequestedSessionWhenItStillExists() {
        val requested = PairingTarget("analysis", "lecture-2", "第二讲")
        val catalog = CompanionCatalogSnapshot(
            activeTarget = PairingTarget("analysis", "lecture-1", "第一讲"),
            targets = listOf(
                PairingTarget("analysis", "lecture-1", "第一讲"),
                requested
            )
        )

        assertEquals(requested, resolveCatalogTarget(requested, catalog))
    }

    @Test
    fun verifiedCatalogFallsBackToTheServerActiveTargetWhenTheSessionMoved() {
        val catalog = CompanionCatalogSnapshot(
            activeTarget = PairingTarget("analysis", "lecture-3", "第三讲"),
            targets = listOf(PairingTarget("analysis", "lecture-3", "第三讲"))
        )

        assertEquals(
            PairingTarget("analysis", "lecture-3", "第三讲"),
            resolveCatalogTarget(PairingTarget("analysis", "deleted", "旧讲义"), catalog)
        )
    }

    @Test
    fun sessionSyncTriesTheVerifiedEndpointBeforeOtherAddressesForTheSameComputer() {
        val preferred = pairing("http://10.0.0.2:4095", "analysis", "lecture-2")
        val fallback = pairing("http://100.80.20.3:4095", "stale", "stale")

        val ordered = orderedEndpointCandidates(
            preferred,
            listOf(fallback, preferred, fallback)
        )

        assertEquals(listOf(preferred.endpointId, fallback.endpointId), ordered.map { it.endpointId })
        assertTrue(ordered.all { it.profileId == preferred.profileId })
        assertTrue(ordered.all { it.notebookId == "analysis" && it.sessionId == "lecture-2" })
    }

    private fun pairing(endpoint: String, notebookId: String, sessionId: String) = PairingConfig(
        version = 1,
        host = endpoint.substringAfter("://").substringBefore(':'),
        port = endpoint.substringAfterLast(':').toInt(),
        token = "0123456789abcdef",
        notebookId = notebookId,
        sessionId = sessionId,
        transport = "private_http",
        targetTitle = sessionId,
        profileId = endpoint,
        endpointUrl = endpoint
    )
}
