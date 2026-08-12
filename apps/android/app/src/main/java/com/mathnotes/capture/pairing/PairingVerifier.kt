package com.mathnotes.capture.pairing

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant

class PairingVerifier(
    private val deviceLabel: String = "Android device",
    private val now: () -> Instant = { Instant.now() }
) {
    fun verify(config: PairingConfig): PairingVerificationResult {
        if (config.requiresExchange) return exchangeAndVerify(config)
        for (candidate in config.verificationCandidates()) {
            val result = verifyCandidate(candidate)
            if (result !is PairingVerificationResult.Unreachable) return result
        }
        return PairingVerificationResult.Unreachable
    }

    private fun exchangeAndVerify(config: PairingConfig): PairingVerificationResult {
        val expiresAt = runCatching { Instant.parse(config.challengeExpiresAt) }.getOrNull()
            ?: return PairingVerificationResult.ChallengeRejected("invalid_challenge")
        if (!expiresAt.isAfter(now())) return PairingVerificationResult.ChallengeRejected("challenge_expired")

        for (candidate in config.verificationCandidates()) {
            when (val exchange = exchangeCandidate(candidate)) {
                is PairingExchangeResult.Success -> return verify(exchange.config)
                PairingExchangeResult.Unreachable -> Unit
                is PairingExchangeResult.Rejected -> return PairingVerificationResult.ChallengeRejected(exchange.code)
            }
        }
        return PairingVerificationResult.Unreachable
    }

    private fun exchangeCandidate(config: PairingConfig): PairingExchangeResult {
        val payload = JSONObject()
            .put("challengeId", config.challengeId)
            .put("userCode", config.userCode)
            .put("deviceLabel", deviceLabel.trim().ifBlank { "Android device" })
            .toString()
            .toByteArray(Charsets.UTF_8)
        val connection = runCatching {
            (URL("${config.endpoint}/api/v2/pairing/exchange").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 1_800
                readTimeout = 2_500
                instanceFollowRedirects = false
                doOutput = true
                setFixedLengthStreamingMode(payload.size)
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "application/json")
            }
        }.getOrElse { return PairingExchangeResult.Unreachable }

        return try {
            connection.outputStream.use { it.write(payload) }
            val responseCode = connection.responseCode
            val stream = if (responseCode in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            val json = runCatching { JSONObject(body) }.getOrElse { JSONObject() }
            if (responseCode == 201) {
                val token = json.optString("token")
                val deviceId = json.optJSONObject("device")?.optString("deviceId").orEmpty()
                if (!token.matches(Regex("[A-Za-z0-9._~-]{16,256}")) || deviceId.isBlank()) {
                    PairingExchangeResult.Rejected("invalid_exchange_response")
                } else {
                    PairingExchangeResult.Success(config.withDeviceCredential(token, deviceId))
                }
            } else {
                PairingExchangeResult.Rejected(json.optString("error").ifBlank { "http_$responseCode" })
            }
        } catch (_: Exception) {
            PairingExchangeResult.Unreachable
        } finally {
            connection.disconnect()
        }
    }

    private fun verifyCandidate(config: PairingConfig): PairingVerificationResult {
        val connection = runCatching {
            (URL("${config.endpoint}/api/v1/pairing/verify").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 1_800
                readTimeout = 2_500
                instanceFollowRedirects = false
                setRequestProperty("Authorization", "Bearer ${config.token}")
                setRequestProperty("Accept", "application/json")
            }
        }.getOrElse { return PairingVerificationResult.Unreachable }

        return try {
            when (connection.responseCode) {
                200 -> {
                    val body = connection.inputStream.bufferedReader().use { it.readText() }
                    val json = JSONObject(body)
                    if (!json.optBoolean("ok") || json.optInt("version") != 1) {
                        PairingVerificationResult.Rejected(200)
                    } else {
                        val targets = json.optJSONArray("targets")?.let { array ->
                            (0 until array.length()).mapNotNull { index -> array.optJSONObject(index)?.toPairingTarget() }
                        }.orEmpty()
                        val active = json.optJSONObject("activeTarget")?.toPairingTarget()
                        val selected = targets.firstOrNull {
                            it.notebookId == config.notebookId && it.sessionId == config.sessionId
                        } ?: active?.let { candidate ->
                            targets.firstOrNull {
                                it.notebookId == candidate.notebookId && it.sessionId == candidate.sessionId
                            } ?: candidate
                        } ?: targets.firstOrNull()
                        if (selected == null) PairingVerificationResult.NoTargets
                        else PairingVerificationResult.Verified(config.withTarget(selected), targets.ifEmpty { listOf(selected) })
                    }
                }
                401, 403 -> PairingVerificationResult.Unauthorized
                else -> PairingVerificationResult.Rejected(connection.responseCode)
            }
        } catch (_: Exception) {
            PairingVerificationResult.Unreachable
        } finally {
            connection.disconnect()
        }
    }
}

private fun JSONObject.toPairingTarget(): PairingTarget? {
    val notebookId = optString("notebookId")
    val sessionId = optString("sessionId")
    if (notebookId.isBlank() || sessionId.isBlank()) return null
    return PairingTarget(
        notebookId = notebookId,
        sessionId = sessionId,
        title = optString("title").ifBlank { sessionId },
        notebookTitle = optString("notebookTitle").ifBlank { notebookId }
    )
}

sealed interface PairingVerificationResult {
    data class Verified(val config: PairingConfig, val targets: List<PairingTarget>) : PairingVerificationResult
    data object Unauthorized : PairingVerificationResult
    data object NoTargets : PairingVerificationResult
    data object Unreachable : PairingVerificationResult
    data class ChallengeRejected(val code: String) : PairingVerificationResult
    data class Rejected(val statusCode: Int) : PairingVerificationResult
}

private sealed interface PairingExchangeResult {
    data class Success(val config: PairingConfig) : PairingExchangeResult
    data object Unreachable : PairingExchangeResult
    data class Rejected(val code: String) : PairingExchangeResult
}

fun PairingVerificationResult.userMessage(): String = when (this) {
    is PairingVerificationResult.Verified -> "已连接到电脑"
    PairingVerificationResult.Unauthorized -> "配对令牌已失效，请重新生成二维码"
    PairingVerificationResult.NoTargets -> "电脑中还没有可接收照片的 Session"
    PairingVerificationResult.Unreachable -> "二维码已读取，但无法访问其中的电脑地址。请确认电脑接收服务已启动，并连接同一热点、USB 或可互访网络"
    is PairingVerificationResult.ChallengeRejected -> when (code) {
        "challenge_expired", "challenge_not_found" -> "配对二维码已过期，请在电脑端刷新二维码"
        "challenge_consumed" -> "这个配对二维码已经使用过，请在电脑端刷新二维码"
        "pairing_attempts_exhausted" -> "配对尝试次数过多，请在电脑端刷新二维码"
        else -> "设备配对未完成，请刷新电脑端二维码后重试"
    }
    is PairingVerificationResult.Rejected -> "电脑拒绝配对请求（HTTP $statusCode）"
}
