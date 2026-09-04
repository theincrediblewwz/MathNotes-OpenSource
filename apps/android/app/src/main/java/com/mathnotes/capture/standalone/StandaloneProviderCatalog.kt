package com.mathnotes.capture.standalone

import java.net.URI

internal enum class StandaloneProviderAdapter { RESPONSES, CHAT_COMPLETIONS }
internal enum class StandaloneProviderAuth { BEARER, API_KEY }

internal data class StandaloneProviderDescriptor(
    val providerId: String,
    val label: String,
    val defaultModel: String,
    val defaultBaseUrl: String,
    val adapter: StandaloneProviderAdapter,
    val auth: StandaloneProviderAuth,
    val customEndpoint: Boolean = false
)

internal object StandaloneProviderCatalog {
    val recognitionProviders: List<StandaloneProviderDescriptor> = listOf(
        StandaloneProviderDescriptor(
            providerId = "deepseek",
            label = "DeepSeek",
            defaultModel = "deepseek-v4-flash-exp",
            defaultBaseUrl = "https://api.deepseek.com",
            adapter = StandaloneProviderAdapter.CHAT_COMPLETIONS,
            auth = StandaloneProviderAuth.BEARER
        ),
        StandaloneProviderDescriptor(
            providerId = "openai_vision",
            label = "OpenAI Vision",
            defaultModel = "gpt-4.1-mini",
            defaultBaseUrl = "https://api.openai.com/v1",
            adapter = StandaloneProviderAdapter.RESPONSES,
            auth = StandaloneProviderAuth.BEARER
        ),
        StandaloneProviderDescriptor(
            providerId = "glm_5_2",
            label = "GLM",
            defaultModel = "glm-5.2",
            defaultBaseUrl = "https://api.z.ai/api/paas/v4/chat/completions",
            adapter = StandaloneProviderAdapter.CHAT_COMPLETIONS,
            auth = StandaloneProviderAuth.BEARER
        ),
        StandaloneProviderDescriptor(
            providerId = "mimo_2_5",
            label = "MiMo",
            defaultModel = "mimo-v2.5",
            defaultBaseUrl = "https://api.xiaomimimo.com/v1",
            adapter = StandaloneProviderAdapter.CHAT_COMPLETIONS,
            auth = StandaloneProviderAuth.API_KEY
        ),
        StandaloneProviderDescriptor(
            providerId = "gemini",
            label = "Gemini",
            defaultModel = "gemini-2.5-flash",
            defaultBaseUrl = "https://generativelanguage.googleapis.com/v1beta/openai",
            adapter = StandaloneProviderAdapter.CHAT_COMPLETIONS,
            auth = StandaloneProviderAuth.BEARER
        ),
        StandaloneProviderDescriptor(
            providerId = "qwen",
            label = "Qwen",
            defaultModel = "qwen3.7-plus",
            defaultBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1",
            adapter = StandaloneProviderAdapter.CHAT_COMPLETIONS,
            auth = StandaloneProviderAuth.BEARER
        ),
        StandaloneProviderDescriptor(
            providerId = StandaloneProviderProfileStore.PROVIDER_ID,
            label = "自定义 OpenAI Compatible",
            defaultModel = "",
            defaultBaseUrl = "",
            adapter = StandaloneProviderAdapter.CHAT_COMPLETIONS,
            auth = StandaloneProviderAuth.BEARER,
            customEndpoint = true
        )
    )

    fun descriptor(providerId: String): StandaloneProviderDescriptor? =
        recognitionProviders.firstOrNull { it.providerId == providerId }

    fun requireDescriptor(providerId: String): StandaloneProviderDescriptor =
        requireNotNull(descriptor(providerId)) { "Android 不支持这个识别服务" }

    fun normalizeModel(providerId: String, value: String): String {
        val descriptor = requireDescriptor(providerId)
        return value.trim().ifBlank { descriptor.defaultModel }
            .also { require(it.isNotBlank()) { "模型名称不能为空" } }
    }

    fun destination(providerId: String, customBaseUrl: String = ""): String {
        val descriptor = requireDescriptor(providerId)
        val baseUrl = if (descriptor.customEndpoint) customBaseUrl else descriptor.defaultBaseUrl
        val normalized = normalizeHttpsBaseUrl(baseUrl)
        return when (descriptor.adapter) {
            StandaloneProviderAdapter.RESPONSES -> appendPath(normalized, "responses")
            StandaloneProviderAdapter.CHAT_COMPLETIONS -> appendPath(normalized, "chat/completions")
        }
    }

    fun requestHeaders(providerId: String, apiKey: String): Map<String, String> =
        when (requireDescriptor(providerId).auth) {
            StandaloneProviderAuth.API_KEY -> mapOf("api-key" to apiKey, "Content-Type" to "application/json")
            StandaloneProviderAuth.BEARER -> mapOf("Authorization" to "Bearer $apiKey", "Content-Type" to "application/json")
        }

    fun displayLabel(providerId: String): String = descriptor(providerId)?.label ?: "本机识别"

    private fun normalizeHttpsBaseUrl(value: String): String {
        val trimmed = value.trim().trimEnd('/')
        require(trimmed.isNotBlank()) { "请求地址不能为空" }
        val uri = runCatching { URI(trimmed) }.getOrNull()
            ?: throw IllegalArgumentException("请求地址无效")
        val host = uri.host.orEmpty().lowercase()
        val loopback = host == "127.0.0.1" || host == "localhost" || host == "10.0.2.2"
        require(uri.scheme.equals("https", ignoreCase = true) || (uri.scheme.equals("http", ignoreCase = true) && loopback)) {
            "真实 Provider 必须使用 HTTPS；HTTP 仅允许本机测试地址"
        }
        return trimmed
    }

    private fun appendPath(baseUrl: String, suffix: String): String =
        if (baseUrl.endsWith("/$suffix", ignoreCase = true)) baseUrl else "$baseUrl/$suffix"
}
