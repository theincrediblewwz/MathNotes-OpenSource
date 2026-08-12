package com.mathnotes.capture.companion

import android.content.Context
import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.pairing.PairingTarget
import java.io.File
import java.io.InputStream
import java.security.MessageDigest

class CompanionContentStore(context: Context) {
    private val root = File(context.applicationContext.filesDir, "companion-content")

    fun write(pairing: PairingConfig, snapshot: CompanionSessionSnapshot) {
        val target = PairingTarget(snapshot.notebookId, snapshot.sessionId, snapshot.title)
        writeAtomic(fileFor(pairing, target, "md"), snapshot.markdown)
        writeAtomic(fileFor(pairing, target, "html"), snapshot.html)
    }

    fun writeDocument(
        pairing: PairingConfig,
        target: PairingTarget,
        extension: String,
        input: InputStream
    ) {
        require(extension == "md" || extension == "html")
        writeAtomic(fileFor(pairing, target, extension), input)
    }

    fun readDocuments(pairing: PairingConfig, target: PairingTarget): Pair<String, String>? {
        val markdownFile = fileFor(pairing, target, "md")
        val htmlFile = fileFor(pairing, target, "html")
        if (!markdownFile.isFile || !htmlFile.isFile) return null
        return markdownFile.readText(Charsets.UTF_8) to htmlFile.readText(Charsets.UTF_8)
    }

    fun hydrate(pairing: PairingConfig, entity: CompanionSessionEntity): CompanionSessionEntity {
        val target = PairingTarget(entity.notebookId, entity.sessionId, entity.title)
        val markdown = fileFor(pairing, target, "md").takeIf(File::isFile)?.readText(Charsets.UTF_8)
        val html = fileFor(pairing, target, "html").takeIf(File::isFile)?.readText(Charsets.UTF_8)
        return entity.copy(
            markdown = markdown ?: entity.markdown,
            html = html ?: entity.html
        )
    }

    fun delete(pairing: PairingConfig, target: PairingTarget) {
        fileFor(pairing, target, "md").delete()
        fileFor(pairing, target, "html").delete()
    }

    private fun writeAtomic(destination: File, content: String) {
        writeAtomic(destination, content.byteInputStream(Charsets.UTF_8))
    }

    private fun writeAtomic(destination: File, input: InputStream) {
        root.mkdirs()
        val temporary = File(destination.parentFile, "${destination.name}.tmp")
        temporary.outputStream().use { output ->
            input.use { source -> source.copyTo(output, DEFAULT_COPY_BUFFER_BYTES) }
            output.fd.sync()
        }
        if (destination.exists()) check(destination.delete()) { "无法更新离线笔记" }
        check(temporary.renameTo(destination)) { "无法保存离线笔记" }
    }

    private fun fileFor(pairing: PairingConfig, target: PairingTarget, extension: String): File {
        val profile = pairing.profileId.ifBlank { pairing.endpointId }
        val raw = "$profile\u0000${target.notebookId}\u0000${target.sessionId}"
        val key = MessageDigest.getInstance("SHA-256")
            .digest(raw.toByteArray(Charsets.UTF_8))
            .joinToString("") { byte -> "%02x".format(byte) }
        return File(root, "$key.$extension")
    }

    private companion object {
        const val DEFAULT_COPY_BUFFER_BYTES = 64 * 1024
    }
}
