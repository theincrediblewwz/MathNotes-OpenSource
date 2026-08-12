package com.mathnotes.capture.pairing

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.time.Instant

data class PairingConfig(
    val version: Int,
    val host: String,
    val port: Int,
    val token: String,
    val notebookId: String = "",
    val sessionId: String = "",
    val transport: String,
    val targetTitle: String = "",
    val profileId: String = "",
    val computerLabel: String = "",
    val endpointUrl: String = "",
    val endpointKind: String = EndpointKind.LOCAL,
    val alternateHosts: List<String> = emptyList(),
    val credentialKind: String = PairingCredentialKind.LEGACY,
    val deviceId: String = "",
    val challengeId: String = "",
    val userCode: String = "",
    val challengeExpiresAt: String = ""
) {
    val endpoint: String get() = endpointUrl.ifBlank { "http://$host:$port" }.trimEnd('/')
    val endpointId: String get() = endpoint
    val hasTarget: Boolean get() = notebookId.isNotBlank() && sessionId.isNotBlank()
    val requiresExchange: Boolean get() = credentialKind == PairingCredentialKind.CHALLENGE
    internal val automaticConnectionPriority: Int get() = endpointPriority(host)

    fun redactedSummary(): String = if (hasTarget) {
        "${computerLabel.ifBlank { "$host:$port" }} · ${targetTitle.ifBlank { sessionId }}"
    } else "${computerLabel.ifBlank { "$host:$port" }} · 尚未选择笔记"

    fun withTarget(target: PairingTarget): PairingConfig = copy(
        notebookId = target.notebookId,
        sessionId = target.sessionId,
        targetTitle = target.title
    )

    fun withDeviceCredential(token: String, deviceId: String): PairingConfig = copy(
        version = 2,
        token = token,
        credentialKind = PairingCredentialKind.DEVICE,
        deviceId = deviceId,
        challengeId = "",
        userCode = "",
        challengeExpiresAt = ""
    )

    fun verificationCandidates(): List<PairingConfig> {
        if (endpointUrl.isNotBlank()) return listOf(this)
        return (listOf(host) + alternateHosts)
            .distinct()
            .sortedBy(::endpointPriority)
            .take(6)
            .map { candidateHost ->
                copy(
                    host = candidateHost,
                    endpointUrl = "",
                    endpointKind = endpointKindForHost(candidateHost)
                )
            }
    }

    companion object {
        fun parse(payload: String): PairingParseResult {
            val uri = runCatching { URI(payload.trim()) }.getOrNull()
                ?: return PairingParseResult.Failure(PairingFailure.MALFORMED_PAYLOAD)
            if (uri.scheme != "mathnotes" || uri.host != "pair") {
                return PairingParseResult.Failure(PairingFailure.MALFORMED_PAYLOAD)
            }
            val params = parseQuery(uri.rawQuery ?: "")
            val version = params["v"]?.toIntOrNull()
            if (version != 1 && version != 2) return PairingParseResult.Failure(PairingFailure.UNSUPPORTED_VERSION)
            if (params["transport"] != "private_http" && params["transport"] != "tailnet_http") {
                return PairingParseResult.Failure(PairingFailure.UNSUPPORTED_TRANSPORT)
            }
            val host = params["host"] ?: return PairingParseResult.Failure(PairingFailure.NUMERIC_IPV4_REQUIRED)
            val octets = parseIpv4(host) ?: return PairingParseResult.Failure(PairingFailure.NUMERIC_IPV4_REQUIRED)
            if (octets[0] == 127) return PairingParseResult.Failure(PairingFailure.UNREACHABLE_LOOPBACK)
            if (!isPrivateAddress(octets) && !isTailnetAddress(octets)) {
                return PairingParseResult.Failure(PairingFailure.PRIVATE_ADDRESS_REQUIRED)
            }
            val alternateHosts = params["hosts"].orEmpty()
                .split(',')
                .filter { it.isNotBlank() && it != host }
                .distinct()
                .take(5)
            if (alternateHosts.any { candidate ->
                    val candidateOctets = parseIpv4(candidate)
                    candidateOctets == null || candidateOctets[0] == 127 ||
                        (!isPrivateAddress(candidateOctets) && !isTailnetAddress(candidateOctets))
                }) {
                return PairingParseResult.Failure(PairingFailure.PRIVATE_ADDRESS_REQUIRED)
            }
            val port = params["port"]?.toIntOrNull()?.takeIf { it in 1..65535 }
                ?: return PairingParseResult.Failure(PairingFailure.INVALID_PORT)
            val token = params["token"].orEmpty()
            val challengeId = params["challenge"].orEmpty()
            val userCode = params["code"].orEmpty().uppercase()
            val expiresAt = params["expires"].orEmpty()
            if (version == 1 && !token.matches(Regex("[A-Za-z0-9._~-]{16,256}"))) {
                return PairingParseResult.Failure(PairingFailure.INVALID_TOKEN)
            }
            if (version == 2 && (
                    !challengeId.matches(Regex("[A-Za-z0-9._~-]{8,256}")) ||
                        !userCode.matches(Regex("[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}")) ||
                        runCatching { Instant.parse(expiresAt) }.isFailure
                    )) {
                return PairingParseResult.Failure(PairingFailure.INVALID_CHALLENGE)
            }
            val notebookId = params["notebook"].orEmpty()
            val sessionId = params["session"].orEmpty()
            if ((notebookId.isBlank() xor sessionId.isBlank()) ||
                (notebookId.isNotBlank() && (!isSafeId(notebookId) || !isSafeId(sessionId)))) {
                return PairingParseResult.Failure(PairingFailure.INVALID_TARGET)
            }
            return PairingParseResult.Success(
                PairingConfig(
                    version = version,
                    host = host,
                    port = port,
                    token = token,
                    notebookId = notebookId,
                    sessionId = sessionId,
                    transport = params["transport"].orEmpty().ifBlank { "private_http" },
                    targetTitle = sessionId,
                    endpointKind = if (isTailnetAddress(octets)) EndpointKind.TAILNET else EndpointKind.LOCAL,
                    alternateHosts = alternateHosts,
                    credentialKind = if (version == 2) PairingCredentialKind.CHALLENGE else PairingCredentialKind.LEGACY,
                    challengeId = challengeId,
                    userCode = userCode,
                    challengeExpiresAt = expiresAt
                )
            )
        }

        fun fromManual(endpoint: String, token: String): PairingParseResult {
            val raw = endpoint.trim().trimEnd('/')
            val normalized = if (raw.contains("://")) raw else "http://$raw"
            val uri = runCatching { URI(normalized) }.getOrNull()
                ?: return PairingParseResult.Failure(PairingFailure.MALFORMED_PAYLOAD)
            if (uri.scheme != "http" && uri.scheme != "https") {
                return PairingParseResult.Failure(PairingFailure.UNSUPPORTED_TRANSPORT)
            }
            val host = uri.host.orEmpty()
            if (host.isBlank() || uri.rawPath.orEmpty().let { it.isNotBlank() && it != "/" }) {
                return PairingParseResult.Failure(PairingFailure.MALFORMED_PAYLOAD)
            }
            val port = if (uri.port > 0) uri.port else if (uri.scheme == "https") 443 else 80
            if (port !in 1..65535) return PairingParseResult.Failure(PairingFailure.INVALID_PORT)
            val cleanToken = token.trim()
            if (!cleanToken.matches(Regex("[A-Za-z0-9._~-]{16,256}"))) {
                return PairingParseResult.Failure(PairingFailure.INVALID_TOKEN)
            }
            val octets = parseIpv4(host)
            if (uri.scheme == "http") {
                if (octets == null) return PairingParseResult.Failure(PairingFailure.PRIVATE_ADDRESS_REQUIRED)
                if (octets[0] == 127) return PairingParseResult.Failure(PairingFailure.UNREACHABLE_LOOPBACK)
                if (!isPrivateAddress(octets) && !isTailnetAddress(octets)) {
                    return PairingParseResult.Failure(PairingFailure.PRIVATE_ADDRESS_REQUIRED)
                }
            }
            val kind = when {
                uri.scheme == "https" -> EndpointKind.TUNNEL
                octets != null && isTailnetAddress(octets) -> EndpointKind.TAILNET
                else -> EndpointKind.LOCAL
            }
            return PairingParseResult.Success(
                PairingConfig(
                    version = 1,
                    host = host,
                    port = port,
                    token = cleanToken,
                    transport = when (kind) {
                        EndpointKind.TAILNET -> "tailnet_http"
                        EndpointKind.TUNNEL -> "https_tunnel"
                        else -> "private_http"
                    },
                    computerLabel = host,
                    endpointUrl = normalized,
                    endpointKind = kind
                )
            )
        }

        private fun parseQuery(query: String): Map<String, String> = query.split('&')
            .mapNotNull { part ->
                val separator = part.indexOf('=')
                if (separator <= 0) null
                else decode(part.substring(0, separator)) to decode(part.substring(separator + 1))
            }
            .toMap()

        private fun parseIpv4(host: String): IntArray? {
            val parts = host.split('.')
            if (parts.size != 4) return null
            val values = parts.map { it.toIntOrNull()?.takeIf { value -> value in 0..255 } ?: return null }
            if (parts.zip(values).any { (raw, value) -> raw != value.toString() }) return null
            return values.toIntArray()
        }

        private fun isPrivateAddress(ip: IntArray): Boolean = isRfc1918Address(ip) || isLinkLocalAddress(ip)

        private fun isRfc1918Address(ip: IntArray): Boolean =
            ip[0] == 10 ||
                (ip[0] == 172 && ip[1] in 16..31) ||
                (ip[0] == 192 && ip[1] == 168)

        private fun isLinkLocalAddress(ip: IntArray): Boolean = ip[0] == 169 && ip[1] == 254

        private fun isTailnetAddress(ip: IntArray): Boolean =
            ip[0] == 100 && ip[1] in 64..127

        private fun isSafeId(value: String): Boolean = value.matches(Regex("[A-Za-z0-9._-]{1,128}"))
        private fun endpointKindForHost(host: String): String {
            val octets = parseIpv4(host)
            return if (octets != null && isTailnetAddress(octets)) EndpointKind.TAILNET else EndpointKind.LOCAL
        }
        private fun endpointPriority(host: String): Int {
            val octets = parseIpv4(host) ?: return 3
            return when {
                isTailnetAddress(octets) -> 0
                isRfc1918Address(octets) -> 1
                isLinkLocalAddress(octets) -> 2
                else -> 3
            }
        }
        private fun encode(value: String): String = URLEncoder.encode(value, StandardCharsets.UTF_8)
        private fun decode(value: String): String = URLDecoder.decode(value, StandardCharsets.UTF_8)
    }
}

