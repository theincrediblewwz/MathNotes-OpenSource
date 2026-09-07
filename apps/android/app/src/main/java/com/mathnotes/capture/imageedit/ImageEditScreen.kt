package com.mathnotes.capture.imageedit

import android.graphics.Bitmap
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import com.mathnotes.capture.R
import com.mathnotes.capture.ui.MathNotesColors
import com.mathnotes.capture.ui.MathNotesPrimaryButton
import com.mathnotes.capture.ui.MathNotesSecondaryButton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

@Composable
fun ImageEditScreen(
    draft: ImageEditDraft,
    saving: Boolean,
    message: String?,
    onApply: (
        sourceDraft: ImageEditDraft,
        rotationQuarterTurns: Int,
        perspectiveCorners: List<NormalizedPoint>?,
        cropRect: NormalizedRect?,
        lassoPoints: List<NormalizedPoint>?,
        annotations: List<ImageAnnotationObject>
    ) -> Unit,
    onWorkingDraftChange: (ImageEditDraft) -> Unit,
    onDiscard: () -> Unit
) {
    var previewMessage by remember(draft.sourceFile) { mutableStateOf<String?>(null) }
    val sourcePreview by produceState<Bitmap?>(initialValue = null, draft.sourceFile) {
        value = null
        val result = withContext(Dispatchers.IO) { runCatching { AndroidImageTransformer.loadPreview(draft.sourceFile) } }
        result.fold(onSuccess = { value = it }, onFailure = { previewMessage = "无法打开图片：${it.message ?: "请重新选择"}" })
    }
    var quarterTurns by remember(draft.sourceFile) { mutableIntStateOf(0) }
    var selectionTool by remember { mutableStateOf(ImageSelectionTool.RECTANGLE) }
    var brushMenuOpen by remember { mutableStateOf(false) }
    var cropRect by remember(draft.sourceFile) { mutableStateOf(FULL_RECT) }
    var cropUndo by remember(draft.sourceFile) { mutableStateOf<NormalizedRect?>(null) }
    var lassoPoints by remember(draft.sourceFile) { mutableStateOf(emptyList<NormalizedPoint>()) }
    var lassoHistory by remember(draft.sourceFile) { mutableStateOf(emptyList<List<NormalizedPoint>>()) }
    var perspectiveEnabled by remember(draft.sourceFile) { mutableStateOf(false) }
    var perspectiveCorners by remember(draft.sourceFile) { mutableStateOf(DEFAULT_PERSPECTIVE_CORNERS) }
    var perspectiveUndo by remember(draft.sourceFile) { mutableStateOf<List<NormalizedPoint>?>(null) }
    var annotations by remember(draft.sourceFile) { mutableStateOf(emptyList<ImageAnnotationObject>()) }
    var annotationHistory by remember(draft.sourceFile) { mutableStateOf(emptyList<List<ImageAnnotationObject>>()) }
    var selectedAnnotationId by remember(draft.sourceFile) { mutableStateOf<String?>(null) }
    var annotationColor by remember { mutableStateOf(ANNOTATION_COLORS.first()) }
    var annotationWidth by remember { mutableStateOf(DEFAULT_ANNOTATION_WIDTH) }
    var redactionWidth by remember { mutableStateOf(0.05f) }
    var stageApplying by remember(draft.sourceFile) { mutableStateOf(false) }
    var stageMessage by remember(draft.sourceFile) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val preview = remember(sourcePreview, quarterTurns) {
        sourcePreview?.let { AndroidImageTransformer.rotatePreview(it, quarterTurns) }
    }
    val hasPendingEdits = quarterTurns != 0 ||
        perspectiveEnabled ||
        cropRect != FULL_RECT ||
        lassoPoints.size >= 3 ||
        annotations.isNotEmpty()

    fun applyStage(nextTool: ImageSelectionTool? = null) {
        val stageTurns = quarterTurns
        val stagePerspective = perspectiveCorners.takeIf { perspectiveEnabled }
        val stageCrop = cropRect.takeUnless { it == FULL_RECT }
        val stageLasso = lassoPoints.takeIf { it.size >= 3 }
        val stageAnnotations = annotations
        stageApplying = true
        stageMessage = null
        scope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    AndroidImageTransformer.renderStage(
                        draft = draft,
                        outputDirectory = File(draft.sourceFile.parentFile, "edit-stages"),
                        rotationQuarterTurns = stageTurns,
                        perspectiveCorners = stagePerspective,
                        cropRect = stageCrop,
                        lassoPoints = stageLasso,
                        annotations = stageAnnotations
                    )
                }
            }.fold(
                onSuccess = {
                    onWorkingDraftChange(it)
                    if (nextTool != null) selectionTool = nextTool
                },
                onFailure = { stageMessage = "无法应用当前操作：${it.message ?: "请重试"}" }
            )
            stageApplying = false
        }
    }

    fun selectTool(tool: ImageSelectionTool) {
        // Crop/annotation coordinates belong to the image actually on screen. Bake a pending
        // perspective before leaving it (and bake existing edits before entering perspective).
        if ((perspectiveEnabled && tool != ImageSelectionTool.PERSPECTIVE) ||
            (tool == ImageSelectionTool.PERSPECTIVE && selectionTool != tool && hasPendingEdits)) {
            applyStage(tool)
        } else {
            selectionTool = tool
        }
    }

    // Tool selection survives a staged image replacement; its geometry is reset to that image.
    androidx.compose.runtime.LaunchedEffect(draft.sourceFile, selectionTool) {
        if (selectionTool == ImageSelectionTool.PERSPECTIVE) perspectiveEnabled = true
    }

    DisposableEffect(preview) {
        onDispose {
            if (preview != null && preview !== sourcePreview && !preview.isRecycled) preview.recycle()
        }
    }
    DisposableEffect(sourcePreview) {
        val currentSource = sourcePreview
        onDispose {
            if (currentSource != null && !currentSource.isRecycled) currentSource.recycle()
        }
    }

    Column(Modifier.fillMaxSize().background(MathNotesColors.Background)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Column(Modifier.weight(1f)) {
                Text("裁剪素材", style = MaterialTheme.typography.titleLarge, color = MathNotesColors.Ink)
                Text(draft.sourceName, style = MaterialTheme.typography.bodySmall, color = MathNotesColors.Muted, maxLines = 1)
            }
            IconButton(enabled = !saving && !stageApplying, onClick = onDiscard) {
                Icon(painterResource(R.drawable.ic_mathnotes_close), contentDescription = "放弃这张素材", tint = MathNotesColors.Ink)
            }
        }

        Surface(
            modifier = Modifier.fillMaxWidth().weight(1f).padding(horizontal = 14.dp),
            color = Color(0xFFEEEDEA),
            shape = MaterialTheme.shapes.medium
        ) {
            if (preview == null) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    if (previewMessage != null) Text(previewMessage!!, modifier = Modifier.padding(24.dp), color = MathNotesColors.Muted)
                    else CircularProgressIndicator(color = MathNotesColors.Accent)
                }
            } else {
                Box(Modifier.fillMaxSize()) {
                    val bitmap = preview!!
                    val bitmapPaint = remember { android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG) }
                    Canvas(Modifier.fillMaxSize().semantics { contentDescription = "待裁剪图片" }) {
                        val display = fittedImageRect(size, bitmap.width, bitmap.height, IMAGE_CANVAS_INSET_DP.dp.toPx())
                        drawIntoCanvas { canvas ->
                            canvas.nativeCanvas.drawBitmap(bitmap, null, android.graphics.RectF(display.left, display.top, display.right, display.bottom), bitmapPaint)
                        }
                    }
                    when (selectionTool) {
                        ImageSelectionTool.PERSPECTIVE -> PerspectiveOverlay(
                            bitmapWidth = preview!!.width,
                            bitmapHeight = preview!!.height,
                            corners = perspectiveCorners,
                            onInteractionStart = { perspectiveUndo = perspectiveCorners },
                            onCornersChange = {
                                if (ImageTransformContract.isValidPerspectiveCorners(it)) perspectiveCorners = it
                            },
                            modifier = Modifier.fillMaxSize()
                        )
                        ImageSelectionTool.RECTANGLE -> CropOverlay(
                            bitmapWidth = preview!!.width,
                            bitmapHeight = preview!!.height,
                            cropRect = cropRect,
                            onInteractionStart = { cropUndo = cropRect },
                            onCropRectChange = { cropRect = ImageTransformContract.normalizeRect(it) },
                            modifier = Modifier.fillMaxSize()
                        )
                        ImageSelectionTool.LASSO -> LassoOverlay(
                            bitmapWidth = preview!!.width,
                            bitmapHeight = preview!!.height,
                            points = lassoPoints,
                            onInteractionStart = { lassoHistory = lassoHistory + listOf(lassoPoints) },
                            onPointsChange = { lassoPoints = it },
                            modifier = Modifier.fillMaxSize()
                        )
                        ImageSelectionTool.PEN, ImageSelectionTool.ARROW, ImageSelectionTool.REDACTION -> Unit
                    }
                    AnnotationOverlay(
                        bitmapWidth = preview!!.width,
                        bitmapHeight = preview!!.height,
                        annotations = annotations,
                        selectedId = selectedAnnotationId,
                        activeTool = selectionTool.takeIf { it.isAnnotation() },
                        annotationColor = annotationColor,
                        annotationWidth = if (selectionTool == ImageSelectionTool.REDACTION) redactionWidth else annotationWidth,
                        onInteractionStart = { annotationHistory = annotationHistory + listOf(annotations) },
                        onAnnotationsChange = { annotations = it },
                        onSelectedIdChange = { selectedAnnotationId = it },
                        modifier = Modifier.fillMaxSize()
                    )
                    if (saving || stageApplying) {
                        Box(
                            Modifier.fillMaxSize().background(Color.White.copy(alpha = 0.35f)).pointerInput(Unit) {
                                awaitPointerEventScope {
                                    while (true) awaitPointerEvent().changes.forEach { it.consume() }
                                }
                            },
                            contentAlignment = Alignment.Center
                        ) { CircularProgressIndicator(color = MathNotesColors.Accent) }
                    }
                }
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            MathNotesSecondaryButton(
                text = "透视",
                onClick = { selectTool(ImageSelectionTool.PERSPECTIVE) },
                enabled = preview != null && !saving && !stageApplying,
                selected = selectionTool == ImageSelectionTool.PERSPECTIVE,
                modifier = Modifier.weight(1f)
            )
            MathNotesSecondaryButton(
                text = "矩形裁剪",
                onClick = {
                    selectTool(ImageSelectionTool.RECTANGLE)
                    lassoPoints = emptyList()
                },
                enabled = preview != null && !saving && !stageApplying,
                selected = selectionTool == ImageSelectionTool.RECTANGLE,
                modifier = Modifier.weight(1f)
            )
            MathNotesSecondaryButton(
                text = "套索裁剪",
                onClick = {
                    selectTool(ImageSelectionTool.LASSO)
                    cropRect = FULL_RECT
                },
                enabled = preview != null && !saving && !stageApplying,
                selected = selectionTool == ImageSelectionTool.LASSO,
                modifier = Modifier.weight(1f)
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Box(Modifier.weight(1f)) {
                MathNotesSecondaryButton(
                    text = when (selectionTool) { ImageSelectionTool.PEN -> "画笔 · 笔"; ImageSelectionTool.ARROW -> "画笔 · 箭头"; ImageSelectionTool.REDACTION -> "画笔 · 马赛克"; else -> "画笔" },
                    onClick = { brushMenuOpen = true },
                    enabled = preview != null && !saving && !stageApplying,
                    selected = selectionTool.isAnnotation(),
                    modifier = Modifier.fillMaxWidth()
                )
                androidx.compose.material3.DropdownMenu(expanded = brushMenuOpen, onDismissRequest = { brushMenuOpen = false }) {
                    listOf("笔" to ImageSelectionTool.PEN, "箭头" to ImageSelectionTool.ARROW, "马赛克（矩形遮盖）" to ImageSelectionTool.REDACTION).forEach { (label, tool) ->
                        androidx.compose.material3.DropdownMenuItem(text = { Text(if (selectionTool == tool) "$label ✓" else label) },
                            onClick = { brushMenuOpen = false; selectTool(tool) })
                    }
                }
            }
            MathNotesSecondaryButton(
                text = "删除标注",
                onClick = {
                    val selected = selectedAnnotationId
                    if (selected != null) {
                        annotationHistory = annotationHistory + listOf(annotations)
                        annotations = annotations.filterNot { it.id == selected }
                        selectedAnnotationId = null
                    }
                },
                enabled = preview != null && !saving && !stageApplying && selectedAnnotationId != null,
                modifier = Modifier.weight(1f)
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 9.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            if (selectionTool == ImageSelectionTool.REDACTION) {
                Text("拖出矩形，隐藏区域会以纯白完全覆盖", style = MaterialTheme.typography.labelMedium, color = MathNotesColors.Muted)
            } else {
              Text("标注颜色", style = MaterialTheme.typography.labelMedium, color = MathNotesColors.Muted)
              ANNOTATION_COLORS.forEach { color ->
                val selected = annotationColor == color
                Surface(
                    modifier = Modifier
                        .size(if (selected) 30.dp else 26.dp)
                        .clip(CircleShape)
                        .clickable(enabled = !saving && !stageApplying) { annotationColor = color },
                    shape = CircleShape,
                    color = Color(android.graphics.Color.parseColor(color)),
                    border = BorderStroke(if (selected) 3.dp else 1.dp, if (selected) MathNotesColors.Paper else MathNotesColors.Line),
                    shadowElevation = if (selected) 3.dp else 0.dp,
                    content = {}
                )
              }
            }
        }
        if (selectionTool != ImageSelectionTool.REDACTION) Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(if (selectionTool == ImageSelectionTool.REDACTION) "遮盖范围" else "粗细", style = MaterialTheme.typography.labelMedium, color = MathNotesColors.Muted)
            Slider(
                value = if (selectionTool == ImageSelectionTool.REDACTION) redactionWidth else annotationWidth,
                onValueChange = { if (selectionTool == ImageSelectionTool.REDACTION) redactionWidth = it else annotationWidth = it },
                valueRange = if (selectionTool == ImageSelectionTool.REDACTION) 0.02f..0.1f else MIN_ANNOTATION_WIDTH..MAX_ANNOTATION_WIDTH,
                enabled = !saving && !stageApplying,
                modifier = Modifier.weight(1f)
            )
            Text(
                text = "${((if (selectionTool == ImageSelectionTool.REDACTION) redactionWidth else annotationWidth) * 1000).toInt()}",
                style = MaterialTheme.typography.labelMedium,
                color = MathNotesColors.Ink
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            MathNotesSecondaryButton(
                text = "旋转 90°",
                onClick = {
                    quarterTurns = (quarterTurns + 1) % 4
                    cropRect = FULL_RECT
                    cropUndo = null
                    lassoPoints = emptyList()
                    lassoHistory = emptyList()
                    perspectiveEnabled = false
                    perspectiveCorners = DEFAULT_PERSPECTIVE_CORNERS
                    perspectiveUndo = null
                    annotations = annotations.map(::rotateAnnotationClockwise)
                    annotationHistory = annotationHistory.map { history -> history.map(::rotateAnnotationClockwise) }
                    selectedAnnotationId = null
                    if (selectionTool == ImageSelectionTool.PERSPECTIVE) selectionTool = ImageSelectionTool.RECTANGLE
                },
                enabled = preview != null && !saving && !stageApplying,
                modifier = Modifier.weight(1f)
            )
            MathNotesSecondaryButton(
                text = "撤销",
                onClick = {
                    var handled = false
                    if (selectionTool.isAnnotation()) {
                        if (annotationHistory.isNotEmpty()) {
                            annotations = annotationHistory.last()
                            annotationHistory = annotationHistory.dropLast(1)
                            selectedAnnotationId = null
                            handled = true
                        }
                    } else if (selectionTool == ImageSelectionTool.PERSPECTIVE) {
                        perspectiveUndo?.let {
                            perspectiveCorners = it
                            handled = true
                        }
                        perspectiveUndo = null
                    } else if (selectionTool == ImageSelectionTool.RECTANGLE) {
                        cropUndo?.let {
                            cropRect = it
                            handled = true
                        }
                        cropUndo = null
                    } else if (lassoHistory.isNotEmpty()) {
                        lassoPoints = lassoHistory.last()
                        lassoHistory = lassoHistory.dropLast(1)
                        handled = true
                    }
                    if (!handled && draft.canUndoStage()) {
                        onWorkingDraftChange(draft.undoStage())
                    }
                },
                enabled = preview != null && !saving && !stageApplying && (
                    (selectionTool.isAnnotation() && annotationHistory.isNotEmpty()) ||
                        (selectionTool == ImageSelectionTool.PERSPECTIVE && perspectiveUndo != null) ||
                        (selectionTool == ImageSelectionTool.RECTANGLE && cropUndo != null) ||
                        (selectionTool == ImageSelectionTool.LASSO && lassoHistory.isNotEmpty()) ||
                        draft.canUndoStage()
                    ),
                modifier = Modifier.weight(1f)
            )
            MathNotesSecondaryButton(
                text = "重置",
                onClick = {
                    quarterTurns = 0
                    cropRect = FULL_RECT
                    cropUndo = null
                    lassoPoints = emptyList()
                    lassoHistory = emptyList()
                    perspectiveEnabled = false
                    perspectiveCorners = DEFAULT_PERSPECTIVE_CORNERS
                    perspectiveUndo = null
                    annotations = emptyList()
                    annotationHistory = emptyList()
                    selectedAnnotationId = null
                    selectionTool = ImageSelectionTool.RECTANGLE
                },
                enabled = preview != null && !saving && !stageApplying,
                modifier = Modifier.weight(1f)
            )
        }
        MathNotesSecondaryButton(
            text = if (stageApplying) "正在应用当前操作…" else "应用当前操作",
            onClick = { applyStage(ImageSelectionTool.RECTANGLE) },
            enabled = preview != null && !saving && !stageApplying && hasPendingEdits,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 9.dp)
        )
        (stageMessage ?: message)?.let {
            Text(it, color = MathNotesColors.Muted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 18.dp))
            Spacer(Modifier.height(6.dp))
        }
        MathNotesPrimaryButton(
            text = if (saving) "正在生成素材…" else "应用并加入队列",
            onClick = {
                onApply(
                    draft,
                    quarterTurns,
                    perspectiveCorners.takeIf { perspectiveEnabled },
                    cropRect.takeUnless { it == FULL_RECT },
                    lassoPoints.takeIf { it.size >= 3 },
                    annotations
                )
            },
            enabled = preview != null && !saving && !stageApplying,
            modifier = Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, bottom = 18.dp)
        )
    }
}

