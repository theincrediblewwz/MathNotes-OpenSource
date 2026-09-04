package com.mathnotes.capture.standalone

import android.content.Context

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
        return save(PROVIDER_ID, destination, model, apiKey)
    }

    fun save(providerId: String, baseUrl: String, model: String, apiKey: String): StandaloneProviderProfile {
        val normalizedDestination = StandaloneProviderCatalog.destination(providerId, baseUrl)
        val normalizedModel = StandaloneProviderCatalog.normalizeModel(providerId, model)
        val normalizedKey = apiKey.trim().ifBlank {
            secrets.load(normalizedDestination, providerId, normalizedModel)
                ?: throw IllegalArgumentException("API Key 不能为空")
        }
        secrets.save(normalizedDestination, providerId, normalizedModel, normalizedKey)
        preferences.edit()
            .putString("providerId", providerId)
            .putString("destination", normalizedDestination)
            .putString("model", normalizedModel)
            .putBoolean("enabled", true)
            .apply()
        return StandaloneProviderProfile(providerId, normalizedDestination, normalizedModel, true, true)
    }

    fun useFake() {
        preferences.edit().putBoolean("enabled", false).apply()
    }

    fun secret(profile: StandaloneProviderProfile): String =
        requireNotNull(secrets.load(profile.destination, profile.providerId, profile.model)) { "API Key 无法解密，请重新输入" }

    companion object {
        const val PROVIDER_ID = "custom_openai_compatible"

        fun normalizeDestination(value: String): String =
            StandaloneProviderCatalog.destination(PROVIDER_ID, value)

        private const val PREFERENCES = "mathnotes_standalone_provider_profile_v1"
    }
}
