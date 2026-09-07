package com.mathnotes.capture.imageedit

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.util.Base64
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.standalone.OpenAiCompatibleStandaloneTransport
import com.mathnotes.capture.standalone.StandaloneDatabase
import com.mathnotes.capture.standalone.StandaloneProviderProfileStore
import com.mathnotes.capture.standalone.StandaloneRepository
import com.mathnotes.capture.storage.CaptureRepository
import com.mathnotes.capture.storage.MathNotesDatabase
import com.mathnotes.capture.upload.OkHttpUploadTransport
import com.mathnotes.capture.upload.UploadOutcome
import java.io.File
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RedactedUploadBoundaryTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private lateinit var source: File
    private val cleanup = mutableListOf<File>()
    private val mask = ImageAnnotationObject.Redaction("private-region", listOf(NormalizedPoint(0.2, 0.3), NormalizedPoint(0.8, 0.7)), 0.1, rectangular = true)

    @Before fun setUp() {
        source = File(context.cacheDir, "unredacted-source-${System.nanoTime()}.png")
        val bitmap = Bitmap.createBitmap(200, 160, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.RED) }
        source.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
        cleanup += source
    }

    @After fun tearDown() { cleanup.forEach { it.delete() } }

    @Test
    fun companionUploadsOneFlattenedPngAndNoOriginalImageAttachment() = runBlocking {
        val database = Room.inMemoryDatabaseBuilder(context, MathNotesDatabase::class.java).build()
        val server = MockWebServer().apply {
            enqueue(MockResponse().setResponseCode(202).setBody("""{"uploadId":"masked","duplicate":false,"imageBlockId":"0001","recognitionJobId":"masked-job","recognitionStatus":"pending"}"""))
            start()
        }
        try {
            val pairing = PairingConfig(1, "127.0.0.1", server.port, "local-test-token-12345", "notebook", "session", "private_http")
            val capture = CaptureRepository(context, database.captureDao()).commitImageDraft(
                ImageEditDraft(source, source.name, "image/png", "test"), pairing, 0, cropRect = null, annotations = listOf(mask))
            val output = File(capture.localPath)
            cleanup += output
            cleanup += File(output.parentFile, "${output.nameWithoutExtension}.annotation.json")
            assertTrue(output.absolutePath != source.absolutePath)
            assertTrue(OkHttpUploadTransport().upload(capture, pairing) is UploadOutcome.Accepted)
            val request = server.takeRequest()
            val boundary = requireNotNull(request.getHeader("Content-Type")).substringAfter("boundary=")
            val multipart = request.body.readByteArray().toString(Charsets.ISO_8859_1)
            val fileParts = multipart.split("--$boundary").filter { it.contains("filename=\"") }
            assertEquals(1, fileParts.size)
            assertTrue(fileParts.single().contains("name=\"material\""))
            val uploaded = fileParts.single().substringAfter("\r\n\r\n").removeSuffix("\r\n").toByteArray(Charsets.ISO_8859_1)
            assertArrayEquals(output.readBytes(), uploaded)
            assertMaskedPixels(uploaded)
            assertFalse(uploaded.contentEquals(source.readBytes()))
        } finally {
            server.shutdown()
            database.close()
        }
    }

    @Test
    fun standaloneProviderRequestContainsOnlyTheFlattenedAssetPixels() = runBlocking {
        val database = Room.inMemoryDatabaseBuilder(context, StandaloneDatabase::class.java).build()
        val server = MockWebServer().apply {
            enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("""{"choices":[{"message":{"content":"fixture transcription"}}]}"""))
            start()
        }
        try {
            val repository = StandaloneRepository(context, database)
            val session = repository.ensureCaptureSession()
            val rendered = AndroidImageTransformer.render(ImageEditDraft(source, source.name, "image/png", "test"), context.cacheDir, 0, cropRect = null, annotations = listOf(mask))
            cleanup += rendered.outputFile
            cleanup += rendered.sidecarFile
            val task = repository.importCapturedFile(session.id, rendered.outputFile)
            val asset = requireNotNull(repository.findBlock(task.assetBlockId))
            val queued = File(asset.localPath)
            cleanup += queued
            assertArrayEquals(rendered.outputFile.readBytes(), queued.readBytes())
            OpenAiCompatibleStandaloneTransport().transcribe(task.copy(
                providerId = StandaloneProviderProfileStore.PROVIDER_ID, destination = server.url("/v1/chat/completions").toString(), model = "local-fixture"), queued, "local-fixture-key")
            val body = JSONObject(server.takeRequest().body.readUtf8())
            val content = body.getJSONArray("messages").getJSONObject(0).getJSONArray("content")
            assertEquals(2, content.length())
            val dataUrl = content.getJSONObject(1).getJSONObject("image_url").getString("url")
            assertTrue(dataUrl.startsWith("data:image/png;base64,"))
            val outbound = Base64.decode(dataUrl.substringAfter(','), Base64.NO_WRAP)
            assertArrayEquals(queued.readBytes(), outbound)
            assertMaskedPixels(outbound)
            assertFalse(body.toString().contains(source.name))
            assertFalse(body.has("imageTransform"))
        } finally {
            server.shutdown()
            database.close()
        }
    }

    private fun assertMaskedPixels(bytes: ByteArray) {
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        assertEquals(200, bitmap.width)
        assertEquals(160, bitmap.height)
        for (x in 60..140) for (y in 76..84) assertEquals(Color.WHITE, bitmap.getPixel(x, y))
        assertEquals(Color.RED, bitmap.getPixel(5, 5))
        bitmap.recycle()
    }
}
