package com.mathnotes.capture.imageedit

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import androidx.exifinterface.media.ExifInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

object AndroidImageTransformer {
    fun loadPreview(source: File, maxDimension: Int = 2048): Bitmap {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(source.absolutePath, bounds)
        require(bounds.outWidth > 0 && bounds.outHeight > 0) { "无法读取图片尺寸" }
        val sampleSize = previewSampleSize(bounds.outWidth, bounds.outHeight, maxDimension)
        val decoded = BitmapFactory.decodeFile(
            source.absolutePath,
            BitmapFactory.Options().apply {
                inSampleSize = sampleSize
                inPreferredConfig = Bitmap.Config.ARGB_8888
            }
        ) ?: error("无法读取图片")
        val oriented = applyExifOrientation(decoded, source)
        if (oriented !== decoded) decoded.recycle()
        return oriented
    }

    fun rotatePreview(source: Bitmap, quarterTurns: Int): Bitmap = rotateQuarterTurns(source, quarterTurns)

    fun renderStage(
        draft: ImageEditDraft,
        outputDirectory: File,
        rotationQuarterTurns: Int,
        perspectiveCorners: List<NormalizedPoint>? = null,
        cropRect: NormalizedRect?,
        lassoPoints: List<NormalizedPoint>? = null,
        annotations: List<ImageAnnotationObject> = emptyList()
    ): ImageEditDraft {
        val rendered = render(
            draft = draft,
            outputDirectory = outputDirectory,
            rotationQuarterTurns = rotationQuarterTurns,
            perspectiveCorners = perspectiveCorners,
            cropRect = cropRect,
            lassoPoints = lassoPoints,
            annotations = annotations,
            writeSidecar = false
        )
        rendered.sidecarFile.delete()
        return draft.copy(
            sourceFile = rendered.outputFile,
            mimeType = "image/png",
            stageHistory = draft.stageHistory + ImageEditStage(draft.sourceFile, draft.mimeType)
        )
    }