@Composable
private fun PerspectiveOverlay(
    bitmapWidth: Int,
    bitmapHeight: Int,
    corners: List<NormalizedPoint>,
    onInteractionStart: () -> Unit,
    onCornersChange: (List<NormalizedPoint>) -> Unit,
    modifier: Modifier = Modifier
) {
    var activeCorner by remember { mutableStateOf<Int?>(null) }
    val currentCorners by rememberUpdatedState(corners)
    val currentOnInteractionStart by rememberUpdatedState(onInteractionStart)
    val currentOnCornersChange by rememberUpdatedState(onCornersChange)
    Canvas(
        modifier.pointerInput(bitmapWidth, bitmapHeight) {
            val handleHitRadius = 58.dp.toPx()
            detectDragGestures(
                onDragStart = { position ->
                    val display = fittedImageRect(Size(size.width.toFloat(), size.height.toFloat()), bitmapWidth, bitmapHeight, IMAGE_CANVAS_INSET_DP.dp.toPx())
                    val displayCorners = currentCorners.map { it.toDisplayOffset(display) }
                    activeCorner = displayCorners.indices.minByOrNull { index ->
                        val point = displayCorners[index]
                        (point.x - position.x) * (point.x - position.x) + (point.y - position.y) * (point.y - position.y)
                    }?.takeIf { index -> distanceSquared(displayCorners[index], position) <= handleHitRadius * handleHitRadius }
                    if (activeCorner != null) currentOnInteractionStart()
                },
                onDragEnd = { activeCorner = null },
                onDragCancel = { activeCorner = null },
                onDrag = { change, _ ->
                    val index = activeCorner ?: return@detectDragGestures
                    change.consume()
                    val display = fittedImageRect(Size(size.width.toFloat(), size.height.toFloat()), bitmapWidth, bitmapHeight, IMAGE_CANVAS_INSET_DP.dp.toPx())
                    val next = currentCorners.toMutableList().apply { this[index] = change.position.toNormalized(display) }
                    if (ImageTransformContract.isValidPerspectiveCorners(next)) currentOnCornersChange(next)
                }
            )
        }
    ) {
        val display = fittedImageRect(size, bitmapWidth, bitmapHeight, IMAGE_CANVAS_INSET_DP.dp.toPx())
        val displayCorners = corners.map { it.toDisplayOffset(display) }
        val path = Path().apply {
            moveTo(displayCorners[0].x, displayCorners[0].y)
            displayCorners.drop(1).forEach { lineTo(it.x, it.y) }
            close()
        }
        drawPath(path, Color.Black.copy(alpha = 0.12f))
        drawPath(path, MathNotesColors.Accent, style = Stroke(width = 3.dp.toPx()))
        displayCorners.forEachIndexed { index, point ->
            drawCircle(Color.White, radius = 10.dp.toPx(), center = point)
            drawCircle(MathNotesColors.Accent, radius = 10.dp.toPx(), center = point, style = Stroke(width = 3.dp.toPx()))
            drawCircle(MathNotesColors.Accent, radius = 3.dp.toPx(), center = point)
        }
    }
}

