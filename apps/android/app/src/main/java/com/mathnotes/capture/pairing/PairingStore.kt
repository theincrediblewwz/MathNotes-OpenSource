package com.mathnotes.capture.pairing

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

class PairingStore(
    context: Context,
    private val credentialProtector: PairingCredentialProtector = AndroidKeystorePairingCredentialProtector(),
    private val idFactory: () -> String = { UUID.randomUUID().toString() }
) {
    private val preferences = context.getSharedPreferences("paired_pc", Context.MODE_PRIVATE)

    fun load(): PairingConfig? {
        migrateLegacyProfile()
        val profiles = readProfiles()
        val activeId = preferences.getString(ACTIVE_PROFILE_KEY, null)
        return profiles.firstOrNull { it.profileId == activeId } ?: profiles.firstOrNull()
    }

    fun load(profileId: String): PairingConfig? {
        migrateLegacyProfile()
        return readProfiles().firstOrNull { it.profileId == profileId }
    }

    fun list(): List<PairingConfig> {
        migrateLegacyProfile()
        return readProfiles()
    }

    fun endpointCandidates(config: PairingConfig): List<PairingConfig> {
        migrateLegacyProfile()
        val requestedProfileId = config.profileId.ifBlank { config.endpointId }
        val requestedTarget = PairingTarget(config.notebookId, config.sessionId, config.targetTitle)
        val candidates = buildList {
            config.verificationCandidates().forEach { add(it.copy(profileId = requestedProfileId)) }
            readProfiles()
                .asSequence()
                .filter { it.token == config.token && it.endpointId != config.endpointId }
                .forEach { candidate ->
                    add(
                        candidate.copy(
                            profileId = requestedProfileId,
                            notebookId = requestedTarget.notebookId,
                            sessionId = requestedTarget.sessionId,
                            targetTitle = requestedTarget.title
                        )
                    )
                }
        }.distinctBy { it.endpointId }
        return if (config.endpointUrl.isNotBlank()) {
            candidates
        } else {
            candidates.sortedBy { it.automaticConnectionPriority }
        }
    }

    fun save(config: PairingConfig): Boolean {
        migrateLegacyProfile()
        if (config.token.isBlank() || config.requiresExchange) return false
        val profiles = readProfiles().toMutableList()
        val existingIndex = profiles.indexOfFirst {
            (config.profileId.isNotBlank() && it.profileId == config.profileId) ||
                it.endpointId == config.endpointId
        }
        val profileId = when {
            config.profileId.isNotBlank() -> config.profileId
            existingIndex >= 0 -> profiles[existingIndex].profileId
            else -> idFactory()
        }
        val stored = config.copy(
            profileId = profileId,
            computerLabel = config.computerLabel.ifBlank { "${config.host}:${config.port}" }
        )
        if (existingIndex >= 0) profiles[existingIndex] = stored else profiles += stored
        return writeProfiles(profiles, profileId)
    }

    fun activate(profileId: String): Boolean {
        migrateLegacyProfile()
        if (readProfiles().none { it.profileId == profileId }) return false
        return preferences.edit().putString(ACTIVE_PROFILE_KEY, profileId).commit()
    }

    fun remove(profileId: String): Boolean {
        migrateLegacyProfile()
        val remaining = readProfiles().filterNot { it.profileId == profileId }
        val activeId = preferences.getString(ACTIVE_PROFILE_KEY, null)
        val nextActive = if (activeId == profileId) remaining.firstOrNull()?.profileId else activeId
        return writeProfiles(remaining, nextActive)
    }

    fun clear(): Boolean = preferences.edit().clear().commit()

    fun findForCapture(profileId: String, endpointId: String): PairingConfig? {
        migrateLegacyProfile()
        return readProfiles().firstOrNull { it.profileId == profileId }
            ?: readProfiles().firstOrNull { it.endpointId == endpointId || "${it.host}:${it.port}" == endpointId }
    }

    private fun migrateLegacyProfile() {
        if (preferences.contains(PROFILES_KEY)) return
        if (preferences.contains(LEGACY_PROFILES_KEY)) {
            val legacyProfiles = readProfiles(LEGACY_PROFILES_KEY, plaintextToken = true)
            val activeId = preferences.getString(ACTIVE_PROFILE_KEY, null)
            if (legacyProfiles.isNotEmpty()) writeProfiles(legacyProfiles, activeId)
            return
        }
        val host = preferences.getString("host", null) ?: run {
            preferences.edit().putString(PROFILES_KEY, "[]").commit()
            return
        }
        val token = preferences.getString("token", null) ?: return
        val port = preferences.getInt("port", -1)
        if (port !in 1..65535) return
        val profileId = idFactory()
        val legacy = PairingConfig(
            version = 1,
            host = host,
            port = port,
            token = token,
            notebookId = preferences.getString("notebook", "").orEmpty(),
            sessionId = preferences.getString("session", "").orEmpty(),
            transport = "private_http",
            targetTitle = preferences.getString("target_title", "").orEmpty(),
            profileId = profileId,
            computerLabel = "$host:$port"
        )
        writeProfiles(listOf(legacy), profileId)
    }

    private fun readProfiles(): List<PairingConfig> = readProfiles(PROFILES_KEY, plaintextToken = false)

    private fun readProfiles(key: String, plaintextToken: Boolean): List<PairingConfig> {
        val raw = preferences.getString(key, "[]").orEmpty()
        return runCatching {
            val array = JSONArray(raw)
            buildList {
                for (index in 0 until array.length()) {
                    val item = array.getJSONObject(index)
                    add(
                        PairingConfig(
                            version = item.optInt("version", 1),
                            host = item.getString("host"),
                            port = item.getInt("port"),
                            token = if (plaintextToken) {
                                item.getString("token")
                            } else {
                                credentialProtector.unprotect(item.getString("tokenCiphertext"))
                            },
                            notebookId = item.optString("notebookId"),
                            sessionId = item.optString("sessionId"),
                            transport = item.optString("transport", "private_http"),
                            targetTitle = item.optString("targetTitle"),
                            profileId = item.getString("profileId"),
                            computerLabel = item.optString("computerLabel"),
                            endpointUrl = item.optString("endpointUrl"),
                            endpointKind = item.optString("endpointKind", EndpointKind.LOCAL),
                            alternateHosts = item.optJSONArray("alternateHosts")?.let { hosts ->
                                buildList {
                                    for (hostIndex in 0 until hosts.length()) add(hosts.optString(hostIndex))
                                }.filter(String::isNotBlank)
                            }.orEmpty(),
                            credentialKind = item.optString("credentialKind", PairingCredentialKind.LEGACY),
                            deviceId = item.optString("deviceId")
                        )
                    )
                }
            }
        }.getOrDefault(emptyList())
    }

    private fun writeProfiles(profiles: List<PairingConfig>, activeId: String?): Boolean {
        val array = runCatching {
            JSONArray().also { output ->
                profiles.forEach { config ->
                    output.put(
                        JSONObject()
                            .put("version", config.version)
                            .put("host", config.host)
                            .put("port", config.port)
                            .put("tokenCiphertext", credentialProtector.protect(config.token))
                            .put("notebookId", config.notebookId)
                            .put("sessionId", config.sessionId)
                            .put("transport", config.transport)
                            .put("targetTitle", config.targetTitle)
                            .put("profileId", config.profileId)
                            .put("computerLabel", config.computerLabel)
                            .put("endpointUrl", config.endpointUrl)
                            .put("endpointKind", config.endpointKind)
                            .put("alternateHosts", JSONArray(config.alternateHosts))
                            .put("credentialKind", config.credentialKind)
                            .put("deviceId", config.deviceId)
                    )
                }
            }
        }.getOrElse { return false }
        val editor = preferences.edit()
            .putString(PROFILES_KEY, array.toString())
            .remove(LEGACY_PROFILES_KEY)
            .remove("host")
            .remove("port")
            .remove("token")
            .remove("notebook")
            .remove("session")
            .remove("target_title")
        if (activeId == null) editor.remove(ACTIVE_PROFILE_KEY) else editor.putString(ACTIVE_PROFILE_KEY, activeId)
        return editor.commit()
    }

    companion object {
        private const val PROFILES_KEY = "profiles_v3"
        private const val LEGACY_PROFILES_KEY = "profiles_v2"
        private const val ACTIVE_PROFILE_KEY = "active_profile_id"
    }
}
