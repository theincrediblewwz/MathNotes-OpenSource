package com.mathnotes.capture

import android.content.Intent
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import com.mathnotes.capture.storage.CaptureEntity
import com.mathnotes.capture.storage.CaptureState
import com.mathnotes.capture.storage.MaterialType
import com.mathnotes.capture.standalone.StandaloneBlockEntity
import com.mathnotes.capture.standalone.StandaloneNotebookEntity
import com.mathnotes.capture.standalone.StandaloneProviderCatalog
import com.mathnotes.capture.standalone.StandaloneRecognitionTaskEntity
import com.mathnotes.capture.standalone.StandaloneSessionEntity
import com.mathnotes.capture.standalone.StandaloneTaskStatus
import com.mathnotes.capture.standalone.taskStatusLabel
import com.mathnotes.capture.ui.MathNotesColors
import com.mathnotes.capture.ui.MathNotesPageHeader
import com.mathnotes.capture.ui.MathNotesPaper
import com.mathnotes.capture.ui.MathNotesPrimaryButton
import com.mathnotes.capture.ui.MathNotesSecondaryButton
import com.mathnotes.capture.ui.MathNotesStatusDot
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private enum class LibraryView { RECENT, HISTORY }

@Composable
fun QueueScreen(
    captures: List<CaptureEntity>,
    onDelete: (CaptureEntity) -> Unit,
    onRetry: (CaptureEntity) -> Unit,
    onCancel: (CaptureEntity) -> Unit,
    onClearRecentUploaded: () -> Unit,
    onClearUploadedHistory: () -> Unit,
    onDeleteHistory: (CaptureEntity) -> Unit = {},
    focusCaptureId: String? = null,
    onFocusConsumed: () -> Unit = {},
    onDeleteTask: (CaptureEntity) -> Unit = {},
    localTasks: List<StandaloneRecognitionTaskEntity> = emptyList(),
    localBlocks: List<StandaloneBlockEntity> = emptyList(),
    localSessions: List<StandaloneSessionEntity> = emptyList(),
    localNotebooks: List<StandaloneNotebookEntity> = emptyList(),
    onDeleteLocalTask: (StandaloneRecognitionTaskEntity) -> Unit = {},
    connectionLabel: String = "本机识别",
    captureTargetLabel: String = "本机笔记",
    onContinueCapture: () -> Unit = {}
) {
    var view by remember { mutableStateOf(LibraryView.RECENT) }
    var preview by remember { mutableStateOf<CaptureEntity?>(null) }
    var localPreview by remember { mutableStateOf<Pair<StandaloneRecognitionTaskEntity, CaptureGalleryItem>?>(null) }
    var confirmClearRecent by remember { mutableStateOf(false) }
    var confirmClearHistory by remember { mutableStateOf(false) }
    val recentCaptures = remember(captures) { captures.filterNot { it.hiddenFromRecent } }
    val displayedRecentCaptures = remember(recentCaptures) { recentCaptures.take(40) }
    val recentLocalTasks = remember(localTasks) { localTasks.take(40) }
    val localHistoryTasks = remember(localTasks) {
        localTasks.filter { it.status in setOf(
            StandaloneTaskStatus.SUCCEEDED,
            StandaloneTaskStatus.FAILED,
            StandaloneTaskStatus.POSSIBLY_CHARGED,
            StandaloneTaskStatus.CANCELLED
        ) }
    }
    val listState = rememberLazyListState()
    LaunchedEffect(focusCaptureId, recentCaptures) {
        val targetId = focusCaptureId ?: return@LaunchedEffect
        view = LibraryView.RECENT
        try {
            withFrameNanos { }
            val targetIndex = displayedRecentCaptures.indexOfFirst { it.captureId == targetId }
            listState.animateScrollToItem(if (targetIndex >= 0) targetIndex + 1 else 0)
        } finally {
            onFocusConsumed()
        }
    }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        state = listState,
        contentPadding = androidx.compose.foundation.layout.PaddingValues(
            start = 22.dp,
            top = 14.dp,
            end = 22.dp,
            bottom = 132.dp
        )
    ) {
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "今日采集",
                    style = MaterialTheme.typography.headlineLarge,
                    color = MathNotesColors.Ink,
                    fontFamily = FontFamily.Serif,
                    modifier = Modifier.weight(1f)
                )
                Surface(
                    shape = RoundedCornerShape(18.dp),
                    color = MathNotesColors.AccentSoft,
                    tonalElevation = 0.dp,
                    shadowElevation = 0.dp
                ) {
                    Row(
                        Modifier.padding(horizontal = 11.dp, vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(7.dp)
                    ) {
                        MathNotesStatusDot(MathNotesColors.Accent)
                        Text(connectionLabel, style = MaterialTheme.typography.labelMedium, color = MathNotesColors.Accent, maxLines = 1)
                    }
                }
            }
            Spacer(Modifier.height(14.dp))
            Surface(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(170.dp)
                    .clip(RoundedCornerShape(18.dp))
                    .clickable(onClick = onContinueCapture),
                shape = RoundedCornerShape(18.dp),
                color = MathNotesColors.AccentSoft,
                border = androidx.compose.foundation.BorderStroke(1.dp, MathNotesColors.Line),
                tonalElevation = 0.dp,
                shadowElevation = 0.dp
            ) {
                Row(
                    Modifier.padding(horizontal = 18.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("继续拍摄", style = MaterialTheme.typography.titleLarge, color = MathNotesColors.Accent, fontFamily = FontFamily.Serif)
                        Spacer(Modifier.height(8.dp))
                        Text(captureTargetLabel, style = MaterialTheme.typography.bodyMedium, color = MathNotesColors.Muted, maxLines = 2)
                    }
                    Surface(
                        modifier = Modifier.size(48.dp),
                        shape = androidx.compose.foundation.shape.CircleShape,
                        color = MathNotesColors.Accent
                    ) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Icon(
                                painterResource(R.drawable.ic_mathnotes_camera),
                                contentDescription = null,
                                tint = androidx.compose.ui.graphics.Color.White,
                                modifier = Modifier.size(23.dp)
                            )
                        }
                    }
                }
            }
            Spacer(Modifier.height(34.dp))
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (view == LibraryView.RECENT) "处理队列" else "全部记录",
                    style = MaterialTheme.typography.titleMedium,
                    color = MathNotesColors.Ink,
                    modifier = Modifier.weight(1f)
                )
                Text(
                    if (view == LibraryView.RECENT) "查看全部 ›" else "返回队列",
                    style = MaterialTheme.typography.labelMedium,
                    color = MathNotesColors.Accent,
                    modifier = Modifier.clearAndSetSemantics {
                        text = AnnotatedString(if (view == LibraryView.RECENT) "历史" else "返回队列")
                    }.clip(RoundedCornerShape(9.dp)).clickable {
                        view = if (view == LibraryView.RECENT) LibraryView.HISTORY else LibraryView.RECENT
                    }.padding(horizontal = 5.dp, vertical = 8.dp)
                )
                if (view == LibraryView.HISTORY && captures.any { it.state == CaptureState.UPLOADED }) {
                    Text(
                        "清空",
                        style = MaterialTheme.typography.labelMedium,
                        color = MathNotesColors.Error,
                        modifier = Modifier.clip(RoundedCornerShape(9.dp)).clickable { confirmClearHistory = true }.padding(start = 10.dp, top = 8.dp, bottom = 8.dp)
                    )
                } else if (view == LibraryView.RECENT && recentCaptures.any { it.state == CaptureState.UPLOADED }) {
                    Text(
                        "清理",
                        style = MaterialTheme.typography.labelMedium,
                        color = MathNotesColors.Muted,
                        modifier = Modifier.clip(RoundedCornerShape(9.dp)).clickable { confirmClearRecent = true }.padding(start = 10.dp, top = 8.dp, bottom = 8.dp)
                    )
                }
            }
            Spacer(Modifier.height(9.dp))
        }

        if (
            (view == LibraryView.RECENT && recentCaptures.isEmpty() && recentLocalTasks.isEmpty()) ||
            (view == LibraryView.HISTORY && captures.isEmpty() && localHistoryTasks.isEmpty())
        ) {
            item {
                MathNotesPaper(Modifier.fillMaxWidth()) {
                    Text("还没有素材", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(5.dp))
                    Text(
                        if (view == LibraryView.RECENT) "新的上传任务会在这里显示；历史记录仍可在“历史”中查看。"
                        else "拍照、从相册选择或导入 PDF 后，会在这里显示状态。",
                        color = MathNotesColors.Muted
                    )
                }
            }
        } else if (view == LibraryView.RECENT) {
            items(recentLocalTasks, key = { "local:${it.id}" }) { task ->
                val block = localBlocks.firstOrNull { it.id == task.assetBlockId }
                LocalRecognitionTaskCard(
                    task = task,
                    block = block,
                    session = localSessions.firstOrNull { it.id == task.sessionId },
                    notebook = localSessions.firstOrNull { it.id == task.sessionId }?.let { session ->
                        localNotebooks.firstOrNull { it.id == session.notebookId }
                    },
                    onDelete = onDeleteLocalTask,
                    onPreview = {
                        if (block != null && File(block.localPath).isFile) {
                            localPreview = task to CaptureGalleryItem(
                                id = "queue-local:${task.id}",
                                path = block.localPath,
                                label = localSessions.firstOrNull { it.id == task.sessionId }?.title ?: "本机拍摄",
                                canDelete = task.status != StandaloneTaskStatus.CLAIMED,
                                createdAt = task.createdAt
                            )
                        }
                    }
                )
            }
            items(displayedRecentCaptures, key = { it.captureId }) { capture ->
                CaptureCard(
                    capture = capture,
                    onDelete = onDelete,
                    onDeleteHistory = onDeleteHistory,
                    onDeleteTask = onDeleteTask,
                    onRetry = onRetry,
                    onCancel = onCancel,
                    onPreview = { preview = capture }
                )
            }
        } else {
            items(localHistoryTasks, key = { "local-history:${it.id}" }) { task ->
                val block = localBlocks.firstOrNull { it.id == task.assetBlockId }
                LocalRecognitionTaskCard(
                    task = task,
                    block = block,
                    session = localSessions.firstOrNull { it.id == task.sessionId },
                    notebook = localSessions.firstOrNull { it.id == task.sessionId }?.let { session ->
                        localNotebooks.firstOrNull { it.id == session.notebookId }
                    },
                    onDelete = onDeleteLocalTask,
                    onPreview = {
                        if (block != null && File(block.localPath).isFile) {
                            localPreview = task to CaptureGalleryItem(
                                id = "queue-local:${task.id}",
                                path = block.localPath,
                                label = localSessions.firstOrNull { it.id == task.sessionId }?.title ?: "本机拍摄",
                                canDelete = task.status != StandaloneTaskStatus.CLAIMED,
                                createdAt = task.createdAt
                            )
                        }
                    }
                )
            }
            item {
                HistoryGroups(captures, onDelete, onDeleteHistory, onDeleteTask, onRetry, onCancel) { preview = it }
            }
        }
    }

    preview?.let { capture ->
        MaterialPreview(capture, onDismiss = { preview = null })
    }
    localPreview?.let { (task, item) ->
        CapturePreviewGallery(
            items = listOf(item),
            initialSelectedId = item.id,
            detailOnly = true,
            onClose = { localPreview = null },
            onDelete = { onDeleteLocalTask(task) }
        )
    }
    if (confirmClearRecent) {
        AlertDialog(
            onDismissRequest = { confirmClearRecent = false },
            title = { Text("清理最近已完成？") },
            text = { Text("只会从“最近”隐藏已上传项目；历史记录和本地副本都不会删除。") },
            confirmButton = {
                TextButton(onClick = {
                    onClearRecentUploaded()
                    confirmClearRecent = false
                }) { Text("清理") }
            },
            dismissButton = {
                TextButton(onClick = { confirmClearRecent = false }) { Text("取消") }
            }
        )
    }
    if (confirmClearHistory) {
        AlertDialog(
            onDismissRequest = { confirmClearHistory = false },
            title = { Text("清空已上传记录？") },
            text = { Text("会删除已成功上传的历史记录和本地副本；等待上传与失败任务会保留。") },
            confirmButton = {
                TextButton(onClick = {
                    onClearUploadedHistory()
                    confirmClearHistory = false
                }) { Text("清空") }
            },
            dismissButton = {
                TextButton(onClick = { confirmClearHistory = false }) { Text("取消") }
            }
        )
    }
}