@Composable
private fun CropOverlay(
    bitmapWidth: Int,
    bitmapHeight: Int,
    cropRect: NormalizedRect,
    onInteractionStart: () -> Unit,
    onCropRectChange: (NormalizedRect) -> Unit,
    modifier: Modifier = Modifier
) {
    var dragMode by remember { mutableStateOf<DragMode?>(null) }
    var dragStart by remember { mutableStateOf(Offset.Zero) }
    var dragStartRect by remember { mutableStateOf(cropRect) }
    val currentCropRect by rememberUpdatedState(cropRect)
    val currentOnInteractionStart by rememberUpdatedState(onInteractionStart)
    val currentOnCropRectChange by rememberUpdatedState(onCropRectChange)
    Canvas(
        modifier.pointerInput(bitmapWidth, bitmapHeight) {
            val handleHitRadius = 58.dp.toPx()
            detectDragGestures(
                onDragStart = { position ->
                    currentOnInteractionStart()
                    val display = fittedImageRect(Size(size.width.toFloat(), size.height.toFloat()), bitmapWidth, bitmapHeight, IMAGE_CANVAS_INSET_DP.dp.toPx())
                    val crop = currentCropRect.toDisplayRect(display)
                    dragMode = dragModeAt(position, crop, handleHitRadius)
                    dragStart = position
                    dragStartRect = currentCropRect
                },
                onDragEnd = { dragMode = null },
                onDragCancel = { dragMode = null },
                onDrag = { change, _ ->
                    change.consume()
                    val display = fittedImageRect(Size(size.width.toFloat(), size.height.toFloat()), bitmapWidth, bitmapHeight, IMAGE_CANVAS_INSET_DP.dp.toPx())
                    val current = change.position
                    val startNormalized = dragStart.toNormalized(display)
                    val currentNormalized = current.toNormalized(display)
                    val next = when (dragMode) {
                        DragMode.NEW -> rectFromPoints(startNormalized, currentNormalized)
                        DragMode.MOVE -> dragStartRect.moveBy(
                            currentNormalized.x - startNormalized.x,
                            currentNormalized.y - startNormalized.y
                        )
                        DragMode.NW -> resizeCorner(dragStartRect, currentNormalized, DragMode.NW)
                        DragMode.NE -> resizeCorner(dragStartRect, currentNormalized, DragMode.NE)
                        DragMode.SW -> resizeCorner(dragStartRect, currentNormalized, DragMode.SW)
                        DragMode.SE -> resizeCorner(dragStartRect, currentNormalized, DragMode.SE)
                        null -> currentCropRect
                    }
                    if (next.width >= MIN_CROP_SIZE && next.height >= MIN_CROP_SIZE) currentOnCropRectChange(next)
                }
            )
        }
    ) {
        val display = fittedImageRect(size, bitmapWidth, bitmapHeight, IMAGE_CANVAS_INSET_DP.dp.toPx())
        val crop = cropRect.toDisplayRect(display)
        val shade = Color.Black.copy(alpha = 0.43f)
        drawRect(shade, display.topLeft, Size(display.width, max(0f, crop.top - display.top)))
        drawRect(shade, Offset(display.left, crop.bottom), Size(display.width, max(0f, display.bottom - crop.bottom)))
        drawRect(shade, Offset(display.left, crop.top), Size(max(0f, crop.left - display.left), crop.height))
        drawRect(shade, Offset(crop.right, crop.top), Size(max(0f, display.right - crop.right), crop.height))
        drawRect(MathNotesColors.Accent, crop.topLeft, crop.size, style = Stroke(width = 3.dp.toPx()))
        cornerOffsets(crop).forEach { point ->
            drawCircle(Color.White, radius = 9.dp.toPx(), center = point)
            drawCircle(MathNotesColors.Accent, radius = 9.dp.toPx(), center = point, style = Stroke(width = 3.dp.toPx()))
        }
    }
}

