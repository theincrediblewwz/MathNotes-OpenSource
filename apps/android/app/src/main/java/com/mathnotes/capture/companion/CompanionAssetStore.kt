package com.mathnotes.capture.companion

import android.content.Context
import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.pairing.PairingTarget
import java.io.File
import java.security.MessageDigest

data class CachedCompanionAsset(
    val file: File,
    val mimeType: String
)

class CompanionAssetStore(context: Context) {
    private val root = File(context.applicationContext.filesDir, "companion-assets")

    fun write(
        pairing: PairingConfig,
        target: PairingTarget,
        asset: CompanionSessionAsset,
        bytes: ByteArray,
        mimeType: String
    ) {
        val key = cacheKey(pairing, target, asset.id)
        root.mkdirs()
        val data = File(root, "$key.bin")
        val metadata = File(root, "$key.mime")
        val digestFile = File(root, "$key.sha256")
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val effectiveMimeType = mimeType.ifBlank { asset.mimeType }
        if (data.isFile && digestFile.takeIf(File::isFile)?.readText() == digest &&
            metadata.takeIf(File::isFile)?.readText() == effectiveMimeType) return
        val temporary = File(root, "$key.tmp")
        temporary.outputStream().use { output ->
            output.write(bytes)
            output.fd.sync()
        }
        if (data.exists()) data.delete()
        check(temporary.renameTo(data)) { "无法保存同步素材" }
        metadata.writeText(effectiveMimeType, Charsets.UTF_8)
        digestFile.writeText(digest, Charsets.UTF_8)
    }

    /** Only assets used by this document participate; a 304 or unchanged payload is stable. */
    fun contentRevision(pairing: PairingConfig, target: PairingTarget, assetIds: List<String>): String =
        assetIds.distinct().sorted().joinToString("|") { id ->
            val key = cacheKey(pairing, target, id)
            val data = File(root, "$key.bin")
            val digest = File(root, "$key.sha256")
            val revision = if (!data.isFile) "missing" else if (digest.isFile) digest.readText() else "${data.length()}:${data.lastModified()}"
            "$id:$revision"
        }

    fun read(pairing: PairingConfig, target: PairingTarget, assetId: String): CachedCompanionAsset? {
        val key = cacheKey(pairing, target, assetId)
        val data = File(root, "$key.bin")
        if (!data.isFile) return null
        val mimeType = File(root, "$key.mime")
            .takeIf(File::isFile)
            ?.readText(Charsets.UTF_8)
            ?.ifBlank { null }
            ?: "application/octet-stream"
        return CachedCompanionAsset(data, mimeType)
    }

    private fun cacheKey(pairing: PairingConfig, target: PairingTarget, assetId: String): String {
        val profile = pairing.profileId.ifBlank { pairing.endpointId }
        val raw = "$profile\u0000${target.notebookId}\u0000${target.sessionId}\u0000$assetId"
        return MessageDigest.getInstance("SHA-256")
            .digest(raw.toByteArray(Charsets.UTF_8))
            .joinToString("") { byte -> "%02x".format(byte) }
    }
}
