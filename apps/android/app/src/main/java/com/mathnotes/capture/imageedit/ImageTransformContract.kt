package com.mathnotes.capture.imageedit

import kotlin.math.max
import kotlin.math.min
import kotlin.math.round

const val IMAGE_TRANSFORM_VERSION = 1
const val IMAGE_TRANSFORM_OUTSIDE_FILL = "#ffffff"

data class NormalizedPoint(val x: Double, val y: Double)

data class NormalizedRect(
    val x: Double,
    val y: Double,
    val width: Double,
    val height: Double
)

sealed interface ImageTransformOperation {
    data class Rotate(val quarterTurns: Int) : ImageTransformOperation
    data class Perspective(val corners: List<NormalizedPoint>) : ImageTransformOperation
    data class Crop(val rect: NormalizedRect) : ImageTransformOperation
    data class Lasso(
        val points: List<NormalizedPoint>,
        val boundingBox: NormalizedRect,
        val outsideFill: String = IMAGE_TRANSFORM_OUTSIDE_FILL
    ) : ImageTransformOperation
}

sealed interface ImageAnnotationObject {
    val id: String
    val color: String
    val width: Double

    data class Pen(
        override val id: String,
        val points: List<NormalizedPoint>,
        override val color: String,
        override val width: Double
    ) : ImageAnnotationObject

    data class Arrow(
        override val id: String,
        val start: NormalizedPoint,
        val end: NormalizedPoint,
        override val color: String,
        override val width: Double
    ) : ImageAnnotationObject
}

data class ImageTransformSidecar(
    val version: Int = IMAGE_TRANSFORM_VERSION,
    val sourceAsset: String,
    val sourceSha256: String,
    val outputAsset: String?,
    val outputMimeType: String = "image/png",
    val operations: List<ImageTransformOperation>,
    val annotations: List<ImageAnnotationObject> = emptyList(),
    val createdAt: String
)

object ImageTransformContract {
    fun clampNormalized(value: Double): Double {
        if (!value.isFinite()) return 0.0
        return roundNormalized(value.coerceIn(0.0, 1.0))
    }

    fun normalizePoint(point: NormalizedPoint): NormalizedPoint = NormalizedPoint(
        x = clampNormalized(point.x),
        y = clampNormalized(point.y)
    )

    fun normalizeRect(rect: NormalizedRect): NormalizedRect {
        val start = normalizePoint(NormalizedPoint(rect.x, rect.y))
        val end = normalizePoint(NormalizedPoint(rect.x + rect.width, rect.y + rect.height))
        val left = min(start.x, end.x)
        val top = min(start.y, end.y)
        return NormalizedRect(
            x = left,
            y = top,
            width = roundNormalized(max(0.0, max(start.x, end.x) - left)),
            height = roundNormalized(max(0.0, max(start.y, end.y) - top))
        )
    }

    fun boundingBoxForPoints(points: List<NormalizedPoint>): NormalizedRect {
        if (points.isEmpty()) return NormalizedRect(0.0, 0.0, 0.0, 0.0)
        val normalized = points.map(::normalizePoint)
        val left = normalized.minOf { it.x }
        val top = normalized.minOf { it.y }
        return NormalizedRect(
            x = left,
            y = top,
            width = roundNormalized(normalized.maxOf { it.x } - left),
            height = roundNormalized(normalized.maxOf { it.y } - top)
        )
    }

    fun isValidPerspectiveCorners(corners: List<NormalizedPoint>): Boolean {
        if (corners.size != 4) return false
        val normalized = corners.map(::normalizePoint)
        val crosses = normalized.indices.map { index ->
            val point = normalized[index]
            val next = normalized[(index + 1) % normalized.size]
            val after = normalized[(index + 2) % normalized.size]
            (next.x - point.x) * (after.y - next.y) - (next.y - point.y) * (after.x - next.x)
        }
        val direction = crosses.firstOrNull { kotlin.math.abs(it) > 1e-6 }?.let { kotlin.math.sign(it) } ?: 0.0
        val area = kotlin.math.abs(normalized.indices.sumOf { index ->
            val point = normalized[index]
            val next = normalized[(index + 1) % normalized.size]
            point.x * next.y - next.x * point.y
        } / 2.0)
        return direction != 0.0 && area >= 0.001 && crosses.all {
            kotlin.math.sign(it) == direction && kotlin.math.abs(it) > 1e-6
        }
    }