@Composable
private fun LassoOverlay(
    bitmapWidth: Int,
    bitmapHeight: Int,
    points: List<NormalizedPoint>,
    onInteractionStart: () -> Unit,
    onPointsChange: (List<NormalizedPoint>) -> Unit,
    modifier: Modifier = Modifier
) {
    var dragState by remember { mutableStateOf<LassoDragState?>(null) }
    val density = LocalDensity.current.density
    val dashLength = LASSO_DASH_DP * density
    val gapLength = LASSO_GAP_DP * density
    val dashCycle = marchingDashCyclePx(density)
    val marchingTravel = marchingAnimationTravelPx(density)
    val marchingTransition = rememberInfiniteTransition(label = "lasso-marching-ants")
    val marchingPhase by marchingTransition.animateFloat(
        initialValue = 0f,
        targetValue = marchingTravel,
        animationSpec = infiniteRepeatable(
            tween(durationMillis = LASSO_MARCHING_TRAVEL_DURATION_MS, easing = LinearEasing)
        ),
        label = "lasso-dash-phase"
    )
    val currentPoints by rememberUpdatedState(points)
    val currentOnInteractionStart by rememberUpdatedState(onInteractionStart)
    val currentOnPointsChange by rememberUpdatedState(onPointsChange)
    Canvas(
        modifier.pointerInput(bitmapWidth, bitmapHeight) {
            detectDragGestures(
                onDragStart = { position ->
                    val display = fittedImageRect(Size(size.width.toFloat(), size.height.toFloat()), bitmapWidth, bitmapHeight, IMAGE_CANVAS_INSET_DP.dp.toPx())
                    val point = position.toNormalized(display)
                    currentOnInteractionStart()
                    dragState = if (currentPoints.size >= 3 && pointInPolygon(point, currentPoints)) {
                        LassoDragState.Move(point, currentPoints)
                    } else {
                        val initialPoints = listOf(point)
                        currentOnPointsChange(initialPoints)
                        LassoDragState.Draw(initialPoints)
                    }
                },
                onDragEnd = {
                    val completedPoints = (dragState as? LassoDragState.Draw)?.points ?: currentPoints
                    if (completedPoints.size < 3) currentOnPointsChange(emptyList())
                    dragState = null
                },
                onDragCancel = {
                    val completedPoints = (dragState as? LassoDragState.Draw)?.points ?: currentPoints
                    if (completedPoints.size < 3) currentOnPointsChange(emptyList())
                    dragState = null
                },
                onDrag = { change, _ ->
                    change.consume()
                    val display = fittedImageRect(Size(size.width.toFloat(), size.height.toFloat()), bitmapWidth, bitmapHeight, IMAGE_CANVAS_INSET_DP.dp.toPx())
                    val point = change.position.toNormalized(display)
                    when (val state = dragState) {
                        is LassoDragState.Draw -> {
                            val previous = state.points.lastOrNull()
                            if (previous == null || distance(previous, point) >= MIN_LASSO_POINT_DISTANCE) {
                                val nextState = state.copy(points = state.points + point)
                                dragState = nextState
                                currentOnPointsChange(nextState.points)
                            }
                        }
                        is LassoDragState.Move -> currentOnPointsChange(
                            translatePoints(state.original, point.x - state.start.x, point.y - state.start.y)
                        )
                        null -> Unit
                    }
                }
            )
        }
    ) {
        val display = fittedImageRect(size, bitmapWidth, bitmapHeight, IMAGE_CANVAS_INSET_DP.dp.toPx())
        if (points.isNotEmpty()) {
            val displayPoints = points.map { point ->
                Offset(
                    display.left + point.x.toFloat() * display.width,
                    display.top + point.y.toFloat() * display.height
                )
            }
            val path = Path().apply {
                moveTo(displayPoints.first().x, displayPoints.first().y)
                displayPoints.drop(1).forEach { lineTo(it.x, it.y) }
                if (points.size >= 3 && dragState !is LassoDragState.Draw) close()
            }
            if (points.size >= 3) drawPath(path, MathNotesColors.Accent.copy(alpha = 0.14f))
            drawPath(
                path,
                MathNotesColors.Accent,
                style = Stroke(
                    width = 3.dp.toPx(),
                    pathEffect = PathEffect.dashPathEffect(floatArrayOf(dashLength, gapLength), marchingPhase)
                )
            )
            drawCircle(Color.White, radius = 6.dp.toPx(), center = displayPoints.first())
            drawCircle(MathNotesColors.Accent, radius = 6.dp.toPx(), center = displayPoints.first(), style = Stroke(width = 2.dp.toPx()))
        }
    }
}

