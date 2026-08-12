package com.mathnotes.capture.imageedit

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageTransformContractTest {
    @Test
    fun sharedFixturesMatchAndroidNormalization() {
        val root = JSONObject(requireNotNull(javaClass.classLoader?.getResource("image-transform-v1-fixtures.json")).readText())
        val cases = root.getJSONArray("cases")
        repeat(cases.length()) { index ->
            val testCase = cases.getJSONObject(index)
            assertEquals(
                testCase.getJSONArray("expected").toOperationList(),
                ImageTransformContract.normalizeOperations(testCase.getJSONArray("input").toOperationList())
            )
        }
    }

    @Test
    fun normalizedSidecarIsAuditable() {
        ImageTransformContract.validate(
            ImageTransformSidecar(
                sourceAsset = "captures/original.jpg",
                sourceSha256 = "a".repeat(64),
                outputAsset = "captures/derived.png",
                operations = listOf(
                    ImageTransformOperation.Crop(NormalizedRect(0.1, 0.2, 0.7, 0.6))
                ),
                createdAt = "2026-07-15T00:00:00.000Z"
            )
        )
    }

    @Test
    fun rejectsAbsoluteAndTraversingAssetPaths() {
        val base = ImageTransformSidecar(
            sourceAsset = "photo.jpg",
            sourceSha256 = "a".repeat(64),
            outputAsset = null,
            operations = emptyList(),
            createdAt = "2026-07-15T00:00:00.000Z"
        )
        assertThrows(IllegalArgumentException::class.java) {
            ImageTransformContract.validate(base.copy(sourceAsset = "C:/private/photo.jpg"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            ImageTransformContract.validate(base.copy(sourceAsset = "../photo.jpg"))
        }
    }

    @Test
    fun perspectiveCornersMustRemainConvexAndOrdered() {
        assertTrue(
            ImageTransformContract.isValidPerspectiveCorners(
                listOf(
                    NormalizedPoint(0.05, 0.1),
                    NormalizedPoint(0.92, 0.04),
                    NormalizedPoint(0.96, 0.9),
                    NormalizedPoint(0.08, 0.96)
                )
            )
        )
        assertFalse(
            ImageTransformContract.isValidPerspectiveCorners(
                listOf(
                    NormalizedPoint(0.05, 0.1),
                    NormalizedPoint(0.96, 0.9),
                    NormalizedPoint(0.92, 0.04),
                    NormalizedPoint(0.08, 0.96)
                )
            )
        )
    }

    @Test
    fun acceptsAuditablePenAndArrowAnnotations() {
        ImageTransformContract.validate(
            ImageTransformSidecar(
                sourceAsset = "captures/original.jpg",
                sourceSha256 = "a".repeat(64),
                outputAsset = "captures/derived.png",
                operations = emptyList(),
                annotations = listOf(
                    ImageAnnotationObject.Pen(
                        id = "pen-1",
                        points = listOf(NormalizedPoint(0.1, 0.2), NormalizedPoint(0.4, 0.5)),
                        color = "#187857",
                        width = 0.006
                    ),
                    ImageAnnotationObject.Arrow(
                        id = "arrow-1",
                        start = NormalizedPoint(0.2, 0.2),
                        end = NormalizedPoint(0.8, 0.7),
                        color = "#187857",
                        width = 0.006
                    )
                ),
                createdAt = "2026-07-15T00:00:00.000Z"
            )
        )
    }

    @Test
    fun rejectsMalformedAnnotations() {
        val base = ImageTransformSidecar(
            sourceAsset = "captures/original.jpg",
            sourceSha256 = "a".repeat(64),
            outputAsset = "captures/derived.png",
            operations = emptyList(),
            createdAt = "2026-07-15T00:00:00.000Z"
        )
        assertThrows(IllegalArgumentException::class.java) {
            ImageTransformContract.validate(
                base.copy(annotations = listOf(
                    ImageAnnotationObject.Arrow("arrow-1", NormalizedPoint(0.5, 0.5), NormalizedPoint(0.5, 0.5), "#187857", 0.006)
                ))
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            ImageTransformContract.validate(
                base.copy(annotations = listOf(
                    ImageAnnotationObject.Pen("pen-1", listOf(NormalizedPoint(-0.1, 0.2), NormalizedPoint(0.4, 0.5)), "green", 0.006)
                ))
            )
        }
    }
}

private fun JSONArray.toOperationList(): List<ImageTransformOperation> = List(length()) { index ->
    getJSONObject(index).toOperation()
}

private fun JSONObject.toOperation(): ImageTransformOperation = when (getString("type")) {
    "rotate" -> ImageTransformOperation.Rotate(getInt("quarterTurns"))
    "crop" -> ImageTransformOperation.Crop(getJSONObject("rect").toRect())
    "perspective" -> ImageTransformOperation.Perspective(getJSONArray("corners").toPoints())
    "lasso" -> ImageTransformOperation.Lasso(
        points = getJSONArray("points").toPoints(),
        boundingBox = getJSONObject("boundingBox").toRect(),
        outsideFill = getString("outsideFill")
    )
    else -> error("Unknown image transform operation: ${getString("type")}")
}

private fun JSONArray.toPoints(): List<NormalizedPoint> = List(length()) { index ->
    getJSONObject(index).let { NormalizedPoint(it.getDouble("x"), it.getDouble("y")) }
}

private fun JSONObject.toRect(): NormalizedRect = NormalizedRect(
    x = getDouble("x"),
    y = getDouble("y"),
    width = getDouble("width"),
    height = getDouble("height")
)