@Composable
private fun LibraryTab(text: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Surface(
        modifier = modifier
            .height(44.dp)
            .clip(RoundedCornerShape(10.dp))
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(10.dp),
        color = if (selected) MathNotesColors.AccentSoft else MathNotesColors.Paper,
        border = androidx.compose.foundation.BorderStroke(1.dp, MathNotesColors.Line)
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                text,
                color = if (selected) MathNotesColors.Accent else MathNotesColors.Muted,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium
            )
        }
    }
}

@Composable
private fun HistoryGroups(
    captures: List<CaptureEntity>,
    onDelete: (CaptureEntity) -> Unit,
    onDeleteHistory: (CaptureEntity) -> Unit,
    onDeleteTask: (CaptureEntity) -> Unit,
    onRetry: (CaptureEntity) -> Unit,
    onCancel: (CaptureEntity) -> Unit,
    onPreview: (CaptureEntity) -> Unit
) {
    var expandedComputers by remember { mutableStateOf(emptySet<String>()) }
    var expandedNotebooks by remember { mutableStateOf(emptySet<String>()) }
    val computers = captures.groupBy { it.computerLabel.ifBlank { it.endpointId.ifBlank { "未知电脑" } } }

    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        computers.forEach { (computer, computerCaptures) ->
            val computerOpen = computer in expandedComputers
            FolderRow(
                title = computer,
                detail = "${computerCaptures.size} 项素材",
                expanded = computerOpen
            ) {
                expandedComputers = expandedComputers.toggle(computer)
            }
            if (computerOpen) {
                computerCaptures.groupBy { it.notebookId.ifBlank { "未指定 Notebook" } }.forEach { (notebook, notebookCaptures) ->
                    val key = "$computer::$notebook"
                    val notebookOpen = key in expandedNotebooks
                    FolderRow(
                        title = notebook,
                        detail = "${notebookCaptures.size} 项 · ${notebookCaptures.map { it.targetTitle }.filter { it.isNotBlank() }.distinct().size} 个 Session",
                        expanded = notebookOpen,
                        modifier = Modifier.padding(start = 12.dp)
                    ) {
                        expandedNotebooks = expandedNotebooks.toggle(key)
                    }
                    if (notebookOpen) {
                        notebookCaptures.forEach { capture ->
                            CaptureCard(
                                capture,
                                onDelete,
                                onDeleteHistory,
                                onDeleteTask,
                                onRetry,
                                onCancel,
                                onPreview,
                                Modifier.padding(start = 24.dp)
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FolderRow(
    title: String,
    detail: String,
    expanded: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit
) {
    MathNotesPaper(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .clickable(onClick = onClick)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(if (expanded) "▾" else "▸", color = MathNotesColors.Accent)
            Column(Modifier.padding(start = 10.dp)) {
                Text(title, style = MaterialTheme.typography.titleMedium, color = MathNotesColors.Ink)
                Text(detail, style = MaterialTheme.typography.bodySmall, color = MathNotesColors.Muted)
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)
@Composable
private fun CaptureCard(
    capture: CaptureEntity,
    onDelete: (CaptureEntity) -> Unit,
    onDeleteHistory: (CaptureEntity) -> Unit,
    onDeleteTask: (CaptureEntity) -> Unit,
    onRetry: (CaptureEntity) -> Unit,
    onCancel: (CaptureEntity) -> Unit,
    onPreview: (CaptureEntity) -> Unit,
    modifier: Modifier = Modifier
) {
    val localFileExists = capture.localCopyAvailable && File(capture.localPath).isFile
    var confirmDeleteTask by remember(capture.captureId) { mutableStateOf(false) }
    val dismissState = rememberSwipeToDismissBoxState(
        confirmValueChange = { value ->
            if (value == SwipeToDismissBoxValue.EndToStart) confirmDeleteTask = true
            false
        },
        positionalThreshold = { distance -> distance * 0.28f }
    )
    SwipeToDismissBox(
        state = dismissState,
        modifier = modifier.fillMaxWidth().padding(bottom = 9.dp),
        enableDismissFromStartToEnd = false,
        enableDismissFromEndToStart = true,
        backgroundContent = { QueueDeleteBackground() }
    ) {
        MathNotesPaper(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(16.dp))
                .combinedClickable(
                    onClick = { if (localFileExists) onPreview(capture) },
                    onLongClick = { confirmDeleteTask = true }
                )
        ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            MathNotesStatusDot(queueStateColor(capture.state))
            Text(
                queueStateLabel(capture.state),
                modifier = Modifier.padding(start = 9.dp),
                style = MaterialTheme.typography.labelMedium,
                color = queueStateColor(capture.state)
            )
            Spacer(Modifier.weight(1f))
            Text(formatTime(capture.createdAt), style = MaterialTheme.typography.bodySmall, color = MathNotesColors.Muted)
        }
        Spacer(Modifier.height(9.dp))
        Text(
            capture.sourceName.ifBlank { File(capture.localPath).name },
            style = MaterialTheme.typography.titleMedium,
            color = MathNotesColors.Ink
        )
        Text(
            if (capture.materialType == MaterialType.PDF) "PDF 文档" else "图片素材",
            color = MathNotesColors.Accent,
            style = MaterialTheme.typography.labelMedium
        )
        Text(
            capture.targetTitle.ifBlank { capture.sessionId.ifBlank { "未指定 Session" } },
            color = MathNotesColors.Muted,
            style = MaterialTheme.typography.bodySmall
        )
        Text(
            if (localFileExists) "点击预览原素材 · ${capture.byteLength / 1024} KB" else "本地副本已清理，上传回执仍保留",
            color = if (localFileExists) MathNotesColors.Accent else MathNotesColors.Warning,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(top = 5.dp)
        )
        Text(
            if (capture.state == CaptureState.UPLOADING) "正在上传；先暂停后可长按删除" else "长按可删除这项任务",
            color = MathNotesColors.Muted,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(top = 4.dp)
        )
        capture.lastError?.let {
            Text(it, color = MathNotesColors.Error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
        }
            when (capture.state) {
                CaptureState.PENDING, CaptureState.UPLOADING -> MathNotesSecondaryButton(
                    "暂停上传",
                    { onCancel(capture) },
                    Modifier.padding(top = 10.dp)
                )
                CaptureState.RETRYABLE, CaptureState.PAUSED, CaptureState.BLOCKED_AUTH, CaptureState.FAILED_PERMANENT ->
                    MathNotesSecondaryButton("立即重试", { onRetry(capture) }, Modifier.padding(top = 10.dp))
            }
        }
    }
    if (confirmDeleteTask) {
        val uploaded = capture.state == CaptureState.UPLOADED
        val uploading = capture.state == CaptureState.UPLOADING
        AlertDialog(
            onDismissRequest = { confirmDeleteTask = false },
            title = { Text(if (uploaded) "删除历史？" else "删除任务？") },
            text = {
                Text(
                    when {
                        uploading -> "这项素材正在上传。请先暂停，确认状态变为“已暂停”后再删除。"
                        uploaded -> "会删除这条已上传记录和仍保留的本地照片；Windows 端已经收到的内容不会被删除。"
                        else -> "会取消等待中的工作，并删除这条任务及本机素材；电脑端已经收到的内容不会被撤回。"
                    }
                )
            },
            confirmButton = {
                if (!uploading) {
                    TextButton(onClick = {
                        if (uploaded) onDeleteHistory(capture) else onDeleteTask(capture)
                        confirmDeleteTask = false
                    }) { Text(if (uploaded) "删除历史" else "删除任务") }
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmDeleteTask = false }) { Text(if (uploading) "知道了" else "取消") }
            }
        )
    }
}

@OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)
@Composable
private fun LocalRecognitionTaskCard(
    task: StandaloneRecognitionTaskEntity,
    block: StandaloneBlockEntity?,
    session: StandaloneSessionEntity?,
    notebook: StandaloneNotebookEntity?,
    onDelete: (StandaloneRecognitionTaskEntity) -> Unit,
    onPreview: () -> Unit
) {
    var confirmDelete by remember(task.id) { mutableStateOf(false) }
    val running = task.status == StandaloneTaskStatus.CLAIMED
    val thumbnail = block?.localPath?.let { rememberCameraThumbnail(it) }
    val dismissState = rememberSwipeToDismissBoxState(
        confirmValueChange = { value ->
            if (value == SwipeToDismissBoxValue.EndToStart) confirmDelete = true
            false
        },
        positionalThreshold = { distance -> distance * 0.28f }
    )
    SwipeToDismissBox(
        state = dismissState,
        modifier = Modifier.fillMaxWidth().padding(bottom = 9.dp),
        enableDismissFromStartToEnd = false,
        enableDismissFromEndToStart = true,
        backgroundContent = { QueueDeleteBackground() }
    ) {
        MathNotesPaper(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(16.dp))
                .combinedClickable(onClick = onPreview, onLongClick = { confirmDelete = true })
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(13.dp), verticalAlignment = Alignment.CenterVertically) {
                Surface(
                    modifier = Modifier.size(width = 68.dp, height = 92.dp),
                    shape = RoundedCornerShape(10.dp),
                    color = MathNotesColors.Subtle,
                    border = androidx.compose.foundation.BorderStroke(1.dp, MathNotesColors.Line)
                ) {
                    if (thumbnail != null) {
                        Image(
                            bitmap = thumbnail.asImageBitmap(),
                            contentDescription = "拍摄缩略图",
                            modifier = Modifier.fillMaxSize(),
                            contentScale = ContentScale.Crop
                        )
                    }
                }
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        MathNotesStatusDot(if (running) MathNotesColors.Accent else if (task.status == StandaloneTaskStatus.SUCCEEDED) MathNotesColors.Success else MathNotesColors.Warning)
                        Text("本机识别", modifier = Modifier.padding(start = 8.dp), style = MaterialTheme.typography.labelMedium, color = MathNotesColors.Accent)
                        Spacer(Modifier.weight(1f))
                        Text(formatTime(task.createdAt), style = MaterialTheme.typography.bodySmall, color = MathNotesColors.Muted)
                    }
                    Spacer(Modifier.height(7.dp))
                    Text(
                        session?.title?.ifBlank { null } ?: "拍摄内容",
                        style = MaterialTheme.typography.titleMedium,
                        color = MathNotesColors.Ink,
                        maxLines = 1
                    )
                    Text(taskStatusLabel(task.status), style = MaterialTheme.typography.bodySmall, color = if (running) MathNotesColors.Accent else MathNotesColors.Muted)
                    Text(
                        listOfNotNull(notebook?.title, session?.title).joinToString(" · ").ifBlank { "本机笔记" },
                        style = MaterialTheme.typography.bodySmall,
                        color = MathNotesColors.Muted,
                        maxLines = 1
                    )
                    Text(
                        if (running) "正在识别" else "向左滑动或长按可删除",
                        style = MaterialTheme.typography.bodySmall,
                        color = MathNotesColors.Muted,
                        modifier = Modifier.padding(top = 4.dp)
                    )
                }
            }
        }
    }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("删除本机任务？") },
            text = {
                Text(
                    if (running) "这项任务正在调用识别服务。为避免把可能已经计费的请求误作未发送，请等待任务结束后再删除。"
                    else "会删除队列任务、本机照片和对应识别草稿；Windows 笔记不会受到影响。"
                )
            },
            confirmButton = {
                if (!running) {
                    TextButton(onClick = {
                        onDelete(task)
                        confirmDelete = false
                    }) { Text("删除任务") }
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) { Text(if (running) "知道了" else "取消") }
            }
        )
    }
}