@Composable
private fun AnnotationOverlay(
    bitmapWidth: Int,
    bitmapHeight: Int,
    annotations: List<ImageAnnotationObject>,
    selectedId: String?,
    activeTool: ImageSelectionTool?,
    annotationColor: String,
    annotationWidth: Float,
    onInteractionStart: () -> Unit,
    onAnnotationsChange: (List<ImageAnnotationObject>) -> Unit,
    onSelectedIdChange: (String?) -> Unit,
    modifier: Modifier = Modifier
) {
    var dragState by remember { mutableStateOf<AnnotationDragState?>(null) }
    val currentAnnotations by rememberUpdatedState(annotations)
    val currentOnInteractionStart by rememberUpdatedState(onInteractionStart)
    val currentOnAnnotationsChange by rememberUpdatedState(onAnnotationsChange)
    val currentOnSelectedIdChange by rememberUpdatedState(onSelectedIdChange)
    val interactionModifier = if (activeTool?.isAnnotation() == true) {
        modifier.pointerInput(bitmapWidth, bitmapHeight, activeTool, annotationColor, annotationWidth) {
            detectDragGestures(
                onDragStart = { position ->
                    val display = fittedImageRect(Size(size.width.toFloat(), size.height.toFloat()), bitmapWidth, bitmapHeight, IMAGE_CANVAS_INSET_DP.dp.toPx())
                    val point = position.toNormalized(display)
                    currentOnInteractionStart()
                    val hit = if (activeTool == ImageSelectionTool.REDACTION) null else currentAnnotations.lastOrNull {
                        it !is ImageAnnotationObject.Redaction && annotationHitTest(it, point)
                    }
                    if (hit != null) {
                        currentOnSelectedIdChange(hit.id)
                        dragState = AnnotationDragState.Move(hit.id, point, hit, currentAnnotations)
                    } else {
                        val id = "annotation-${UUID.randomUUID()}"
                        currentOnSelectedIdChange(id)
                        if (activeTool == ImageSelectionTool.PEN || activeTool == ImageSelectionTool.REDACTION) {
                            val points = listOf(point, point)
                            dragState = AnnotationDragState.DrawPen(id, currentAnnotations, points)
                            currentOnAnnotationsChange(currentAnnotations + strokeAnnotation(id, points, annotationColor, annotationWidth.toDouble(), activeTool == ImageSelectionTool.REDACTION))
                        } else {
                            dragState = AnnotationDragState.DrawArrow(id, currentAnnotations, point, point)
                            currentOnAnnotationsChange(currentAnnotations + ImageAnnotationObject.Arrow(id, point, point, annotationColor, annotationWidth.toDouble()))
                        }
                    }
                },
                onDragEnd = { dragState = null },
                onDragCancel = { dragState = null },
                onDrag = { change, _ ->
                    change.consume()
                    val display = fittedImageRect(Size(size.width.toFloat(), size.height.toFloat()), bitmapWidth, bitmapHeight, IMAGE_CANVAS_INSET_DP.dp.toPx())
                    val point = change.position.toNormalized(display)
                    when (val state = dragState) {
                        is AnnotationDragState.DrawPen -> {
                            val nextPoints = if (activeTool == ImageSelectionTool.REDACTION) listOf(state.points.first(), point)
                                else if (distance(state.points.last(), point) >= MIN_LASSO_POINT_DISTANCE) state.points + point else state.points
                            val nextState = state.copy(points = nextPoints)
                            dragState = nextState
                            currentOnAnnotationsChange(nextState.base + strokeAnnotation(nextState.id, nextPoints, annotationColor, annotationWidth.toDouble(), activeTool == ImageSelectionTool.REDACTION))
                        }
                        is AnnotationDragState.DrawArrow -> {
                            val nextState = state.copy(end = point)
                            dragState = nextState
                            currentOnAnnotationsChange(nextState.base + ImageAnnotationObject.Arrow(nextState.id, nextState.start, point, annotationColor, annotationWidth.toDouble()))
                        }
                        is AnnotationDragState.Move -> currentOnAnnotationsChange(state.base.map { annotation ->
                            if (annotation.id == state.id) translateAnnotation(state.original, point.x - state.start.x, point.y - state.start.y) else annotation
                        })
                        null -> Unit
                    }
                }
            )
        }
    } else modifier
    Canvas(interactionModifier) {
        val display = fittedImageRect(size, bitmapWidth, bitmapHeight, IMAGE_CANVAS_INSET_DP.dp.toPx())
        annotations.sortedBy { it is ImageAnnotationObject.Redaction }.forEach { annotation ->
            val color = Color(android.graphics.Color.parseColor(annotation.color))
            val strokeWidth = if (annotation is ImageAnnotationObject.Redaction) annotation.width.toFloat() * min(display.width, display.height)
                else max(2.dp.toPx(), annotation.width.toFloat() * min(display.width, display.height))
            val selectedExtra = if (annotation.id == selectedId) 3.dp.toPx() else 0f
            when (annotation) {
                is ImageAnnotationObject.Pen -> {
                    val path = Path().apply {
                        annotation.points.forEachIndexed { index, point ->
                            val displayPoint = point.toDisplayOffset(display)
                            if (index == 0) moveTo(displayPoint.x, displayPoint.y) else lineTo(displayPoint.x, displayPoint.y)
                        }
                    }
                    if (selectedExtra > 0) drawPath(path, Color.White.copy(alpha = 0.9f), style = Stroke(width = strokeWidth + selectedExtra))
                    drawPath(path, color, style = Stroke(width = strokeWidth, cap = StrokeCap.Round, join = StrokeJoin.Round))
                }
                is ImageAnnotationObject.Redaction -> {
                    if (annotation.rectangular) {
                        val bounds = ImageTransformContract.boundingBoxForPoints(annotation.points)
                        val topLeft = NormalizedPoint(bounds.x, bounds.y).toDisplayOffset(display)
                        drawRect(Color.White, topLeft, Size((bounds.width * display.width).toFloat(), (bounds.height * display.height).toFloat()))
                    } else {
                    val path = Path().apply {
                        annotation.points.forEachIndexed { index, point ->
                            val displayPoint = point.toDisplayOffset(display)
                            if (index == 0) moveTo(displayPoint.x, displayPoint.y) else lineTo(displayPoint.x, displayPoint.y)
                        }
                    }
                    drawPath(path, Color.Black, style = Stroke(width = strokeWidth, cap = StrokeCap.Round, join = StrokeJoin.Round))
                    annotation.points.firstOrNull()?.let { drawCircle(Color.Black, strokeWidth / 2f, it.toDisplayOffset(display)) }
                    }
                }
                is ImageAnnotationObject.Arrow -> {
                    val start = annotation.start.toDisplayOffset(display)
                    val end = annotation.end.toDisplayOffset(display)
                    if (selectedExtra > 0) drawLine(Color.White.copy(alpha = 0.9f), start, end, strokeWidth + selectedExtra)
                    drawArrow(color, start, end, strokeWidth)
                }
            }
        }
    }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawArrow(color: Color, start: Offset, end: Offset, width: Float) {
    drawLine(color, start, end, width)
    val angle = kotlin.math.atan2((end.y - start.y).toDouble(), (end.x - start.x).toDouble())
    val length = max(width * 4f, 18.dp.toPx())
    val spread = Math.PI / 7
    drawLine(color, end, Offset((end.x - length * cos(angle - spread)).toFloat(), (end.y - length * sin(angle - spread)).toFloat()), width)
    drawLine(color, end, Offset((end.x - length * cos(angle + spread)).toFloat(), (end.y - length * sin(angle + spread)).toFloat()), width)
}

private sealed interface AnnotationDragState {
    data class DrawPen(
        val id: String,
        val base: List<ImageAnnotationObject>,
        val points: List<NormalizedPoint>
    ) : AnnotationDragState
    data class DrawArrow(
        val id: String,
        val base: List<ImageAnnotationObject>,
        val start: NormalizedPoint,
        val end: NormalizedPoint
    ) : AnnotationDragState
    data class Move(
        val id: String,
        val start: NormalizedPoint,
        val original: ImageAnnotationObject,
        val base: List<ImageAnnotationObject>
    ) : AnnotationDragState
}

private sealed interface LassoDragState {
    data class Draw(val points: List<NormalizedPoint>) : LassoDragState
    data class Move(val start: NormalizedPoint, val original: List<NormalizedPoint>) : LassoDragState
}

private enum class ImageSelectionTool { PERSPECTIVE, RECTANGLE, LASSO, PEN, ARROW, REDACTION }

private fun ImageSelectionTool.isAnnotation() = this == ImageSelectionTool.PEN || this == ImageSelectionTool.ARROW || this == ImageSelectionTool.REDACTION

private fun strokeAnnotation(id: String, points: List<NormalizedPoint>, color: String, width: Double, redaction: Boolean): ImageAnnotationObject =
    if (redaction) ImageAnnotationObject.Redaction(id, points, width.coerceIn(0.001, 0.1), rectangular = true) else ImageAnnotationObject.Pen(id, points, color, width.coerceIn(0.001, 0.1))

private enum class DragMode { NEW, MOVE, NW, NE, SW, SE }

private fun fittedImageRect(canvasSize: Size, bitmapWidth: Int, bitmapHeight: Int, inset: Float): Rect {
    val display = imageDisplayRect(canvasSize.width, canvasSize.height, bitmapWidth, bitmapHeight, inset)
    return Rect(display.left, display.top, display.left + display.width, display.top + display.height)
}

private fun NormalizedRect.toDisplayRect(display: Rect): Rect = Rect(
    left = display.left + x.toFloat() * display.width,
    top = display.top + y.toFloat() * display.height,
    right = display.left + (x + width).toFloat() * display.width,
    bottom = display.top + (y + height).toFloat() * display.height
)

private fun Offset.toNormalized(display: Rect): NormalizedPoint = NormalizedPoint(
    x = ((x - display.left) / display.width).toDouble().coerceIn(0.0, 1.0),
    y = ((y - display.top) / display.height).toDouble().coerceIn(0.0, 1.0)
)

private fun NormalizedPoint.toDisplayOffset(display: Rect): Offset = Offset(
    x = display.left + x.toFloat() * display.width,
    y = display.top + y.toFloat() * display.height
)

private fun dragModeAt(point: Offset, crop: Rect, handleHitRadius: Float): DragMode {
    val handles = listOf(DragMode.NW, DragMode.NE, DragMode.SW, DragMode.SE).zip(cornerOffsets(crop))
    handles.minByOrNull { (_, handle) -> distanceSquared(point, handle) }
        ?.takeIf { (_, handle) -> distanceSquared(point, handle) <= handleHitRadius * handleHitRadius }
        ?.let { return it.first }
    return if (crop.contains(point)) DragMode.MOVE else DragMode.NEW
}

private fun distanceSquared(first: Offset, second: Offset): Float {
    val dx = first.x - second.x
    val dy = first.y - second.y
    return dx * dx + dy * dy
}

private fun cornerOffsets(rect: Rect): List<Offset> = listOf(rect.topLeft, rect.topRight, rect.bottomLeft, rect.bottomRight)

private fun rectFromPoints(first: NormalizedPoint, second: NormalizedPoint): NormalizedRect = NormalizedRect(
    x = min(first.x, second.x),
    y = min(first.y, second.y),
    width = abs(first.x - second.x),
    height = abs(first.y - second.y)
)

private fun NormalizedRect.moveBy(dx: Double, dy: Double): NormalizedRect {
    val nextX = (x + dx).coerceIn(0.0, 1.0 - width)
    val nextY = (y + dy).coerceIn(0.0, 1.0 - height)
    return copy(x = nextX, y = nextY)
}

private fun resizeCorner(rect: NormalizedRect, point: NormalizedPoint, mode: DragMode): NormalizedRect {
    val left = rect.x
    val top = rect.y
    val right = rect.x + rect.width
    val bottom = rect.y + rect.height
    return when (mode) {
        DragMode.NW -> rectFromPoints(point, NormalizedPoint(right, bottom))
        DragMode.NE -> rectFromPoints(NormalizedPoint(left, bottom), point)
        DragMode.SW -> rectFromPoints(NormalizedPoint(right, top), point)
        DragMode.SE -> rectFromPoints(NormalizedPoint(left, top), point)
        else -> rect
    }
}

private fun translatePoints(points: List<NormalizedPoint>, requestedDx: Double, requestedDy: Double): List<NormalizedPoint> {
    val minX = points.minOf { it.x }
    val maxX = points.maxOf { it.x }
    val minY = points.minOf { it.y }
    val maxY = points.maxOf { it.y }
    val dx = requestedDx.coerceIn(-minX, 1.0 - maxX)
    val dy = requestedDy.coerceIn(-minY, 1.0 - maxY)
    return points.map { ImageTransformContract.normalizePoint(NormalizedPoint(it.x + dx, it.y + dy)) }
}

private fun annotationHitTest(annotation: ImageAnnotationObject, point: NormalizedPoint): Boolean {
    val threshold = max(0.018, annotation.width * 2.5)
    return when (annotation) {
        is ImageAnnotationObject.Pen -> annotation.points.zipWithNext().any { (start, end) ->
            distanceToSegment(point, start, end) <= threshold
        }
        is ImageAnnotationObject.Redaction -> annotation.points.zipWithNext().any { (start, end) -> distanceToSegment(point, start, end) <= threshold }
        is ImageAnnotationObject.Arrow -> distanceToSegment(point, annotation.start, annotation.end) <= threshold
    }
}

private fun distanceToSegment(point: NormalizedPoint, start: NormalizedPoint, end: NormalizedPoint): Double {
    val dx = end.x - start.x
    val dy = end.y - start.y
    val lengthSquared = dx * dx + dy * dy
    if (lengthSquared <= 1e-12) return distance(point, start)
    val t = (((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared).coerceIn(0.0, 1.0)
    return distance(point, NormalizedPoint(start.x + t * dx, start.y + t * dy))
}

private fun translateAnnotation(annotation: ImageAnnotationObject, requestedDx: Double, requestedDy: Double): ImageAnnotationObject {
    val points = when (annotation) {
        is ImageAnnotationObject.Pen -> annotation.points
        is ImageAnnotationObject.Redaction -> annotation.points
        is ImageAnnotationObject.Arrow -> listOf(annotation.start, annotation.end)
    }
    val minX = points.minOf { it.x }
    val maxX = points.maxOf { it.x }
    val minY = points.minOf { it.y }
    val maxY = points.maxOf { it.y }
    val dx = requestedDx.coerceIn(-minX, 1.0 - maxX)
    val dy = requestedDy.coerceIn(-minY, 1.0 - maxY)
    fun move(point: NormalizedPoint) = ImageTransformContract.normalizePoint(NormalizedPoint(point.x + dx, point.y + dy))
    return when (annotation) {
        is ImageAnnotationObject.Pen -> annotation.copy(points = annotation.points.map(::move))
        is ImageAnnotationObject.Redaction -> annotation.copy(points = annotation.points.map(::move))
        is ImageAnnotationObject.Arrow -> annotation.copy(start = move(annotation.start), end = move(annotation.end))
    }
}

private fun pointInPolygon(point: NormalizedPoint, polygon: List<NormalizedPoint>): Boolean {
    var inside = false
    var previous = polygon.last()
    for (current in polygon) {
        val crosses = (current.y > point.y) != (previous.y > point.y) &&
            point.x < (previous.x - current.x) * (point.y - current.y) /
                ((previous.y - current.y).takeUnless { abs(it) < 1e-9 } ?: 1e-9) + current.x
        if (crosses) inside = !inside
        previous = current
    }
    return inside
}

private fun distance(first: NormalizedPoint, second: NormalizedPoint): Double = sqrt(
    (first.x - second.x) * (first.x - second.x) + (first.y - second.y) * (first.y - second.y)
)

private val FULL_RECT = NormalizedRect(0.0, 0.0, 1.0, 1.0)
private val DEFAULT_PERSPECTIVE_CORNERS = listOf(
    NormalizedPoint(0.04, 0.04),
    NormalizedPoint(0.96, 0.04),
    NormalizedPoint(0.96, 0.96),
    NormalizedPoint(0.04, 0.96)
)
private const val MIN_CROP_SIZE = 0.02
private const val IMAGE_CANVAS_INSET_DP = 24f
private const val MIN_LASSO_POINT_DISTANCE = 0.006
private const val LASSO_DASH_DP = 12f
private const val LASSO_GAP_DP = 8f
private const val LASSO_MARCHING_TRAVEL_CYCLES = 100f
private const val LASSO_MARCHING_TRAVEL_DURATION_MS = 72_000
private const val DEFAULT_ANNOTATION_WIDTH = 0.006f
private const val MIN_ANNOTATION_WIDTH = 0.003f
private const val MAX_ANNOTATION_WIDTH = 0.025f
private val ANNOTATION_COLORS = listOf("#187857", "#d84b3e", "#2563a8", "#1f201d", "#f0b429")

internal fun marchingDashCyclePx(density: Float): Float = (LASSO_DASH_DP + LASSO_GAP_DP) * density

internal fun marchingAnimationTravelPx(density: Float): Float =
    marchingDashCyclePx(density) * LASSO_MARCHING_TRAVEL_CYCLES
