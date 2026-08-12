package com.mathnotes.capture.pairing

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer

object QrCodeDecoder {
    private val hints = mapOf(
        DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
        DecodeHintType.TRY_HARDER to true,
        DecodeHintType.ALSO_INVERTED to true,
        DecodeHintType.CHARACTER_SET to "UTF-8"
    )
    private val reader = MultiFormatReader().apply {
        setHints(hints)
    }

    @Synchronized
    fun decode(
        bytes: ByteArray,
        width: Int,
        height: Int,
        rotationDegrees: Int = 0
    ): String? {
        val (rotatedBytes, rotatedWidth, rotatedHeight) = rotateLuminance(
            bytes,
            width,
            height,
            rotationDegrees
        )
        return candidateSources(rotatedBytes, rotatedWidth, rotatedHeight).firstNotNullOfOrNull { source ->
            runCatching {
                reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
            }.getOrNull().also { reader.reset() }
        }
    }

    private fun candidateSources(bytes: ByteArray, width: Int, height: Int): List<PlanarYUVLuminanceSource> {
        val sources = mutableListOf(source(bytes, width, height, 0, 0, width, height))
        val shortest = minOf(width, height)
        for (ratio in listOf(0.88f, 0.72f, 0.58f)) {
            val size = (shortest * ratio).toInt().coerceAtLeast(1)
            sources += source(bytes, width, height, (width - size) / 2, (height - size) / 2, size, size)
        }
        return sources
    }

    private fun source(
        bytes: ByteArray,
        dataWidth: Int,
        dataHeight: Int,
        left: Int,
        top: Int,
        width: Int,
        height: Int
    ) = PlanarYUVLuminanceSource(bytes, dataWidth, dataHeight, left, top, width, height, false)

    private fun rotateLuminance(
        bytes: ByteArray,
        width: Int,
        height: Int,
        rotationDegrees: Int
    ): Triple<ByteArray, Int, Int> = when ((rotationDegrees % 360 + 360) % 360) {
        90 -> Triple(ByteArray(bytes.size).also { output ->
            for (y in 0 until height) for (x in 0 until width) {
                output[x * height + (height - y - 1)] = bytes[y * width + x]
            }
        }, height, width)
        180 -> Triple(bytes.reversedArray(), width, height)
        270 -> Triple(ByteArray(bytes.size).also { output ->
            for (y in 0 until height) for (x in 0 until width) {
                output[(width - x - 1) * height + y] = bytes[y * width + x]
            }
        }, height, width)
        else -> Triple(bytes, width, height)
    }
}
