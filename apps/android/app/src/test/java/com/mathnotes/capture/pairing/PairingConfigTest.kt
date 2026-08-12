package com.mathnotes.capture.pairing

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingConfigTest {
    private val fixtures = JSONObject(
        requireNotNull(javaClass.classLoader?.getResource("pairing-v1-fixtures.json")).readText()
    )

    @Test
    fun `parses every valid shared fixture`() {
        val valid = fixtures.getJSONArray("valid")
        repeat(valid.length()) { index ->
            val fixture = valid.getJSONObject(index)
            val result = PairingConfig.parse(fixture.getString("payload"))

            assertTrue(fixture.getString("name"), result is PairingParseResult.Success)
            val config = (result as PairingParseResult.Success).config
            assertEquals(fixture.getString("host"), config.host)
            assertEquals(fixture.getInt("port"), config.port)
            assertEquals(fixture.getString("notebookId"), config.notebookId)
            assertEquals(fixture.getString("sessionId"), config.sessionId)
        }
    }

    @Test
    fun `rejects every invalid shared fixture with a stable reason`() {
        val invalid = fixtures.getJSONArray("invalid")
        repeat(invalid.length()) { index ->
            val fixture = invalid.getJSONObject(index)
            val result = PairingConfig.parse(fixture.getString("payload"))

            assertTrue(fixture.getString("name"), result is PairingParseResult.Failure)
            assertEquals(fixture.getString("error"), (result as PairingParseResult.Failure).reason.code)
        }
    }

    @Test
    fun `manual entry uses the same validation path`() {
        val result = PairingConfig.fromManual(
            endpoint = "192.168.137.1:37621",
            token = "0123456789abcdef0123456789abcdef"
        )

        assertTrue(result is PairingParseResult.Success)
        assertEquals(false, (result as PairingParseResult.Success).config.hasTarget)
    }

    @Test
    fun `manual entry accepts a tailscale address`() {
        val result = PairingConfig.fromManual(
            endpoint = "http://100.85.42.7:37621",
            token = "0123456789abcdef0123456789abcdef"
        )

        assertTrue(result is PairingParseResult.Success)
        val config = (result as PairingParseResult.Success).config
        assertEquals(EndpointKind.TAILNET, config.endpointKind)
        assertEquals("http://100.85.42.7:37621", config.endpoint)
    }

    @Test
    fun `manual entry accepts an https tunnel hostname`() {
        val result = PairingConfig.fromManual(
            endpoint = "https://notes.example.test",
            token = "0123456789abcdef0123456789abcdef"
        )

        assertTrue(result is PairingParseResult.Success)
        val config = (result as PairingParseResult.Success).config
        assertEquals(EndpointKind.TUNNEL, config.endpointKind)
        assertEquals("https://notes.example.test", config.endpoint)
        assertEquals(443, config.port)
    }

    @Test
    fun `connection-only qr does not require internal session ids`() {
        val result = PairingConfig.parse(
            "mathnotes://pair?v=1&host=192.168.137.1&port=37621&token=0123456789abcdef&transport=private_http"
        )

        assertTrue(result is PairingParseResult.Success)
        assertEquals(false, (result as PairingParseResult.Success).config.hasTarget)
    }

    @Test
    fun `qr preserves validated alternate hosts for first connection fallback`() {
        val result = PairingConfig.parse(
            "mathnotes://pair?v=1&host=192.168.137.1&port=37621&token=0123456789abcdef&transport=private_http&hosts=10.20.30.40%2C100.85.42.7"
        )

        assertTrue(result is PairingParseResult.Success)
        val config = (result as PairingParseResult.Success).config
        assertEquals(listOf("10.20.30.40", "100.85.42.7"), config.alternateHosts)
        assertEquals(
            listOf("100.85.42.7", "192.168.137.1", "10.20.30.40"),
            config.verificationCandidates().map { it.host }
        )
    }

    @Test
    fun `manual endpoint remains explicit even when alternate hosts exist`() {
        val result = PairingConfig.fromManual(
            endpoint = "http://192.168.137.1:37621",
            token = "0123456789abcdef0123456789abcdef"
        )

        val config = (result as PairingParseResult.Success).config.copy(
            alternateHosts = listOf("100.85.42.7")
        )
        assertEquals(listOf("192.168.137.1"), config.verificationCandidates().map { it.host })
    }

    @Test
    fun `parses v2 one-time challenge without a bearer token`() {
        val result = PairingConfig.parse(
            "mathnotes://pair?v=2&host=100.92.105.105&port=4095" +
                "&challenge=challenge-001&code=ABCD-EFGH" +
                "&expires=2026-07-25T08%3A10%3A00.000Z&transport=private_http"
        )

        val config = (result as PairingParseResult.Success).config
        assertEquals(PairingCredentialKind.CHALLENGE, config.credentialKind)
        assertEquals("", config.token)
        assertEquals("challenge-001", config.challengeId)
        assertEquals("ABCD-EFGH", config.userCode)
    }

    @Test
    fun `rejects incomplete v2 challenge payloads`() {
        val result = PairingConfig.parse(
            "mathnotes://pair?v=2&host=100.92.105.105&port=4095" +
                "&challenge=challenge-001&transport=private_http"
        )

        assertEquals(PairingFailure.INVALID_CHALLENGE, (result as PairingParseResult.Failure).reason)
    }
}