@Composable
private fun QueueDeleteBackground() {
    Surface(
        modifier = Modifier.fillMaxSize(),
        shape = RoundedCornerShape(16.dp),
        color = MathNotesColors.Error,
        tonalElevation = 0.dp,
        shadowElevation = 0.dp
    ) {
        Box(Modifier.fillMaxSize().padding(end = 24.dp), contentAlignment = Alignment.CenterEnd) {
            Text("删除", color = androidx.compose.ui.graphics.Color.White, style = MaterialTheme.typography.labelLarge)
        }
    }
}

@Composable
private fun MaterialPreview(capture: CaptureEntity, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val file = remember(capture.localPath) { File(capture.localPath) }
    val bitmap = remember(capture.localPath) {
        if (capture.materialType == MaterialType.IMAGE && file.isFile) BitmapFactory.decodeFile(file.absolutePath) else null
    }
    var openError by remember(capture.localPath) { mutableStateOf<String?>(null) }
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .background(MathNotesColors.Background)
                .padding(18.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(capture.sourceName.ifBlank { file.name }, style = MaterialTheme.typography.titleMedium)
                    Text("原素材预览", color = MathNotesColors.Muted, style = MaterialTheme.typography.bodySmall)
                }
                MathNotesSecondaryButton("关闭", onDismiss)
            }
            Spacer(Modifier.height(14.dp))
            MathNotesPaper(Modifier.fillMaxSize()) {
                if (capture.materialType == MaterialType.PDF && file.isFile) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("PDF 文档", style = MaterialTheme.typography.headlineSmall, color = MathNotesColors.Ink)
                            Spacer(Modifier.height(7.dp))
                            Text(
                                "${capture.byteLength / 1024} KB · 已保存本机副本",
                                color = MathNotesColors.Muted,
                                style = MaterialTheme.typography.bodySmall
                            )
                            Spacer(Modifier.height(16.dp))
                            MathNotesPrimaryButton(
                                text = "用系统应用打开",
                                onClick = {
                                    openError = runCatching {
                                        val uri = FileProvider.getUriForFile(
                                            context,
                                            "${context.packageName}.files",
                                            file
                                        )
                                        context.startActivity(
                                            Intent(Intent.ACTION_VIEW)
                                                .setDataAndType(uri, "application/pdf")
                                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                                        )
                                    }.exceptionOrNull()?.let { "没有可打开 PDF 的系统应用" }
                                }
                            )
                            openError?.let {
                                Spacer(Modifier.height(9.dp))
                                Text(it, color = MathNotesColors.Error, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                } else if (bitmap != null) {
                    Image(
                        bitmap.asImageBitmap(),
                        contentDescription = capture.sourceName,
                        modifier = Modifier.fillMaxSize(),
                        contentScale = ContentScale.Fit
                    )
                } else {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("本地素材不可用或已清理", color = MathNotesColors.Muted)
                    }
                }
            }
        }
    }
}

private fun Set<String>.toggle(value: String): Set<String> =
    if (value in this) this - value else this + value

private fun formatTime(timestamp: Long): String =
    SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(timestamp))

private fun queueStateLabel(state: String): String = when (state) {
    CaptureState.PENDING -> "等待上传"
    CaptureState.UPLOADING -> "正在上传"
    CaptureState.UPLOADED -> "已上传"
    CaptureState.RETRYABLE -> "等待重试"
    CaptureState.PAUSED -> "已暂停"
    CaptureState.BLOCKED_AUTH -> "需要重新配对"
    CaptureState.FAILED_PERMANENT -> "无法上传"
    else -> state
}

private fun queueStateColor(state: String) = when (state) {
    CaptureState.UPLOADED -> MathNotesColors.Success
    CaptureState.FAILED_PERMANENT, CaptureState.BLOCKED_AUTH -> MathNotesColors.Error
    CaptureState.PENDING, CaptureState.UPLOADING -> MathNotesColors.Accent
    else -> MathNotesColors.Warning
}