    fun normalizeOperations(operations: List<ImageTransformOperation>): List<ImageTransformOperation> = operations
        .map { operation ->
            when (operation) {
                is ImageTransformOperation.Rotate -> operation
                is ImageTransformOperation.Perspective -> operation.copy(corners = operation.corners.map(::normalizePoint))
                is ImageTransformOperation.Crop -> operation.copy(rect = normalizeRect(operation.rect))
                is ImageTransformOperation.Lasso -> {
                    val points = operation.points.map(::normalizePoint)
                    operation.copy(
                        points = points,
                        boundingBox = boundingBoxForPoints(points),
                        outsideFill = IMAGE_TRANSFORM_OUTSIDE_FILL
                    )
                }
            }
        }
        .withIndex()
        .sortedWith(compareBy<IndexedValue<ImageTransformOperation>> { operationOrder(it.value) }.thenBy { it.index })
        .map { it.value }

    fun validate(sidecar: ImageTransformSidecar) {
        require(sidecar.version == IMAGE_TRANSFORM_VERSION) { "Unsupported image transform version" }
        requirePortableAssetPath(sidecar.sourceAsset, "sourceAsset")
        sidecar.outputAsset?.let { requirePortableAssetPath(it, "outputAsset") }
        require(SHA_256_REGEX.matches(sidecar.sourceSha256)) { "sourceSha256 must be a SHA-256 hex digest" }
        require(sidecar.outputMimeType == "image/png") { "Image transform output must be PNG" }
        require(sidecar.operations == normalizeOperations(sidecar.operations)) { "Operations must be normalized and ordered" }
        sidecar.operations.forEach { operation ->
            when (operation) {
                is ImageTransformOperation.Perspective -> require(isValidPerspectiveCorners(operation.corners)) {
                    "Perspective corners must form a non-self-intersecting convex quadrilateral"
                }
                is ImageTransformOperation.Crop -> require(operation.rect.width > 0 && operation.rect.height > 0) {
                    "Crop rectangle must have positive area"
                }
                is ImageTransformOperation.Lasso -> {
                    require(operation.points.size >= 3) { "Lasso requires at least three points" }
                    require(operation.boundingBox.width > 0 && operation.boundingBox.height > 0) {
                        "Lasso bounding box must have positive area"
                    }
                }
                else -> Unit
            }
        }
        sidecar.annotations.forEach { annotation ->
            require(ANNOTATION_ID_REGEX.matches(annotation.id)) { "Annotation id is invalid" }
            require(ANNOTATION_COLOR_REGEX.matches(annotation.color)) { "Annotation color must be a six-digit hex value" }
            require(annotation.width.isFinite() && annotation.width in 0.001..0.1) { "Annotation width is outside the supported range" }
            when (annotation) {
                is ImageAnnotationObject.Pen -> {
                    require(annotation.points.size >= 2) { "Pen annotation requires at least two points" }
                    annotation.points.forEach(::requireNormalizedPoint)
                }
                is ImageAnnotationObject.Arrow -> {
                    requireNormalizedPoint(annotation.start)
                    requireNormalizedPoint(annotation.end)
                    require(kotlin.math.hypot(annotation.end.x - annotation.start.x, annotation.end.y - annotation.start.y) >= 0.002) {
                        "Arrow annotation is too short"
                    }
                }
            }
        }
    }

    private fun operationOrder(operation: ImageTransformOperation): Int = when (operation) {
        is ImageTransformOperation.Rotate -> 0
        is ImageTransformOperation.Perspective -> 1
        is ImageTransformOperation.Crop -> 2
        is ImageTransformOperation.Lasso -> 3
    }

    private fun roundNormalized(value: Double): Double = round(value * 1_000_000.0) / 1_000_000.0

    private fun requirePortableAssetPath(value: String, field: String) {
        val normalized = value.replace('\\', '/')
        require(
            normalized.isNotBlank() &&
                !normalized.startsWith('/') &&
                !WINDOWS_ABSOLUTE_PATH_REGEX.containsMatchIn(normalized) &&
                normalized.split('/').none { it == ".." }
        ) { "$field must be a portable relative asset path" }
    }

    private fun requireNormalizedPoint(point: NormalizedPoint) {
        require(point.x.isFinite() && point.y.isFinite() && point.x in 0.0..1.0 && point.y in 0.0..1.0) {
            "Annotation point must use normalized coordinates"
        }
    }

    private val SHA_256_REGEX = Regex("^[a-fA-F0-9]{64}$")
    private val WINDOWS_ABSOLUTE_PATH_REGEX = Regex("^[A-Za-z]:/")
    private val ANNOTATION_ID_REGEX = Regex("^[A-Za-z0-9._-]{1,80}$")
    private val ANNOTATION_COLOR_REGEX = Regex("^#[0-9A-Fa-f]{6}$")
}