    fun render(
        draft: ImageEditDraft,
        outputDirectory: File,
        rotationQuarterTurns: Int,
        perspectiveCorners: List<NormalizedPoint>? = null,
        cropRect: NormalizedRect?,
        lassoPoints: List<NormalizedPoint>? = null,
        annotations: List<ImageAnnotationObject> = emptyList(),
        writeSidecar: Boolean = true
    ): RenderedImageEdit {
        val turns = ((rotationQuarterTurns % 4) + 4) % 4
        val normalizedPerspective = perspectiveCorners?.map(ImageTransformContract::normalizePoint)
        require(normalizedPerspective == null || ImageTransformContract.isValidPerspectiveCorners(normalizedPerspective)) {
            "透视角点必须构成不交叉的凸四边形"
        }
        val normalizedLasso = lassoPoints?.takeIf { it.size >= 3 }?.map(ImageTransformContract::normalizePoint)
        val normalizedCrop = if (normalizedLasso == null) cropRect?.let(ImageTransformContract::normalizeRect) else null
        val operations = ImageTransformContract.normalizeOperations(buildList {
            if (turns != 0) add(ImageTransformOperation.Rotate(turns))
            if (normalizedPerspective != null) add(ImageTransformOperation.Perspective(normalizedPerspective))
            if (normalizedCrop != null && normalizedCrop != FULL_RECT) add(ImageTransformOperation.Crop(normalizedCrop))
            if (normalizedLasso != null) add(ImageTransformOperation.Lasso(normalizedLasso, ImageTransformContract.boundingBoxForPoints(normalizedLasso)))
        })
        val baseName = draft.sourceName.substringBeforeLast('.', draft.sourceName).ifBlank { "image" }
            .replace(Regex("[^A-Za-z0-9._-]+"), "_")
        outputDirectory.mkdirs()
        val outputFile = File(outputDirectory, "${baseName}_${UUID.randomUUID()}.png")
        val sidecarFile = File(outputDirectory, "${outputFile.nameWithoutExtension}.annotation.json")
        val sidecar = ImageTransformSidecar(
            sourceAsset = draft.sourceFile.name,
            sourceSha256 = if (writeSidecar) sha256(draft.sourceFile) else "0".repeat(64),
            outputAsset = outputFile.name,
            operations = operations,
            annotations = annotations.sortedBy { it is ImageAnnotationObject.Redaction },
            createdAt = Instant.now().toString()
        )
        ImageTransformContract.validate(sidecar)
        // A previously applied edit is already an EXIF-free, flattened PNG. Do not decode and
        // compress the full photograph a second time just to put it into the queue.
        if (draft.stageHistory.isNotEmpty() && draft.mimeType == "image/png" && operations.isEmpty() && annotations.isEmpty()) {
            draft.sourceFile.copyTo(outputFile)
            if (writeSidecar) writeSidecarAtomically(sidecarFile, sidecar)
            return RenderedImageEdit(outputFile, sidecarFile, operations)
        }
        val sourceBitmap = BitmapFactory.decodeFile(
            draft.sourceFile.absolutePath,
            BitmapFactory.Options().apply {
                inPreferredConfig = Bitmap.Config.ARGB_8888
                inMutable = true
            }
        ) ?: error("无法读取原始图片")
        val oriented = applyExifOrientation(sourceBitmap, draft.sourceFile)
        if (oriented !== sourceBitmap) sourceBitmap.recycle()
        val rotated = rotateQuarterTurns(oriented, rotationQuarterTurns)
        if (rotated !== oriented) oriented.recycle()

        // Annotation coordinates follow the rotated preview shown by the editor.
        // Burn them before perspective/crop/lasso so every tool shares that visible coordinate space.
        val redactions = annotations.filterIsInstance<ImageAnnotationObject.Redaction>()
        var redactionMask = if (redactions.isNotEmpty()) createRedactionMask(rotated.width, rotated.height, redactions) else null
        val annotatedSource = if (annotations.isNotEmpty()) annotateBitmap(rotated, sidecar.annotations) else rotated
        if (annotatedSource !== rotated) rotated.recycle()

        val corrected = normalizedPerspective?.let { perspectiveBitmap(annotatedSource, it) } ?: annotatedSource
        if (corrected !== annotatedSource) annotatedSource.recycle()
        if (normalizedPerspective != null) redactionMask = redactionMask?.let { mask ->
            perspectiveBitmap(mask, normalizedPerspective, Color.TRANSPARENT).also { mask.recycle() }
        }
        val edited = when {
            normalizedLasso != null -> lassoBitmap(corrected, normalizedLasso)
            normalizedCrop != null -> cropBitmap(corrected, normalizedCrop)
            else -> corrected
        }
        if (edited !== corrected) corrected.recycle()
        redactionMask = redactionMask?.let { mask ->
            val result = when {
                normalizedLasso != null -> lassoBitmap(mask, normalizedLasso, Color.TRANSPARENT)
                normalizedCrop != null -> cropBitmap(mask, normalizedCrop)
                else -> mask
            }
            if (result !== mask) mask.recycle()
            result
        }
        // Interpolation at perspective edges must never leave a translucent redaction. Force
        // every covered output pixel to solid black/white after all geometry and normal annotation.
        val flattened = redactionMask?.let { mask ->
            forceOpaqueRedactions(edited, mask).also { mask.recycle() }
        } ?: edited
        if (flattened !== edited) edited.recycle()
        try {
            writePngAtomically(flattened, outputFile)
            if (writeSidecar) {
                // v1 cannot express a filled rectangle. Its reproducible source is now the
                // already flattened PNG, with no reference to the unredacted input or replay steps.
                val portableSidecar = if (redactions.any { it.rectangular }) sidecar.copy(
                    sourceAsset = outputFile.name, sourceSha256 = sha256(outputFile), operations = emptyList(), annotations = emptyList()
                ) else sidecar
                writeSidecarAtomically(sidecarFile, portableSidecar)
            }
        } finally {
            flattened.recycle()
        }
        return RenderedImageEdit(outputFile, sidecarFile, operations)
    }

