package com.mathnotes.capture.standalone

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class StandaloneProviderSecretStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    fun save(destination: String, providerId: String, model: String, secret: String) {
        require(secret.isNotBlank())
        val binding = binding(destination, providerId, model)
        val cipher = Cipher.getInstance(TRANSFORMATION).apply {
            init(Cipher.ENCRYPT_MODE, secretKey())
            updateAAD(binding.toByteArray(Charsets.UTF_8))
        }
        val encrypted = cipher.doFinal(secret.toByteArray(Charsets.UTF_8))
        preferences.edit().putString(binding, listOf(
            FORMAT_VERSION,
            Base64.encodeToString(cipher.iv, Base64.NO_WRAP),
            Base64.encodeToString(encrypted, Base64.NO_WRAP)
        ).joinToString(":")) .apply()
    }

    fun load(destination: String, providerId: String, model: String): String? {
        val binding = binding(destination, providerId, model)
        val payload = preferences.getString(binding, null) ?: return null
        val parts = payload.split(':')
        require(parts.size == 3 && parts[0] == FORMAT_VERSION) { "Unsupported provider credential" }
        val cipher = Cipher.getInstance(TRANSFORMATION).apply {
            init(
                Cipher.DECRYPT_MODE,
                secretKey(),
                GCMParameterSpec(128, Base64.decode(parts[1], Base64.NO_WRAP))
            )
            updateAAD(binding.toByteArray(Charsets.UTF_8))
        }
        return cipher.doFinal(Base64.decode(parts[2], Base64.NO_WRAP)).toString(Charsets.UTF_8)
    }

    private fun binding(destination: String, providerId: String, model: String): String =
        listOf(destination.trim().lowercase(), providerId.trim().lowercase(), model.trim()).joinToString("|")

    private fun secretKey(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
            init(KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build())
            generateKey()
        }
    }

    private companion object {
        const val PREFERENCES = "mathnotes_standalone_provider_secrets_v1"
        const val KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "mathnotes_standalone_provider_secrets_v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val FORMAT_VERSION = "v1"
    }
}
