package com.mathnotes.capture.pairing

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import java.net.ServerSocket
import java.net.Socket
import java.net.InetSocketAddress
import java.time.Instant
import kotlin.concurrent.thread

class PairingVerifierTest {
    private lateinit var server: ServerSocket
    private lateinit var serverThread: Thread
    private lateinit var config: PairingConfig

    @Before
    fun setUp() {
        server = ServerSocket()
        server.bind(InetSocketAddress("127.0.0.1", 0))
        serverThread = thread(name = "pairing-verifier-test-server") {
            while (!server.isClosed) {
                runCatching { server.accept() }.getOrNull()?.use(::respond)
            }
        }
        config = PairingConfig(
            version = 1,
            host = "127.0.0.1",
            port = server.localPort,
            token = "0123456789abcdef",
            notebookId = "functional_analysis",
            sessionId = "lecture",
            transport = "private_http"
        )
    }

    @After
    fun tearDown() {
        server.close()
        serverThread.join(1_000)
    }

    @Test
    fun `verifies bearer token and active target`() {
        val result = PairingVerifier().verify(config)
        assertEquals("lecture", (result as PairingVerificationResult.Verified).config.sessionId)
        assertEquals("泛函分析 第 3 讲", result.targets.single().title)
    }

    @Test
    fun `separates invalid token from reachability failures`() {
        assertEquals(
            PairingVerificationResult.Unauthorized,
            PairingVerifier().verify(config.copy(token = "fedcba9876543210"))
        )
    }

    @Test
    fun `falls back to an alternate host when the primary address is unreachable`() {
        val result = PairingVerifier().verify(
            config.copy(host = "127.0.0.2", alternateHosts = listOf("127.0.0.1"))
        )

        assertEquals("127.0.0.1", (result as PairingVerificationResult.Verified).config.host)
    }

    @Test
    fun `exchanges a v2 challenge before verifying with the device token`() {
        val result = PairingVerifier(
            deviceLabel = "Pixel Test",
            now = { Instant.parse("2026-07-25T08:00:00.000Z") }
        ).verify(
            config.copy(
                version = 2,
                token = "",
                credentialKind = PairingCredentialKind.CHALLENGE,
                challengeId = "challenge-001",
                userCode = "ABCD-EFGH",
                challengeExpiresAt = "2026-07-25T08:10:00.000Z"
            )
        )

        val verified = result as PairingVerificationResult.Verified
        assertEquals(PairingCredentialKind.DEVICE, verified.config.credentialKind)
        assertEquals("device-001", verified.config.deviceId)
        assertEquals("device-token-0123456789abcdef", verified.config.token)
    }

    @Test
    fun `rejects an expired challenge without network exchange`() {
        val result = PairingVerifier(now = { Instant.parse("2026-07-25T08:11:00.000Z") }).verify(
            config.copy(
                version = 2,
                token = "",
                credentialKind = PairingCredentialKind.CHALLENGE,
                challengeId = "challenge-001",
                userCode = "ABCD-EFGH",
                challengeExpiresAt = "2026-07-25T08:10:00.000Z"
            )
        )

        assertEquals(PairingVerificationResult.ChallengeRejected("challenge_expired"), result)
    }

    private fun respond(socket: Socket) {
        val reader = socket.getInputStream().bufferedReader()
        val requestLine = reader.readLine()
        val headers = generateSequence { reader.readLine() }
            .takeWhile { it.isNotEmpty() }
            .toList()
        val contentLength = headers.firstOrNull { it.startsWith("Content-Length:", true) }
            ?.substringAfter(':')?.trim()?.toIntOrNull() ?: 0
        val requestBody = if (contentLength > 0) CharArray(contentLength).also { reader.read(it) }.concatToString() else ""
        if (requestLine.orEmpty().startsWith("POST /api/v2/pairing/exchange")) {
            val valid = requestBody.contains("\"challengeId\":\"challenge-001\"") &&
                requestBody.contains("\"deviceLabel\":\"Pixel Test\"")
            writeResponse(
                socket,
                if (valid) "201 Created" else "400 Bad Request",
                if (valid) {
                    """{"device":{"version":1,"deviceId":"device-001","label":"Pixel Test","scopes":["companion.read","material.upload"],"createdAt":"2026-07-25T08:00:00.000Z"},"token":"device-token-0123456789abcdef"}"""
                } else """{"error":"pairing_code_invalid"}"""
            )
            return
        }
        val authorized = headers.any {
            it.equals("Authorization: Bearer 0123456789abcdef", true) ||
                it.equals("Authorization: Bearer device-token-0123456789abcdef", true)
        }
        val status = if (authorized) "200 OK" else "401 Unauthorized"
        val body = if (authorized) {
            """{"ok":true,"version":1,"activeTarget":{"notebookId":"functional_analysis","notebookTitle":"泛函分析","sessionId":"lecture","title":"泛函分析 第 3 讲"},"targets":[{"notebookId":"functional_analysis","notebookTitle":"泛函分析","sessionId":"lecture","title":"泛函分析 第 3 讲"}]}"""
        } else {
            """{"error":"unauthorized"}"""
        }
        writeResponse(socket, status, body)
    }

    private fun writeResponse(socket: Socket, status: String, body: String) {
        socket.getOutputStream().bufferedWriter().use { writer ->
            writer.write("HTTP/1.1 $status\r\n")
            writer.write("Content-Type: application/json\r\n")
            writer.write("Content-Length: ${body.toByteArray().size}\r\n")
            writer.write("Connection: close\r\n\r\n")
            writer.write(body)
        }
    }
}