    private fun annotateBitmap(bitmap: Bitmap, annotations: List<ImageAnnotationObject>): Bitmap {
        val output = if (bitmap.isMutable) bitmap else bitmap.copy(Bitmap.Config.ARGB_8888, true)
        val canvas = Canvas(output)
        val scale = min(output.width, output.height).toFloat()
        annotations.forEach { annotation ->
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.parseColor(annotation.color)
                strokeWidth = max(1f, annotation.width.toFloat() * scale)
                style = Paint.Style.STROKE
                strokeCap = Paint.Cap.ROUND
                strokeJoin = Paint.Join.ROUND
            }
            when (annotation) {
                is ImageAnnotationObject.Pen -> {
                    val path = Path()
                    annotation.points.forEachIndexed { index, point ->
                        val x = (point.x * output.width).toFloat()
                        val y = (point.y * output.height).toFloat()
                        if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
                    }
                    canvas.drawPath(path, paint)
                    if (annotation.points.distinct().size == 1) {
                        val point = annotation.points.first()
                        canvas.drawPoint((point.x * output.width).toFloat(), (point.y * output.height).toFloat(), paint)
                    }
                }
                is ImageAnnotationObject.Redaction -> drawRedaction(canvas, output.width, output.height, annotation, Color.parseColor(annotation.color))
                is ImageAnnotationObject.Arrow -> {
                    val startX = (annotation.start.x * output.width).toFloat()
                    val startY = (annotation.start.y * output.height).toFloat()
                    val endX = (annotation.end.x * output.width).toFloat()
                    val endY = (annotation.end.y * output.height).toFloat()
                    canvas.drawLine(startX, startY, endX, endY, paint)
                    val angle = kotlin.math.atan2((endY - startY).toDouble(), (endX - startX).toDouble())
                    val headLength = max(paint.strokeWidth * 4f, scale * 0.028f)
                    val spread = Math.PI / 7
                    canvas.drawLine(
                        endX,
                        endY,
                        (endX - headLength * cos(angle - spread)).toFloat(),
                        (endY - headLength * sin(angle - spread)).toFloat(),
                        paint
                    )
                    canvas.drawLine(
                        endX,
                        endY,
                        (endX - headLength * cos(angle + spread)).toFloat(),
                        (endY - headLength * sin(angle + spread)).toFloat(),
                        paint
                    )
                }
            }
        }
        return output
    }

    private fun createRedactionMask(width: Int, height: Int, redactions: List<ImageAnnotationObject.Redaction>): Bitmap =
        Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also { mask ->
            val canvas = Canvas(mask)
            redactions.forEach { drawRedaction(canvas, width, height, it, Color.parseColor(it.color)) }
        }

    private fun drawRedaction(canvas: Canvas, width: Int, height: Int, annotation: ImageAnnotationObject.Redaction, fill: Int) {
        if (annotation.rectangular) {
            val bounds = ImageTransformContract.boundingBoxForPoints(annotation.points)
            canvas.drawRect((bounds.x * width).toFloat(), (bounds.y * height).toFloat(),
                ((bounds.x + bounds.width) * width).toFloat(), ((bounds.y + bounds.height) * height).toFloat(),
                Paint().apply { color = Color.WHITE; style = Paint.Style.FILL; isAntiAlias = false })
            return
        }
        val paint = Paint().apply {
            color = fill
            // One source-pixel guard on both sides covers sampling and antialiasing boundaries.
            strokeWidth = (annotation.width * min(width, height)).toFloat() + 2f
            style = Paint.Style.STROKE
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
            isAntiAlias = false
        }
        val path = Path()
        annotation.points.forEachIndexed { index, point ->
            val x = (point.x * width).toFloat()
            val y = (point.y * height).toFloat()
            if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        canvas.drawPath(path, paint)
        // A tap/very short stroke must also remove pixels.
        annotation.points.firstOrNull()?.let { point ->
            canvas.drawPoint((point.x * width).toFloat(), (point.y * height).toFloat(), paint)
        }
    }

    private fun forceOpaqueRedactions(bitmap: Bitmap, mask: Bitmap): Bitmap {
        require(bitmap.width == mask.width && bitmap.height == mask.height) { "遮盖区域与导出图片尺寸不一致" }
        val output = if (bitmap.isMutable) bitmap else bitmap.copy(Bitmap.Config.ARGB_8888, true)
        val pixels = IntArray(output.width)
        val maskPixels = IntArray(output.width)
        for (y in 0 until output.height) {
            mask.getPixels(maskPixels, 0, output.width, 0, y, output.width, 1)
            if (maskPixels.none { Color.alpha(it) > 0 }) continue
            output.getPixels(pixels, 0, output.width, 0, y, output.width, 1)
            for (x in pixels.indices) if (Color.alpha(maskPixels[x]) > 0) pixels[x] = if (Color.red(maskPixels[x]) >= 128) Color.WHITE else Color.BLACK
            output.setPixels(pixels, 0, output.width, 0, y, output.width, 1)
        }
        return output
    }

    private fun perspectiveBitmap(bitmap: Bitmap, corners: List<NormalizedPoint>, outsideColor: Int = Color.WHITE): Bitmap {
        require(ImageTransformContract.isValidPerspectiveCorners(corners)) {
            "透视角点必须构成不交叉的凸四边形"
        }
        val source = FloatArray(8)
        corners.forEachIndexed { index, point ->
            source[index * 2] = (point.x * bitmap.width).toFloat()
            source[index * 2 + 1] = (point.y * bitmap.height).toFloat()
        }
        val topWidth = pointDistance(source[0], source[1], source[2], source[3])
        val bottomWidth = pointDistance(source[6], source[7], source[4], source[5])
        val leftHeight = pointDistance(source[0], source[1], source[6], source[7])
        val rightHeight = pointDistance(source[2], source[3], source[4], source[5])
        val width = max(topWidth, bottomWidth).toInt().coerceAtLeast(1)
        val height = max(leftHeight, rightHeight).toInt().coerceAtLeast(1)
        val destination = floatArrayOf(
            0f, 0f,
            width.toFloat(), 0f,
            width.toFloat(), height.toFloat(),
            0f, height.toFloat()
        )
        val matrix = Matrix()
        require(matrix.setPolyToPoly(source, 0, destination, 0, 4)) { "无法计算透视变换" }
        return Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also { output ->
            Canvas(output).apply {
                drawColor(outsideColor)
                drawBitmap(bitmap, matrix, Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
            }
        }
    }

    private fun pointDistance(x1: Float, y1: Float, x2: Float, y2: Float): Double = hypot(
        (x2 - x1).toDouble(),
        (y2 - y1).toDouble()
    )

    private fun cropBitmap(bitmap: Bitmap, rect: NormalizedRect): Bitmap {
        val pixels = imagePixelCrop(bitmap.width, bitmap.height, rect)
        return Bitmap.createBitmap(bitmap, pixels.left, pixels.top, pixels.width, pixels.height)
    }

    private fun lassoBitmap(bitmap: Bitmap, points: List<NormalizedPoint>, outsideColor: Int = Color.WHITE): Bitmap {
        val bounds = ImageTransformContract.boundingBoxForPoints(points)
        val pixels = imagePixelCrop(bitmap.width, bitmap.height, bounds)
        val left = pixels.left
        val top = pixels.top
        val output = Bitmap.createBitmap(pixels.width, pixels.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(output)
        canvas.drawColor(outsideColor)
        val path = Path().apply {
            points.forEachIndexed { index, point ->
                val x = (point.x * bitmap.width - left).toFloat()
                val y = (point.y * bitmap.height - top).toFloat()
                if (index == 0) moveTo(x, y) else lineTo(x, y)
            }
            close()
        }
        canvas.save()
        canvas.clipPath(path)
        canvas.drawBitmap(
            bitmap,
            -left.toFloat(),
            -top.toFloat(),
            Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        )
        canvas.restore()
        return output
    }

    private fun rotateQuarterTurns(bitmap: Bitmap, quarterTurns: Int): Bitmap {
        val normalized = ((quarterTurns % 4) + 4) % 4
        if (normalized == 0) return bitmap
        return Bitmap.createBitmap(
            bitmap,
            0,
            0,
            bitmap.width,
            bitmap.height,
            Matrix().apply { postRotate(normalized * 90f) },
            true
        )
    }

    private fun applyExifOrientation(bitmap: Bitmap, source: File): Bitmap {
        val orientation = runCatching {
            ExifInterface(source.absolutePath).getAttributeInt(
                ExifInterface.TAG_ORIENTATION,
                ExifInterface.ORIENTATION_NORMAL
            )
        }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> {
                matrix.setRotate(90f)
                matrix.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> {
                matrix.setRotate(-90f)
                matrix.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(-90f)
            else -> return bitmap
        }
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    }

    private fun writePngAtomically(bitmap: Bitmap, target: File) {
        val temp = File(target.parentFile, ".${target.name}.tmp")
        FileOutputStream(temp).use { output ->
            require(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) { "无法生成 PNG" }
            output.fd.sync()
        }
        require(temp.renameTo(target)) { "无法保存编辑后的图片" }
    }

    private fun writeSidecarAtomically(target: File, sidecar: ImageTransformSidecar) {
        ImageTransformContract.validate(sidecar)
        val temp = File(target.parentFile, ".${target.name}.tmp")
        temp.writeText(sidecar.toJson().toString(2), Charsets.UTF_8)
        require(temp.renameTo(target)) { "无法保存图片编辑记录" }
    }

    private fun ImageTransformSidecar.toJson(): JSONObject = JSONObject()
        .put("version", version)
        .put("sourceAsset", sourceAsset)
        .put("sourceSha256", sourceSha256)
        .put("outputAsset", outputAsset)
        .put("outputMimeType", outputMimeType)
        .put("createdAt", createdAt)
        .put("operations", JSONArray(operations.map { it.toJson() }))
        .put("annotations", JSONArray(annotations.map { it.toJson() }))

    private fun ImageTransformOperation.toJson(): JSONObject = when (this) {
        is ImageTransformOperation.Rotate -> JSONObject().put("type", "rotate").put("quarterTurns", quarterTurns)
        is ImageTransformOperation.Crop -> JSONObject().put("type", "crop").put("rect", rect.toJson())
        is ImageTransformOperation.Perspective -> JSONObject().put("type", "perspective").put("corners", JSONArray(corners.map { it.toJson() }))
        is ImageTransformOperation.Lasso -> JSONObject()
            .put("type", "lasso")
            .put("points", JSONArray(points.map { it.toJson() }))
            .put("boundingBox", boundingBox.toJson())
            .put("outsideFill", outsideFill)
    }

    private fun NormalizedPoint.toJson(): JSONObject = JSONObject().put("x", x).put("y", y)
    private fun NormalizedRect.toJson(): JSONObject = JSONObject().put("x", x).put("y", y).put("width", width).put("height", height)

    private fun ImageAnnotationObject.toJson(): JSONObject = when (this) {
        is ImageAnnotationObject.Pen -> JSONObject()
            .put("id", id)
            .put("type", "pen")
            .put("points", JSONArray(points.map { it.toJson() }))
            .put("color", color)
            .put("width", width)
        is ImageAnnotationObject.Arrow -> JSONObject()
            .put("id", id)
            .put("type", "arrow")
            .put("start", start.toJson())
            .put("end", end.toJson())
            .put("color", color)
            .put("width", width)
        is ImageAnnotationObject.Redaction -> JSONObject()
            .put("id", id)
            .put("type", "pen")
            .put("points", JSONArray(points.map { it.toJson() }))
            .put("color", color)
            .put("width", width)
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private val FULL_RECT = NormalizedRect(0.0, 0.0, 1.0, 1.0)
}
