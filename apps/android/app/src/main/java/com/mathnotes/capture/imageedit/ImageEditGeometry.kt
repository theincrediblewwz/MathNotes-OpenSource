package com.mathnotes.capture.imageedit

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** Edges describe pixel boundaries, rather than pixel centres. Keep preview and export in this space. */
internal data class ImagePixelRect(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    val width: Int get() = right - left
    val height: Int get() = bottom - top
}

internal fun imagePixelCrop(width: Int, height: Int, rectangle: NormalizedRect): ImagePixelRect {
    require(width > 0 && height > 0)
    val rect = ImageTransformContract.normalizeRect(rectangle)
    val left = floor(rect.x * width + 1e-8).toInt().coerceIn(0, width - 1)
    val top = floor(rect.y * height + 1e-8).toInt().coerceIn(0, height - 1)
    val right = ceil((rect.x + rect.width) * width - 1e-8).toInt().coerceIn(left + 1, width)
    val bottom = ceil((rect.y + rect.height) * height - 1e-8).toInt().coerceIn(top + 1, height)
    return ImagePixelRect(left, top, right, bottom)
}

internal fun previewSampleSize(width: Int, height: Int, maximum: Int): Int {
    require(width > 0 && height > 0 && maximum > 0)
    var sample = 1
    while (ceil(max(width, height).toDouble() / sample) > maximum) sample *= 2
    return sample
}

internal data class ImageDisplayRect(val left: Float, val top: Float, val width: Float, val height: Float)

/** Use the very same rectangle for drawing pixels, drawing crop outlines and pointer conversion. */
internal fun imageDisplayRect(canvasWidth: Float, canvasHeight: Float, imageWidth: Int, imageHeight: Int, inset: Float): ImageDisplayRect {
    val scale = min((canvasWidth - 2 * inset).coerceAtLeast(1f) / imageWidth, (canvasHeight - 2 * inset).coerceAtLeast(1f) / imageHeight)
    val width = imageWidth * scale
    val height = imageHeight * scale
    return ImageDisplayRect((canvasWidth - width) / 2, (canvasHeight - height) / 2, width, height)
}

internal fun rotateAnnotationClockwise(annotation: ImageAnnotationObject): ImageAnnotationObject {
    fun rotate(point: NormalizedPoint) = ImageTransformContract.normalizePoint(NormalizedPoint(1.0 - point.y, point.x))
    return when (annotation) {
        is ImageAnnotationObject.Pen -> annotation.copy(points = annotation.points.map(::rotate))
        is ImageAnnotationObject.Arrow -> annotation.copy(start = rotate(annotation.start), end = rotate(annotation.end))
        is ImageAnnotationObject.Redaction -> annotation.copy(points = annotation.points.map(::rotate))
    }
}
