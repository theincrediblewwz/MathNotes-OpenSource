package com.mathnotes.capture.imageedit

import java.io.File

data class ImageEditDraft(
    val sourceFile: File,
    val sourceName: String,
    val mimeType: String,
    val captureSource: String,
    val stageHistory: List<ImageEditStage> = emptyList(),
    val cleanupFiles: List<File> = emptyList()
) {
    fun canUndoStage(): Boolean = stageHistory.isNotEmpty()

    fun undoStage(): ImageEditDraft {
        val previous = stageHistory.lastOrNull() ?: return this
        return copy(
            sourceFile = previous.sourceFile,
            mimeType = previous.mimeType,
            stageHistory = stageHistory.dropLast(1),
            cleanupFiles = (cleanupFiles + sourceFile).distinctBy(File::getAbsolutePath)
        )
    }
}

data class ImageEditStage(
    val sourceFile: File,
    val mimeType: String
)

data class RenderedImageEdit(
    val outputFile: File,
    val sidecarFile: File,
    val operations: List<ImageTransformOperation>
)
