package com.mathnotes.capture.standalone

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items as gridItems
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.mathnotes.capture.R
import com.mathnotes.capture.ui.MathNotesColors
import com.mathnotes.capture.ui.MathNotesPageHeader
import com.mathnotes.capture.ui.MathNotesPaper
import com.mathnotes.capture.ui.MathNotesPrimaryButton
import com.mathnotes.capture.ui.MathNotesSecondaryButton
import com.mathnotes.capture.ui.MathNotesThemeId

private sealed interface StandaloneLibraryTarget {
    data class Notebook(val value: StandaloneNotebookEntity) : StandaloneLibraryTarget
    data class Session(val value: StandaloneSessionEntity) : StandaloneLibraryTarget
}

private enum class StandaloneNameAction { CREATE_NOTEBOOK, CREATE_SESSION, RENAME_NOTEBOOK, RENAME_SESSION }

private data class StandaloneNameRequest(
    val action: StandaloneNameAction,
    val notebookId: String? = null,
    val sessionId: String? = null,
    val initialValue: String = ""
)

@Composable
fun StandaloneScreen(
    viewModel: StandaloneViewModel = viewModel(),
    themeId: MathNotesThemeId = MathNotesThemeId.DEFAULT_LIGHT,
    onExit: (() -> Unit)? = null,
    libraryHeader: (@Composable () -> Unit)? = null,
    libraryQuery: String = "",
    onSelectSessionForCapture: ((StandaloneSessionEntity) -> Unit)? = null,
    onCancelCaptureSelection: (() -> Unit)? = null,
    readingRequest: com.mathnotes.capture.notes.NoteReadingRequest? = null,
    onReadingTap: () -> Unit = {},
    onReaderActive: (Boolean) -> Unit = {},
    bottomBarHidden: Boolean = false
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var openedNotebookId by rememberSaveable { mutableStateOf<String?>(null) }
    var openedSessionId by rememberSaveable { mutableStateOf<String?>(null) }
    var nameRequest by remember { mutableStateOf<StandaloneNameRequest?>(null) }
    var contextTarget by remember { mutableStateOf<StandaloneLibraryTarget?>(null) }
    var deleteTarget by remember { mutableStateOf<StandaloneLibraryTarget?>(null) }
    var pendingExportTarget by remember { mutableStateOf<StandaloneLibraryTarget?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(readingRequest?.requestId) {
        readingRequest?.takeIf { it.pairing == null }?.let { openedSessionId = it.sessionId }
    }
    val exportLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/markdown")) { target ->
        val libraryTarget = pendingExportTarget
        pendingExportTarget = null
        if (target != null && libraryTarget != null) {
            when (libraryTarget) {
                is StandaloneLibraryTarget.Notebook -> viewModel.exportNotebook(libraryTarget.value.id, target) { result ->
                    message = result.fold(
                        onSuccess = { count -> "已导出 Notebook（${count} 个 Session）" },
                        onFailure = { "导出失败：${it.message ?: "请重试"}" }
                    )
                }
                is StandaloneLibraryTarget.Session -> viewModel.exportSession(libraryTarget.value.id, target) { result ->
                    message = result.fold(
                        onSuccess = { "已导出 Session" },
                        onFailure = { "导出失败：${it.message ?: "请重试"}" }
                    )
                }
            }
        }
    }

    LaunchedEffect(openedSessionId) {
        openedSessionId?.let(viewModel::selectSession)
    }

    BackHandler(
        enabled = openedSessionId != null || openedNotebookId != null || onExit != null || onCancelCaptureSelection != null
    ) {
        when {
            openedSessionId != null -> openedSessionId = null
            openedNotebookId != null -> openedNotebookId = null
            else -> (onCancelCaptureSelection ?: onExit)?.invoke()
        }
    }

    val activeSession = state.activeSession?.takeIf { it.id == openedSessionId }
    if (openedSessionId != null) {
        if (activeSession == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("正在打开笔记…", color = MathNotesColors.Muted)
            }
        } else {
            StandaloneSessionReader(
                session = activeSession,
                blocks = state.blocks,
                tasks = state.tasks,
                themeId = themeId,
                onBack = { openedSessionId = null },
                readingRequest = readingRequest?.takeIf { it.sessionId == activeSession.id },
                onReadingTap = onReadingTap,
                onReaderActive = onReaderActive,
                bottomBarHidden = bottomBarHidden
            )
        }
    } else if (openedNotebookId == null) {
        val visibleNotebooks = if (libraryQuery.isBlank()) state.notebooks else state.notebooks.filter { notebook ->
            notebook.title.contains(libraryQuery, ignoreCase = true) ||
                state.sessions.any { it.notebookId == notebook.id && it.title.contains(libraryQuery, ignoreCase = true) }
        }
        StandaloneNotebookBrowser(
            notebooks = visibleNotebooks,
            sessions = state.sessions,
            activeSession = state.activeSession,
            activeSessionBlocks = state.activeSession?.let { active -> state.allBlocks.filter { it.sessionId == active.id } }.orEmpty(),
            activeSessionTasks = state.activeSession?.let { active -> state.allTasks.filter { it.sessionId == active.id } }.orEmpty(),
            themeId = themeId,
            captureSelectionMode = onSelectSessionForCapture != null,
            onContinue = { session ->
                viewModel.selectSession(session.id)
                if (onSelectSessionForCapture != null) onSelectSessionForCapture(session) else openedSessionId = session.id
            },
            onOpen = { openedNotebookId = it.id },
            onLongPress = { contextTarget = StandaloneLibraryTarget.Notebook(it) },
            onCreate = { nameRequest = StandaloneNameRequest(StandaloneNameAction.CREATE_NOTEBOOK) },
            onExit = onExit,
            libraryHeader = libraryHeader
        )
    } else {
        val notebook = state.notebooks.firstOrNull { it.id == openedNotebookId }
        if (notebook == null) {
            LaunchedEffect(openedNotebookId) { openedNotebookId = null }
        } else {
            StandaloneSessionBrowser(
                notebook = notebook,
                sessions = state.sessions.filter { it.notebookId == notebook.id },
                activeSessionId = state.activeSession?.id,
                captureSelectionMode = onSelectSessionForCapture != null,
                onBack = { openedNotebookId = null },
                onOpen = {
                    viewModel.selectSession(it.id)
                    if (onSelectSessionForCapture != null) onSelectSessionForCapture(it) else openedSessionId = it.id
                },
                onLongPress = { contextTarget = StandaloneLibraryTarget.Session(it) },
                onCreate = {
                    nameRequest = StandaloneNameRequest(
                        action = StandaloneNameAction.CREATE_SESSION,
                        notebookId = notebook.id
                    )
                },
                libraryHeader = libraryHeader
            )
        }
    }

    contextTarget?.let { target ->
        StandaloneContextDialog(
            target = target,
            onDismiss = { contextTarget = null },
            onRename = {
                nameRequest = when (target) {
                    is StandaloneLibraryTarget.Notebook -> StandaloneNameRequest(
                        StandaloneNameAction.RENAME_NOTEBOOK,
                        notebookId = target.value.id,
                        initialValue = target.value.title
                    )
                    is StandaloneLibraryTarget.Session -> StandaloneNameRequest(
                        StandaloneNameAction.RENAME_SESSION,
                        notebookId = target.value.notebookId,
                        sessionId = target.value.id,
                        initialValue = target.value.title
                    )
                }
                contextTarget = null
            },
            onDelete = {
                deleteTarget = target
                contextTarget = null
            },
            onExport = {
                pendingExportTarget = target
                contextTarget = null
                exportLauncher.launch(
                    when (target) {
                        is StandaloneLibraryTarget.Notebook -> standaloneNotebookExportFileName(target.value.title)
                        is StandaloneLibraryTarget.Session -> standaloneSessionExportFileName(target.value.title)
                    }
                )
            }
        )
    }

    deleteTarget?.let { target ->
        StandaloneDeleteDialog(
            target = target,
            onDismiss = { deleteTarget = null },
            onConfirm = {
                when (target) {
                    is StandaloneLibraryTarget.Notebook -> viewModel.deleteNotebook(target.value.id) { result ->
                        message = result.fold(
                            onSuccess = {
                                if (openedNotebookId == target.value.id) openedNotebookId = null
                                "已删除 Notebook"
                            },
                            onFailure = { "删除失败：${it.message ?: "请重试"}" }
                        )
                    }
                    is StandaloneLibraryTarget.Session -> viewModel.deleteSession(target.value.id) { result ->
                        message = result.fold(
                            onSuccess = {
                                if (openedSessionId == target.value.id) openedSessionId = null
                                "已删除 Session"
                            },
                            onFailure = { "删除失败：${it.message ?: "请重试"}" }
                        )
                    }
                }
                deleteTarget = null
            }
        )
    }

    nameRequest?.let { request ->
        StandaloneNameDialog(
            request = request,
            onDismiss = { nameRequest = null },
            onConfirm = { title ->
                when (request.action) {
                    StandaloneNameAction.CREATE_NOTEBOOK -> viewModel.createNotebook(title) { result ->
                        message = result.fold(
                            onSuccess = {
                                openedNotebookId = it.id
                                "已新建 Notebook"
                            },
                            onFailure = { "新建失败：${it.message ?: "请重试"}" }
                        )
                    }
                    StandaloneNameAction.CREATE_SESSION -> viewModel.createSession(requireNotNull(request.notebookId), title) { result ->
                        message = result.fold(
                            onSuccess = {
                                if (onSelectSessionForCapture != null) onSelectSessionForCapture(it) else openedSessionId = it.id
                                "已新建 Session"
                            },
                            onFailure = { "新建失败：${it.message ?: "请重试"}" }
                        )
                    }
                    StandaloneNameAction.RENAME_NOTEBOOK -> viewModel.renameNotebook(requireNotNull(request.notebookId), title) { result ->
                        message = result.fold(
                            onSuccess = { "已重命名 Notebook" },
                            onFailure = { "重命名失败：${it.message ?: "请重试"}" }
                        )
                    }
                    StandaloneNameAction.RENAME_SESSION -> viewModel.renameSession(requireNotNull(request.sessionId), title) { result ->
                        message = result.fold(
                            onSuccess = { "已重命名 Session" },
                            onFailure = { "重命名失败：${it.message ?: "请重试"}" }
                        )
                    }
                }
                nameRequest = null
            }
        )
    }

    message?.let { current ->
        AlertDialog(
            onDismissRequest = { message = null },
            title = { Text(if (current.contains("失败")) "没有完成" else "已完成") },
            text = { Text(current) },
            confirmButton = { TextButton(onClick = { message = null }) { Text("知道了") } }
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun StandaloneNotebookBrowser(
    notebooks: List<StandaloneNotebookEntity>,
    sessions: List<StandaloneSessionEntity>,
    activeSession: StandaloneSessionEntity?,
    activeSessionBlocks: List<StandaloneBlockEntity>,
    activeSessionTasks: List<StandaloneRecognitionTaskEntity>,
    themeId: MathNotesThemeId,
    captureSelectionMode: Boolean,
    onContinue: (StandaloneSessionEntity) -> Unit,
    onOpen: (StandaloneNotebookEntity) -> Unit,
    onLongPress: (StandaloneNotebookEntity) -> Unit,
    onCreate: () -> Unit,
    onExit: (() -> Unit)?,
    libraryHeader: (@Composable () -> Unit)?
) {
    val previewMarkdown = remember(activeSessionBlocks) { prepareStandaloneSessionMarkdown(activeSessionBlocks) }
    val context = androidx.compose.ui.platform.LocalContext.current
    val previewImages = remember(activeSession, activeSessionBlocks, activeSessionTasks) {
        activeSession?.let { standaloneReaderImages(context, it.id, activeSessionBlocks, activeSessionTasks) }.orEmpty()
    }
    LazyVerticalGrid(
        columns = GridCells.Fixed(3),
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 22.dp, top = 14.dp, end = 22.dp, bottom = 124.dp),
        horizontalArrangement = Arrangement.spacedBy(9.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            Column {
                libraryHeader?.invoke()
                if (libraryHeader != null) Spacer(Modifier.height(44.dp))
                onExit?.let {
                    MathNotesSecondaryButton("返回笔记", it, Modifier.fillMaxWidth())
                    Spacer(Modifier.height(15.dp))
                }
                activeSession?.let { session ->
                    val continueShape = RoundedCornerShape(16.dp)
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clip(continueShape)
                            .semantics {
                                contentDescription = if (captureSelectionMode) {
                                    "选择当前 Session 作为拍摄目标"
                                } else {
                                    "继续阅读当前 Session"
                                }
                                onClick {
                                    onContinue(session)
                                    true
                                }
                            }
                            .clickable { onContinue(session) }
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth().height(88.dp),
                            verticalAlignment = Alignment.Top,
                            horizontalArrangement = Arrangement.spacedBy(14.dp)
                        ) {
                            Column(Modifier.weight(1f)) {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                                    Icon(
                                        painterResource(R.drawable.ic_mathnotes_notes),
                                        contentDescription = null,
                                        tint = MathNotesColors.Accent,
                                        modifier = Modifier.size(16.dp)
                                    )
                                    Text(
                                        if (captureSelectionMode) "选择为拍摄目标" else "继续阅读",
                                        style = MaterialTheme.typography.labelLarge,
                                        color = MathNotesColors.Accent
                                    )
                                }
                                Spacer(Modifier.height(12.dp))
                                Text(
                                    session.title,
                                    style = MaterialTheme.typography.titleMedium,
                                    color = MathNotesColors.Ink,
                                    fontFamily = FontFamily.Serif,
                                    maxLines = 2
                                )
                                Spacer(Modifier.height(5.dp))
                                Text(
                                    if (captureSelectionMode) "点按后返回拍摄" else "本机笔记 · 上次阅读",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MathNotesColors.Muted
                                )
                            }
                            Box(
                                modifier = Modifier.size(72.dp),
                                contentAlignment = Alignment.BottomCenter
                            ) {
                                Surface(
                                    modifier = Modifier.size(72.dp),
                                    shape = RoundedCornerShape(12.dp),
                                    color = MathNotesColors.AccentSoft,
                                    border = androidx.compose.foundation.BorderStroke(1.dp, MathNotesColors.Line)
                                ) {
                                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                        Icon(
                                            painterResource(R.drawable.ic_mathnotes_notes),
                                            contentDescription = null,
                                            tint = MathNotesColors.Accent,
                                            modifier = Modifier.size(24.dp)
                                        )
                                    }
                                }
                            }
                        }
                        Spacer(Modifier.height(6.dp))
                        Surface(
                            modifier = Modifier.fillMaxWidth().height(66.dp),
                            shape = RoundedCornerShape(12.dp),
                            color = MathNotesColors.Paper,
                            border = androidx.compose.foundation.BorderStroke(1.dp, MathNotesColors.Line)
                        ) {
                            StandaloneMarkdownPreview(
                                markdown = previewMarkdown,
                                themeId = themeId,
                                images = previewImages,
                                modifier = Modifier.fillMaxSize()
                            )
                        }
                    }
                    Spacer(Modifier.height(18.dp))
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "Notebooks",
                        style = MaterialTheme.typography.titleLarge,
                        color = MathNotesColors.Ink,
                        fontFamily = FontFamily.Serif,
                        modifier = Modifier.weight(1f)
                    )
                    Surface(
                        modifier = Modifier.size(36.dp).clip(CircleShape).clickable(onClick = onCreate),
                        shape = CircleShape,
                        color = MathNotesColors.AccentSoft
                    ) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Icon(
                                painterResource(android.R.drawable.ic_input_add),
                                contentDescription = "新建 Notebook",
                                tint = MathNotesColors.Accent,
                                modifier = Modifier.size(20.dp)
                            )
                        }
                    }
                }
                Spacer(Modifier.height(4.dp))
            }
        }
        if (notebooks.isEmpty()) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                MathNotesPaper(Modifier.fillMaxWidth()) {
                    Text("还没有 Notebook", style = MaterialTheme.typography.titleMedium, color = MathNotesColors.Ink)
                    Text("新建后可以在文件夹里继续建立 Session。", color = MathNotesColors.Muted)
                }
            }
        }
        gridItems(
            items = notebooks.chunked(3),
            key = { row -> row.joinToString(separator = ":") { it.id } },
            span = { GridItemSpan(maxLineSpan) }
        ) { notebookRow ->
            Box(Modifier.fillMaxWidth().height(174.dp)) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(top = 102.dp)
                        .height(9.dp)
                        .background(androidx.compose.ui.graphics.Color(0xFFC8AB7B), RoundedCornerShape(4.dp))
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(9.dp)
                ) {
                    notebookRow.forEach { notebook ->
                        NotebookFolderCard(
                            notebook = notebook,
                            sessionCount = sessions.count { it.notebookId == notebook.id },
                            onOpen = { onOpen(notebook) },
                            onLongPress = { onLongPress(notebook) },
                            modifier = Modifier.weight(1f)
                        )
                    }
                    repeat(3 - notebookRow.size) {
                        Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun NotebookFolderCard(
    notebook: StandaloneNotebookEntity,
    sessionCount: Int,
    onOpen: () -> Unit,
    onLongPress: () -> Unit,
    modifier: Modifier = Modifier
) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .combinedClickable(onClick = onOpen, onLongClick = onLongPress),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(Modifier.fillMaxWidth().height(120.dp)) {
            Box(
                Modifier
                    .fillMaxWidth(0.42f)
                    .height(16.dp)
                    .padding(start = 10.dp)
                    .background(MathNotesColors.Accent, RoundedCornerShape(topStart = 7.dp, topEnd = 7.dp))
            )
            Surface(
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp).height(112.dp),
                shape = RoundedCornerShape(6.dp),
                color = MathNotesColors.Paper,
                border = androidx.compose.foundation.BorderStroke(1.dp, MathNotesColors.Line),
                tonalElevation = 0.dp,
                shadowElevation = 1.dp
            ) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Icon(
                        painterResource(R.drawable.ic_mathnotes_notes),
                        contentDescription = null,
                        tint = MathNotesColors.Accent,
                        modifier = Modifier.size(34.dp)
                    )
                }
            }
        }
        Spacer(Modifier.height(7.dp))
        Text(
            notebook.title,
            style = MaterialTheme.typography.titleMedium,
            color = MathNotesColors.Ink,
            maxLines = 1
        )
        Text("$sessionCount 个 Session", style = MaterialTheme.typography.bodySmall, color = MathNotesColors.Muted)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun StandaloneSessionBrowser(
    notebook: StandaloneNotebookEntity,
    sessions: List<StandaloneSessionEntity>,
    activeSessionId: String?,
    captureSelectionMode: Boolean,
    onBack: () -> Unit,
    onOpen: (StandaloneSessionEntity) -> Unit,
    onLongPress: (StandaloneSessionEntity) -> Unit,
    onCreate: () -> Unit,
    libraryHeader: (@Composable () -> Unit)?
) {
    LazyVerticalGrid(
        columns = GridCells.Fixed(2),
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 22.dp, top = 14.dp, end = 22.dp, bottom = 124.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            Column {
                libraryHeader?.invoke()
                if (libraryHeader != null) Spacer(Modifier.height(18.dp))
                MathNotesSecondaryButton("返回 Notebooks", onBack, Modifier.fillMaxWidth())
                Spacer(Modifier.height(15.dp))
                MathNotesPageHeader(eyebrow = "Notebook", title = notebook.title, detail = "")
                Spacer(Modifier.height(16.dp))
                MathNotesPrimaryButton("新建另一份笔记", onCreate, Modifier.fillMaxWidth())
                Text(
                    "将在这个 Notebook 中创建新的 Session",
                    style = MaterialTheme.typography.bodySmall,
                    color = MathNotesColors.Muted,
                    modifier = Modifier.padding(top = 6.dp, bottom = 4.dp)
                )
            }
        }
        if (sessions.isEmpty()) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                MathNotesPaper(Modifier.fillMaxWidth()) {
                    Text("这个 Notebook 还是空的", style = MaterialTheme.typography.titleMedium)
                    Text("点击上方按钮新建 Session。", color = MathNotesColors.Muted)
                }
            }
        }
        gridItems(sessions, key = { it.id }) { session ->
            val selected = session.id == activeSessionId
            val sessionShape = RoundedCornerShape(18.dp)
            Surface(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(142.dp)
                    .clip(sessionShape)
                    .combinedClickable(onClick = { onOpen(session) }, onLongClick = { onLongPress(session) }),
                shape = sessionShape,
                color = if (selected) MathNotesColors.AccentSoft else MathNotesColors.Subtle,
                border = androidx.compose.foundation.BorderStroke(1.dp, if (selected) MathNotesColors.Accent else MathNotesColors.Line)
            ) {
                Column(Modifier.padding(17.dp), verticalArrangement = Arrangement.SpaceBetween) {
                    Icon(
                        painterResource(R.drawable.ic_mathnotes_notes),
                        contentDescription = null,
                        tint = if (selected) MathNotesColors.Accent else MathNotesColors.Muted,
                        modifier = Modifier.size(38.dp)
                    )
                    Column {
                        Text(session.title, style = MaterialTheme.typography.titleMedium, color = MathNotesColors.Ink, maxLines = 2)
                        Text(
                            when {
                                selected -> "当前拍照目标"
                                captureSelectionMode -> "点按选择并返回拍摄"
                                else -> "Session"
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = MathNotesColors.Muted
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun StandaloneSessionReader(
    session: StandaloneSessionEntity,
    blocks: List<StandaloneBlockEntity>,
    tasks: List<StandaloneRecognitionTaskEntity>,
    themeId: MathNotesThemeId,
    onBack: () -> Unit,
    readingRequest: com.mathnotes.capture.notes.NoteReadingRequest? = null,
    onReadingTap: () -> Unit = {},
    onReaderActive: (Boolean) -> Unit = {},
    bottomBarHidden: Boolean = false
) {
    val markdown = remember(blocks) { prepareStandaloneSessionMarkdown(blocks) }
    val context = androidx.compose.ui.platform.LocalContext.current
    val images = remember(session.id, blocks, tasks) { standaloneReaderImages(context, session.id, blocks, tasks) }
    StandaloneMarkdownReader(session.title, markdown, themeId, onBack, images, blocks, readingRequest,
        onReadingTap, onReaderActive, bottomBarHidden)
}

@Composable
private fun StandaloneContextDialog(
    target: StandaloneLibraryTarget,
    onDismiss: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
    onExport: () -> Unit
) {
    val title = when (target) {
        is StandaloneLibraryTarget.Notebook -> target.value.title
        is StandaloneLibraryTarget.Session -> target.value.title
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("选择要对这个文件执行的操作。", color = MathNotesColors.Muted)
                TextButton(onClick = onExport) { Text("导出") }
                TextButton(onClick = onDelete) { Text("删除", color = MathNotesColors.Error) }
            }
        },
        confirmButton = { TextButton(onClick = onRename) { Text("重命名") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}

@Composable
private fun StandaloneDeleteDialog(
    target: StandaloneLibraryTarget,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit
) {
    val isNotebook = target is StandaloneLibraryTarget.Notebook
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (isNotebook) "删除 Notebook？" else "删除 Session？") },
        text = {
            Text(
                if (isNotebook) "会删除文件夹中的本机 Session、照片与识别草稿；电脑端内容不受影响。"
                else "会删除这份 Session 的本机照片、队列任务与识别草稿；电脑端内容不受影响。"
            )
        },
        confirmButton = { TextButton(onClick = onConfirm) { Text("确认删除", color = MathNotesColors.Error) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}

@Composable
private fun StandaloneNameDialog(
    request: StandaloneNameRequest,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit
) {
    var value by remember(request) { mutableStateOf(request.initialValue) }
    val title = when (request.action) {
        StandaloneNameAction.CREATE_NOTEBOOK -> "新建 Notebook"
        StandaloneNameAction.CREATE_SESSION -> "新建 Session"
        StandaloneNameAction.RENAME_NOTEBOOK -> "重命名 Notebook"
        StandaloneNameAction.RENAME_SESSION -> "重命名 Session"
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(
                value = value,
                onValueChange = { value = it },
                label = { Text("名称") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
        },
        confirmButton = {
            TextButton(enabled = value.trim().isNotBlank(), onClick = { onConfirm(value.trim()) }) { Text("保存") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}

internal fun taskStatusLabel(status: String): String = when (status) {
    StandaloneTaskStatus.NEEDS_CONFIGURATION -> "需要先配置识别服务"
    StandaloneTaskStatus.AWAITING_CONFIRMATION -> "等待你确认"
    StandaloneTaskStatus.CLAIMED -> "正在识别"
    StandaloneTaskStatus.SUCCEEDED -> "识别稿已生成"
    StandaloneTaskStatus.POSSIBLY_CHARGED -> "结果未知，可能已经计费"
    StandaloneTaskStatus.CANCELLED -> "已取消"
    else -> "识别失败，请查看原因"
}
