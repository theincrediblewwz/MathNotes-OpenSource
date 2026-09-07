package com.mathnotes.capture.imageedit

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import androidx.exifinterface.media.ExifInterface
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidImageTransformerPixelTest {
    private lateinit var directory: File

    @Before fun setUp() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        directory = File(context.cacheDir, "image-transform-pixels-${System.nanoTime()}").apply { mkdirs() }
    }

    @After fun tearDown() { directory.deleteRecursively() }

    @Test
    fun cropExportsExactlyThePixelsInsidePreviewForEveryExifOrientationAndQuarterTurn() {
        val crop = NormalizedRect(0.2, 0.25, 0.6, 0.5)
        for (orientation in 1..8) {
            val source = fixture("exif-$orientation.jpg", jpeg = true)
            ExifInterface(source).apply {
                setAttribute(ExifInterface.TAG_ORIENTATION, orientation.toString())
                saveAttributes()
            }
            val preview = AndroidImageTransformer.loadPreview(source)
            for (turns in 0..3) {
                val rotated = AndroidImageTransformer.rotatePreview(preview, turns)
                val rendered = AndroidImageTransformer.render(draft(source), directory, turns, cropRect = crop)
                val output = BitmapFactory.decodeFile(rendered.outputFile.absolutePath)
                val pixels = imagePixelCrop(rotated.width, rotated.height, crop)
                assertEquals(pixels.width, output.width)
                assertEquals(pixels.height, output.height)
                for (y in 0 until output.height) for (x in 0 until output.width) {
                    assertEquals("EXIF=$orientation turns=$turns pixel=$x,$y", rotated.getPixel(pixels.left + x, pixels.top + y), output.getPixel(x, y))
                }
                output.recycle()
                if (rotated !== preview) rotated.recycle()
            }
            preview.recycle()
        }
    }

    @Test
    fun redactionIsOpaqueAndWinsOverLaterPenAfterPerspectiveAndCrop() {
        val source = fixture("redact.png")
        val redaction = ImageAnnotationObject.Redaction("redaction", listOf(NormalizedPoint(0.25, 0.5), NormalizedPoint(0.75, 0.5)), 0.1)
        val penAfter = ImageAnnotationObject.Pen("pen-after", redaction.points, "#ffffff", 0.07)
        val result = AndroidImageTransformer.render(
            draft(source), directory, 0,
            perspectiveCorners = listOf(NormalizedPoint(0.1, 0.1), NormalizedPoint(0.9, 0.1), NormalizedPoint(0.9, 0.9), NormalizedPoint(0.1, 0.9)),
            cropRect = NormalizedRect(0.125, 0.125, 0.75, 0.75),
            annotations = listOf(redaction, penAfter)
        )
        val output = BitmapFactory.decodeFile(result.outputFile.absolutePath)
        for (y in (output.height / 2 - 5)..(output.height / 2 + 5)) {
            for (x in (output.width / 3)..(output.width * 2 / 3)) assertEquals(Color.BLACK, output.getPixel(x, y))
        }
        assertTrue(output.getPixel(0, 0) != Color.BLACK)
        val annotations = JSONObject(result.sidecarFile.readText()).getJSONArray("annotations")
        assertEquals("pen", annotations.getJSONObject(annotations.length() - 1).getString("type"))
        assertEquals("#000000", annotations.getJSONObject(annotations.length() - 1).getString("color"))
        output.recycle()
    }

    @Test
    fun lassoKeepsWhiteOutsideAndBlackRedactionInside() {
        val source = fixture("lasso.png")
        val points = listOf(NormalizedPoint(0.5, 0.1), NormalizedPoint(0.9, 0.5), NormalizedPoint(0.5, 0.9), NormalizedPoint(0.1, 0.5))
        val result = AndroidImageTransformer.render(draft(source), directory, 0, cropRect = null, lassoPoints = points,
            annotations = listOf(ImageAnnotationObject.Redaction("redact", listOf(NormalizedPoint(0.3, 0.5), NormalizedPoint(0.7, 0.5)), 0.1)))
        val output = BitmapFactory.decodeFile(result.outputFile.absolutePath)
        assertEquals(Color.WHITE, output.getPixel(0, 0))
        assertEquals(Color.BLACK, output.getPixel(output.width / 2, output.height / 2))
        output.recycle()
    }

    @Test
    fun rotationPreservesMaskOverTheMarkedImageAndSinglePointMasksAreOpaque() {
        val source = fixture("rotate-mask.png")
        val original = ImageAnnotationObject.Redaction("redact", listOf(NormalizedPoint(0.25, 0.5), NormalizedPoint(0.25, 0.5)), 0.1)
        val rotated = rotateAnnotationClockwise(original)
        val result = AndroidImageTransformer.render(draft(source), directory, 1, cropRect = null, annotations = listOf(rotated))
        val output = BitmapFactory.decodeFile(result.outputFile.absolutePath)
        assertEquals(Color.BLACK, output.getPixel(output.width / 2, output.height / 4))
        assertTrue(output.getPixel(output.width / 4, output.height / 2) != Color.BLACK)
        output.recycle()
    }

    @Test
    fun alreadyAppliedStageIsCopiedLosslesslyAtFinalEnqueue() {
        val source = fixture("stage.png")
        val stage = AndroidImageTransformer.renderStage(draft(source), directory, 0, cropRect = NormalizedRect(0.2, 0.2, 0.6, 0.6))
        val result = AndroidImageTransformer.render(stage, directory, 0, cropRect = null)
        assertTrue(result.outputFile != stage.sourceFile)
        assertArrayEquals(stage.sourceFile.readBytes(), result.outputFile.readBytes())
        val output = BitmapFactory.decodeFile(result.outputFile.absolutePath)
        assertEquals(120, output.width)
        assertEquals(96, output.height)
        output.recycle()
    }

    private fun draft(source: File) = ImageEditDraft(source, source.name, if (source.extension == "jpg") "image/jpeg" else "image/png", "test")

    @Test fun whiteRectangleHasExactFilledPixelsAndPortableFlattenedSidecar() {
        val source = fixture("white-rect.png")
        val rectangle = ImageAnnotationObject.Redaction("rectangle", listOf(NormalizedPoint(0.2, 0.2), NormalizedPoint(0.7, 0.7)), 0.05, rectangular = true)
        val result = AndroidImageTransformer.render(draft(source), directory, 0, cropRect = null, annotations = listOf(rectangle))
        val original = BitmapFactory.decodeFile(source.path)
        val bitmap = BitmapFactory.decodeFile(result.outputFile.path)
        for (y in 0 until 160) for (x in 0 until 200) assertEquals("$x,$y", if (x in 40 until 140 && y in 32 until 112) Color.WHITE else original.getPixel(x, y), bitmap.getPixel(x, y))
        val sidecar = JSONObject(result.sidecarFile.readText())
        assertEquals(result.outputFile.name, sidecar.getString("sourceAsset"))
        assertEquals(result.outputFile.name, sidecar.getString("outputAsset"))
        assertEquals(com.mathnotes.capture.queueFileSha256(result.outputFile), sidecar.getString("sourceSha256"))
        assertTrue(sidecar.getString("sourceSha256") != com.mathnotes.capture.queueFileSha256(source))
        assertEquals(0, sidecar.getJSONArray("annotations").length())
        assertEquals(0, sidecar.getJSONArray("operations").length())
        original.recycle(); bitmap.recycle()
    }

    @Test fun whiteRectangleAndLegacyBlackMaskSurviveRotationPerspectiveCropAndLaterInk() {
        val source = fixture("mixed-rect.png")
        val white = ImageAnnotationObject.Redaction("white", listOf(NormalizedPoint(0.2, 0.2), NormalizedPoint(0.7, 0.7)), 0.05, rectangular = true)
        val black = ImageAnnotationObject.Redaction("black", listOf(NormalizedPoint(0.2, 0.74), NormalizedPoint(0.8, 0.74)), 0.04)
        val pen = ImageAnnotationObject.Pen("pen", listOf(NormalizedPoint(0.25, 0.5), NormalizedPoint(0.7, 0.5)), "#ff0000", 0.05)
        val arrow = ImageAnnotationObject.Arrow("arrow", NormalizedPoint(0.3, 0.3), NormalizedPoint(0.6, 0.6), "#00ff00", 0.03)
        val result = AndroidImageTransformer.render(draft(source), directory, 1,
            perspectiveCorners = listOf(NormalizedPoint(0.1, 0.1), NormalizedPoint(0.9, 0.1), NormalizedPoint(0.9, 0.9), NormalizedPoint(0.1, 0.9)),
            cropRect = NormalizedRect(0.125, 0.125, 0.75, 0.75), annotations = listOf(white, black, pen, arrow).map(::rotateAnnotationClockwise))
        val bitmap = BitmapFactory.decodeFile(result.outputFile.path)
        for (y in bitmap.height / 3..bitmap.height * 2 / 3) for (x in bitmap.width / 3..bitmap.width * 2 / 3) assertEquals(Color.WHITE, bitmap.getPixel(x, y))
        assertEquals(Color.BLACK, bitmap.getPixel(bitmap.width / 10, bitmap.height / 2))
        val sidecar = JSONObject(result.sidecarFile.readText())
        assertEquals(com.mathnotes.capture.queueFileSha256(result.outputFile), sidecar.getString("sourceSha256"))
        assertEquals(0, sidecar.getJSONArray("operations").length()); assertEquals(0, sidecar.getJSONArray("annotations").length())
        bitmap.recycle()
    }

    @Test fun whiteRectangleStaysOpaqueInsideLassoWhileUnmarkedPixelsRemain() {
        val source = fixture("white-lasso.png")
        val rectangle = ImageAnnotationObject.Redaction("rectangle", listOf(NormalizedPoint(0.35, 0.35), NormalizedPoint(0.65, 0.65)), 0.05, rectangular = true)
        val points = listOf(NormalizedPoint(0.5, 0.1), NormalizedPoint(0.9, 0.5), NormalizedPoint(0.5, 0.9), NormalizedPoint(0.1, 0.5))
        val result = AndroidImageTransformer.render(draft(source), directory, 0, cropRect = null, lassoPoints = points, annotations = listOf(rectangle))
        val output = BitmapFactory.decodeFile(result.outputFile.path)
        assertEquals(Color.WHITE, output.getPixel(0, 0))
        for (y in output.height * 2 / 5..output.height * 3 / 5) for (x in output.width * 2 / 5..output.width * 3 / 5) assertEquals(Color.WHITE, output.getPixel(x, y))
        assertTrue(output.getPixel(output.width / 5, output.height / 2) != Color.WHITE)
        output.recycle()
    }

    private fun fixture(name: String, jpeg: Boolean = false): File {
        val file = File(directory, name)
        val bitmap = Bitmap.createBitmap(200, 160, Bitmap.Config.ARGB_8888)
        for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) bitmap.setPixel(x, y, Color.rgb(30 + x, 30 + y, 80))
        file.outputStream().use { bitmap.compress(if (jpeg) Bitmap.CompressFormat.JPEG else Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
        return file
    }
}
