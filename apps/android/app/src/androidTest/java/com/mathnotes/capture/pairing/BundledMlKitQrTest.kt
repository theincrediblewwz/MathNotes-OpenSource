package com.mathnotes.capture.pairing

import android.graphics.Bitmap
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BundledMlKitQrTest {
    @Test
    fun bundledModelDecodesMathNotesPairingPayload() {
        val payload = "mathnotes://pair?v=1&host=192.168.137.1&port=43424" +
            "&token=0123456789abcdef0123456789abcdef&transport=private_http"
        val matrix = QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, 720, 720)
        val bitmap = Bitmap.createBitmap(720, 720, Bitmap.Config.ARGB_8888)
        for (y in 0 until matrix.height) {
            for (x in 0 until matrix.width) {
                bitmap.setPixel(x, y, if (matrix[x, y]) 0xFF111111.toInt() else 0xFFFFFFFF.toInt())
            }
        }

        val scanner = BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build()
        )
        val latch = CountDownLatch(1)
        var decoded: String? = null
        var failure: Throwable? = null
        scanner.process(InputImage.fromBitmap(bitmap, 0))
            .addOnSuccessListener { barcodes ->
                decoded = barcodes.firstNotNullOfOrNull { it.rawValue }
            }
            .addOnFailureListener { failure = it }
            .addOnCompleteListener { latch.countDown() }

        assertTrue("Bundled ML Kit did not finish", latch.await(10, TimeUnit.SECONDS))
        scanner.close()
        failure?.let { throw AssertionError("Bundled ML Kit failed", it) }
        assertEquals(payload, decoded)
    }
}