object EndpointKind {
    const val LOCAL = "local"
    const val TAILNET = "tailnet"
    const val TUNNEL = "https_tunnel"
}

object PairingCredentialKind {
    const val LEGACY = "legacy"
    const val CHALLENGE = "challenge"
    const val DEVICE = "device"
}

data class PairingTarget(
    val notebookId: String,
    val sessionId: String,
    val title: String,
    val notebookTitle: String = notebookId
)

sealed interface PairingParseResult {
    data class Success(val config: PairingConfig) : PairingParseResult
    data class Failure(val reason: PairingFailure) : PairingParseResult
}

enum class PairingFailure(val code: String, val userMessage: String) {
    MALFORMED_PAYLOAD("malformed_payload", "二维码内容不是 MathNotes 配对信息"),
    UNSUPPORTED_VERSION("unsupported_version", "配对信息版本不受支持"),
    UNSUPPORTED_TRANSPORT("unsupported_transport", "当前仅支持私有网络连接"),
    NUMERIC_IPV4_REQUIRED("numeric_ipv4_required", "请输入电脑的数字 IPv4 地址"),
    UNREACHABLE_LOOPBACK("unreachable_loopback", "手机不能使用电脑的 127.0.0.1 地址"),
    PRIVATE_ADDRESS_REQUIRED("private_address_required", "HTTP 只允许热点、USB、可信局域网或 Tailscale 地址；公网请使用 HTTPS 隧道"),
    INVALID_PORT("invalid_port", "端口无效"),
    INVALID_TOKEN("invalid_token", "配对令牌无效"),
    INVALID_CHALLENGE("invalid_challenge", "配对二维码已损坏或缺少一次性授权信息"),
    INVALID_TARGET("invalid_target", "Notebook 或 Session 标识无效")
}
