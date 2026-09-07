package com.mathnotes.capture.standalone

import java.io.File
import java.io.OutputStream
import java.util.Base64

/** The document picker grants one .md file, so embed trusted processed pixels without needing a sibling directory. */
internal fun writeStandalonePortableMarkdown(output: OutputStream, markdown: String, images: Map<String, File>) {
    val lines = markdown.split('\n')
    val prose = standaloneProseLineFlags(lines)
    val imageLine = Regex("^ {0,3}!\\[识别照片（已处理）]\\((source-images/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+)\\)[ \\t]*$")
    lines.forEachIndexed { index, line ->
        val match = if (prose[index]) imageLine.matchEntire(line.removeSuffix("\r")) else null
        if (match == null) output.write(line.toByteArray(Charsets.UTF_8))
        else {
            val file = images[match.groupValues[1]]?.takeIf { it.isFile && runCatching { it.canonicalFile == it }.getOrDefault(false) }
            if (file == null) output.write("_识别照片不可用_".toByteArray(Charsets.UTF_8))
            else {
                val mime = when (file.extension.lowercase()) { "png" -> "image/png"; "webp" -> "image/webp"; else -> "image/jpeg" }
                output.write("![识别照片（已处理）](data:$mime;base64,".toByteArray(Charsets.UTF_8))
                // Stream large photos instead of building an extra full-size Base64 String in memory.
                val nonClosingOutput = object : OutputStream() {
                    override fun write(value: Int) = output.write(value)
                    override fun write(bytes: ByteArray, offset: Int, length: Int) = output.write(bytes, offset, length)
                    override fun flush() = output.flush()
                    override fun close() = flush()
                }
                Base64.getEncoder().wrap(nonClosingOutput).use { encoded -> file.inputStream().use { it.copyTo(encoded) } }
                output.write(')'.code)
            }
            if (line.endsWith('\r')) output.write('\r'.code)
        }
        if (index != lines.lastIndex) output.write('\n'.code)
    }
    output.flush()
}
