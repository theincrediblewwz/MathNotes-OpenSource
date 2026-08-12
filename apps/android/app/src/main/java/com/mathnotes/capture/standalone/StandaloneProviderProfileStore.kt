package com.mathnotes.capture.standalone

import android.content.Context
import android.net.Uri

data class StandaloneProviderProfile(
    val providerId: String,
    val destination: String,
    val model: String,
    val enabled: Boolean,
    val hasSecret: Boolean
)

internal class StandaloneProviderProfileStore(context: Context) {
    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val secrets = StandaloneProviderSecretStore(appContext)

    fun load(): StandaloneProviderProfile? {
        val destination = preferences.getString("destination", null) ?: return null
        val providerId = preferences.getString("providerId", PROVIDER_ID) ?: PROVIDER_ID
        val model = preferences.getString("model", null) ?: return null
        return StandaloneProviderProfile(
            providerId = providerId,
            destination = destination,
            model = model,
            enabled = preferences.getBoolean("enabled", false),
            hasSecret = runCatching { secrets.load(destination, providerId, model) != null }.getOrDefault(false)
        )
    }

    fun save(destination: String, model: String, apiKey: String): StandaloneProviderProfile {
        val normalizedDestination = normalizeDestination(destination)
        val normalizedModel = model.trim().also { require(it.isNotBlank()) { "模型名称不能为空" } }
        require(apiKey.isNotBlank()) { "API Key 不能为空" }
        secrets.save(normalizedDestination, PROVIDER_ID, normalizedModel, apiKey.trim())
        preferences.edit()
            .putString("providerId", PROVIDER_ID)
            .putString("destination", normalizedDestination)
            .putString("model", normalizedModel)
            .putBoolean("enabled", true)
            .apply()
        return StandaloneProviderProfile(PROVIDER_ID, normalizedDestination, normalizedModel, true, true)
    }

    fun useFake() {
        preferences.edit().putBoolean("enabled", false).apply()
    }

    fun secret(profile: StandaloneProviderProfile): String =
        requireNotNull(secrets.load(profile.destination, profile.providerId, profile.model)) { "API Key 无法解密，请重新输入" }

    companion object {
        const val PROVIDER_ID = "custom_openai_compatible"

        fun normalizeDestination(value: String): String {
            val trimmed = value.trim().trimEnd('/')
            require(trimmed.isNotBlank()) { "Endpoint 不能为空" }
            val uri = Uri.parse(trimmed)
            val loopback = uri.host == "127.0.0.1" || uri.host == "localhost" || uri.host == "10.0.2.2"
            require(uri.scheme == "https" || (uri.scheme == "http" && loopback)) {
                "真实 Provider 必须使用 HTTPS；HTTP 仅允许本机测试地址"
            }
            return if (trimmed.endsWith("/chat/completions", ignoreCase = true)) trimmed else "$trimmed/chat/completions"
        }

        private const val PREFERENCES = "mathnotes_standalone_provider_profile_v1"
    }
}
