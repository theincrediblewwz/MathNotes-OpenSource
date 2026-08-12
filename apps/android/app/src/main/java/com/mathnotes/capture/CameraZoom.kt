package com.mathnotes.capture

import kotlin.math.abs
import kotlin.math.roundToInt

internal fun clampCameraZoom(ratio: Float, minRatio: Float, maxRatio: Float): Float =
    ratio.coerceIn(minRatio, maxRatio)

internal fun cameraZoomPresets(minRatio: Float, maxRatio: Float): List<Float> {
    if (maxRatio <= minRatio) return listOf(minRatio)

    val candidates = buildList {
        if (minRatio < 0.95f) add(minRatio)
        add(1f.coerceIn(minRatio, maxRatio))
        if (maxRatio >= 1.75f) add(2f.coerceAtMost(maxRatio))
        when {
            maxRatio >= 4.5f -> add(5f.coerceAtMost(maxRatio))
            maxRatio >= 2.5f -> add(maxRatio)
        }
    }.toMutableList()
    if (candidates.size < 4 && candidates.none { abs(it - maxRatio) < 0.05f }) {
        candidates.add(maxRatio)
    }
    return candidates.distinctBy { (it * 100).roundToInt() }
}

internal fun formatCameraZoom(ratio: Float): String {
    val rounded = ratio.roundToInt()
    return if (abs(ratio - rounded) < 0.05f) "${rounded}×" else "%.1f×".format(ratio)
}
