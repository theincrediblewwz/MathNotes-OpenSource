package com.mathnotes.capture.pairing

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import org.junit.Assert.assertEquals
import org.junit.Test

class QrCodeDecoderTest {
    @Test
    fun `decodes pairing payload offline`() {
        val luminance = qrLuminance(320)

        assertEquals(payload, QrCodeDecoder.decode(luminance, 320, 320))
    }

    @Test
    fun `decodes a screen sized qr centered in a portrait camera frame`() {
        val qr = qrLuminance(360)
        val frame = ByteArray(720 * 1280) { 0xff.toByte() }
        copySquare(qr, 360, frame, 720, 1280, 180, 460)

        assertEquals(payload, QrCodeDecoder.decode(frame, 720, 1280))
    }

    @Test
    fun `decodes rotated and inverted camera frames`() {
        val qr = qrLuminance(320, inverted = true)
        val frame = ByteArray(720 * 1280) { 0 }
        copySquare(qr, 320, frame, 720, 1280, 200, 480)
        val rotated = rotateClockwise(frame, 720, 1280)

        assertEquals(payload, QrCodeDecoder.decode(rotated, 1280, 720, 270))
    }

    private fun qrLuminance(size: Int, inverted: Boolean = false): ByteArray {
        val matrix = QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, size, size)
        return ByteArray(size * size) { index ->
            val dark = matrix[index % size, index / size]
            if (dark.xor(inverted)) 0 else 0xff.toByte()
        }
    }

    private fun copySquare(
        source: ByteArray,
        size: Int,
        target: ByteArray,
        targetWidth: Int,
        targetHeight: Int,
        left: Int,
        top: Int
    ) {
        require(left + size <= targetWidth && top + size <= targetHeight)
        repeat(size) { row ->
            source.copyInto(target, (top + row) * targetWidth + left, row * size, (row + 1) * size)
        }
    }

    private fun rotateClockwise(bytes: ByteArray, width: Int, height: Int): ByteArray =
        ByteArray(bytes.size).also { output ->
            for (y in 0 until height) for (x in 0 until width) {
                output[x * height + (height - y - 1)] = bytes[y * width + x]
            }
        }

    private companion object {
        const val payload = "mathnotes://pair?v=1&host=192.168.137.1&port=43424&token=0123456789abcdef&notebook=n&session=s&transport=private_http"
    }
}
