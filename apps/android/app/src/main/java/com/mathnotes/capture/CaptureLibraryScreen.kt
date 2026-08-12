package com.mathnotes.capture

import android.content.Intent
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import com.mathnotes.capture.storage.CaptureEntity
import com.mathnotes.capture.storage.CaptureState
import com.mathnotes.capture.storage.MaterialType
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
    onClearUploadedHistory: () -> Unit
) {
    var view by remember { mutableStateOf(LibraryView.RECENT) }
    var preview by remember { mutableStateOf<CaptureEntity?>(null) }
    var confirmClearRecent by remember { mutableStateOf(false) }
    var confirmClearHistory by remember { mutableStateOf(false) }
    val recentCaptures = remember(captures) { captures.filterNot { it.hiddenFromRecent } }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(
            start = 22.dp,
            top = 28.dp,
            end = 22.dp,
            bottom = 112.dp
        )
    ) {
        item {
            MathNotesPageHeader(
                eyebrow = "本机素材",
                title = "上传与历史",
                detail = "最近任务保持扁平；历史按电脑与 Notebook 归档。"
            )
            Spacer(Modifier.height(18.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                LibraryTab("最近", view == LibraryView.RECENT, Modifier.weight(1f)) { view = LibraryView.RECENT }
                LibraryTab("历史", view == LibraryView.HISTORY, Modifier.weight(1f)) { view = LibraryView.HISTORY }
            }
            if (view == LibraryView.HISTORY && captures.any { it.state == CaptureState.UPLOADED }) {
                Spacer(Modifier.height(9.dp))
                MathNotesSecondaryButton(
                    "清空已上传记录",
                    { confirmClearHistory = true },
                    Modifier.fillMaxWidth()
                )
            } else if (view == LibraryView.RECENT && recentCaptures.any { it.state == CaptureState.UPLOADED }) {
                Spacer(Modifier.height(9.dp))
                MathNotesSecondaryButton(
                    "清理最近已完成",
                    { confirmClearRecent = true },
                    Modifier.fillMaxWidth()
                )
            }
            Spacer(Modifier.height(16.dp))
        }

        if ((view == LibraryView.RECENT && recentCaptures.isEmpty()) || (view == LibraryView.HISTORY && captures.isEmpty())) {
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
            items(recentCaptures.take(40), key = { it.captureId }) { capture ->
                CaptureCard(
                    capture = capture,
                    onDelete = onDelete,
                    onRetry = onRetry,
                    onCancel = onCancel,
                    onPreview = { preview = capture }
                )
            }
        } else {
            item {
                HistoryGroups(captures, onDelete, onRetry, onCancel) { preview = it }
            }
        }
    }

    preview?.let { capture ->
        MaterialPreview(capture, onDismiss = { preview = null })
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

@Composable
private fun CaptureCard(
    capture: CaptureEntity,
    onDelete: (CaptureEntity) -> Unit,
    onRetry: (CaptureEntity) -> Unit,
    onCancel: (CaptureEntity) -> Unit,
    onPreview: (CaptureEntity) -> Unit,
    modifier: Modifier = Modifier
) {
    val localFileExists = capture.localCopyAvailable && File(capture.localPath).isFile
    MathNotesPaper(
        modifier
            .fillMaxWidth()
            .padding(bottom = 9.dp)
            .clickable(enabled = localFileExists) { onPreview(capture) }
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
        capture.lastError?.let {
            Text(it, color = MathNotesColors.Error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
        }
        when (capture.state) {
            CaptureState.UPLOADED -> if (localFileExists) {
                MathNotesSecondaryButton("清理本地副本", { onDelete(capture) }, Modifier.padding(top = 10.dp))
            }
            CaptureState.PENDING, CaptureState.UPLOADING -> MathNotesSecondaryButton(
                "暂停上传",
                { onCancel(capture) },
                Modifier.padding(top = 10.dp)
            )
            else -> MathNotesSecondaryButton("立即重试", { onRetry(capture) }, Modifier.padding(top = 10.dp))
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
