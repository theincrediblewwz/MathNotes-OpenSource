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
import kotlin.math.ceil
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
        var sampleSize = 1
        while (max(bounds.outWidth, bounds.outHeight) / sampleSize > maxDimension * 2) sampleSize *= 2
        val decoded = BitmapFactory.decodeFile(
            source.absolutePath,
            BitmapFactory.Options().apply {
                inSampleSize = sampleSize
                inPreferredConfig = Bitmap.Config.ARGB_8888
            }
        ) ?: error("无法读取图片")
        return applyExifOrientation(decoded, source)
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
            annotations = annotations
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
        annotations: List<ImageAnnotationObject> = emptyList()
    ): RenderedImageEdit {
        val sourceBitmap = BitmapFactory.decodeFile(
            draft.sourceFile.absolutePath,
            BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 }
        ) ?: error("无法读取原始图片")
        val oriented = applyExifOrientation(sourceBitmap, draft.sourceFile)
        if (oriented !== sourceBitmap) sourceBitmap.recycle()
        val rotated = rotateQuarterTurns(oriented, rotationQuarterTurns)
        if (rotated !== oriented) oriented.recycle()

        // Annotation coordinates follow the rotated preview shown by the editor.
        // Burn them before perspective/crop/lasso so every tool shares that visible coordinate space.
        val annotatedSource = if (annotations.isNotEmpty()) annotateBitmap(rotated, annotations) else rotated
        if (annotatedSource !== rotated) rotated.recycle()

        val normalizedPerspective = perspectiveCorners
            ?.map(ImageTransformContract::normalizePoint)
            ?.takeIf(ImageTransformContract::isValidPerspectiveCorners)
        val corrected = normalizedPerspective?.let { perspectiveBitmap(annotatedSource, it) } ?: annotatedSource
        if (corrected !== annotatedSource) annotatedSource.recycle()

        val normalizedLasso = lassoPoints
            ?.takeIf { it.size >= 3 }
            ?.map(ImageTransformContract::normalizePoint)
        val normalizedCrop = if (normalizedLasso == null) cropRect?.let(ImageTransformContract::normalizeRect) else null
        val edited = when {
            normalizedLasso != null -> lassoBitmap(corrected, normalizedLasso)
            normalizedCrop != null -> cropBitmap(corrected, normalizedCrop)
            else -> corrected
        }
        if (edited !== corrected) corrected.recycle()

        val operations = ImageTransformContract.normalizeOperations(buildList {
            val turns = ((rotationQuarterTurns % 4) + 4) % 4
            if (turns != 0) add(ImageTransformOperation.Rotate(turns))
            if (normalizedPerspective != null) add(ImageTransformOperation.Perspective(normalizedPerspective))
            if (normalizedCrop != null && normalizedCrop != FULL_RECT) add(ImageTransformOperation.Crop(normalizedCrop))
            if (normalizedLasso != null) {
                add(
                    ImageTransformOperation.Lasso(
                        points = normalizedLasso,
                        boundingBox = ImageTransformContract.boundingBoxForPoints(normalizedLasso)
                    )
                )
            }
        })
        val sourceHash = sha256(draft.sourceFile)
        val baseName = draft.sourceName.substringBeforeLast('.', draft.sourceName).ifBlank { "image" }
            .replace(Regex("[^A-Za-z0-9._-]+"), "_")
        outputDirectory.mkdirs()
        val outputFile = File(outputDirectory, "${baseName}_${UUID.randomUUID()}.png")
        val sidecarFile = File(outputDirectory, "${outputFile.nameWithoutExtension}.annotation.json")
        writePngAtomically(edited, outputFile)
        edited.recycle()
        writeSidecarAtomically(
            sidecarFile,
            ImageTransformSidecar(
                sourceAsset = draft.sourceFile.name,
                sourceSha256 = sourceHash,
                outputAsset = outputFile.name,
                operations = operations,
                annotations = annotations,
                createdAt = Instant.now().toString()
            )
        )
        return RenderedImageEdit(outputFile, sidecarFile, operations)
    }

    private fun annotateBitmap(bitmap: Bitmap, annotations: List<ImageAnnotationObject>): Bitmap {
        val output = bitmap.copy(Bitmap.Config.ARGB_8888, true)
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
                }
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

    private fun perspectiveBitmap(bitmap: Bitmap, corners: List<NormalizedPoint>): Bitmap {
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
                drawColor(Color.WHITE)
                drawBitmap(bitmap, matrix, Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
            }
        }
    }

    private fun pointDistance(x1: Float, y1: Float, x2: Float, y2: Float): Double = hypot(
        (x2 - x1).toDouble(),
        (y2 - y1).toDouble()
    )

    private fun cropBitmap(bitmap: Bitmap, rect: NormalizedRect): Bitmap {
        val left = (rect.x * bitmap.width).toInt().coerceIn(0, bitmap.width - 1)
        val top = (rect.y * bitmap.height).toInt().coerceIn(0, bitmap.height - 1)
        val right = ceil((rect.x + rect.width) * bitmap.width).toInt().coerceIn(left + 1, bitmap.width)
        val bottom = ceil((rect.y + rect.height) * bitmap.height).toInt().coerceIn(top + 1, bitmap.height)
        return Bitmap.createBitmap(bitmap, left, top, right - left, bottom - top)
    }

    private fun lassoBitmap(bitmap: Bitmap, points: List<NormalizedPoint>): Bitmap {
        val bounds = ImageTransformContract.boundingBoxForPoints(points)
        val left = (bounds.x * bitmap.width).toInt().coerceIn(0, bitmap.width - 1)
        val top = (bounds.y * bitmap.height).toInt().coerceIn(0, bitmap.height - 1)
        val right = ceil((bounds.x + bounds.width) * bitmap.width).toInt().coerceIn(left + 1, bitmap.width)
        val bottom = ceil((bounds.y + bounds.height) * bitmap.height).toInt().coerceIn(top + 1, bitmap.height)
        val output = Bitmap.createBitmap(right - left, bottom - top, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(output)
        canvas.drawColor(Color.WHITE)
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
