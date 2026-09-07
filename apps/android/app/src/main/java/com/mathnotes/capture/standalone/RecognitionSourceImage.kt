package com.mathnotes.capture.standalone

internal const val SOURCE_IMAGE_MARKER = "[[mathnotes:source-image]]"
private val SOURCE_ID = Regex("^[A-Za-z0-9_-]{1,100}$")

internal fun recognitionSourceImageLink(taskId: String, assetId: String): String? =
    if (SOURCE_ID.matches(taskId) && SOURCE_ID.matches(assetId)) "source-images/$taskId/$assetId" else null

/** Only a standalone marker in prose is a directive. Code examples remain literal. */
internal fun resolveRecognitionSourceImage(markdown: String, trustedImageLink: String?): String {
    val lines = markdown.split('\n')
    val prose = standaloneProseLineFlags(lines)
    return lines.mapIndexed { index, line ->
        val content = line.removeSuffix("\r")
        if (prose[index] && Regex("^ {0,3}\\[\\[mathnotes:source-image]][ \\t]*$").matches(content)) {
            val image = trustedImageLink?.let { "![识别照片（已处理）]($it)" } ?: "_识别照片不可用_"
            image + if (line.endsWith('\r')) "\r" else ""
        } else line
    }.joinToString("\n")
}

internal fun standaloneProseLineFlags(lines: List<String>): BooleanArray {
    var fenceCharacter: Char? = null
    var fenceLength = 0
    var inlineTicks = 0
    val prose = BooleanArray(lines.size)
    lines.forEachIndexed { index, line ->
        val content = line.removeSuffix("\r")
        val fence = Regex("^ {0,3}(`{3,}|~{3,})(.*)$").matchEntire(content)
        if (fenceCharacter != null) {
            if (fence != null && fence.groupValues[1].first() == fenceCharacter &&
                fence.groupValues[1].length >= fenceLength && fence.groupValues[2].isBlank()) fenceCharacter = null
            return@forEachIndexed
        }
        if (inlineTicks == 0 && fence != null && (fence.groupValues[1].first() != '`' || !fence.groupValues[2].contains('`'))) {
            fenceCharacter = fence.groupValues[1].first()
            fenceLength = fence.groupValues[1].length
            return@forEachIndexed
        }
        prose[index] = inlineTicks == 0 && !content.startsWith("    ") && !content.startsWith('\t')
        if (content.isBlank()) inlineTicks = 0
        else Regex("`+").findAll(content).forEach { ticks ->
            if (inlineTicks == ticks.value.length) inlineTicks = 0
            else if (inlineTicks == 0) {
                val slashes = content.substring(0, ticks.range.first).takeLastWhile { it == '\\' }.length
                if (slashes % 2 == 1) return@forEach
                val rest = content.substring(ticks.range.last + 1) + "\n" + lines.drop(index + 1).takeWhile { it.isNotBlank() }.joinToString("\n")
                if (Regex("`+").findAll(rest).any { it.value.length == ticks.value.length }) inlineTicks = ticks.value.length
            }
        }
    }
    return prose
}
