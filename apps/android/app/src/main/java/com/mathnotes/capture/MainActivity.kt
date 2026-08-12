package com.mathnotes.capture

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.DrawableRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import android.os.Build
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.core.content.FileProvider
import com.mathnotes.capture.notification.rememberNotificationPermissionController
import com.mathnotes.capture.imageedit.ImageEditDraft
import com.mathnotes.capture.imageedit.ImageEditScreen
import com.mathnotes.capture.companion.CompanionNotesScreen
import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.pairing.PairingParseResult
import com.mathnotes.capture.pairing.PairingSettingsScreen
import com.mathnotes.capture.pairing.PairingStore
import com.mathnotes.capture.pairing.PairingTarget
import com.mathnotes.capture.pairing.PairingVerificationResult
import com.mathnotes.capture.pairing.PairingVerifier
import com.mathnotes.capture.pairing.QrScannerScreen
import com.mathnotes.capture.pairing.userMessage
import com.mathnotes.capture.storage.CaptureEntity
import com.mathnotes.capture.storage.CaptureState
import com.mathnotes.capture.ui.MathNotesColors
import com.mathnotes.capture.ui.MathNotesFloatingNavigation
import com.mathnotes.capture.ui.MathNotesNavItem
import com.mathnotes.capture.ui.MathNotesPageHeader
import com.mathnotes.capture.ui.MathNotesPaper
import com.mathnotes.capture.ui.MathNotesPrimaryButton
import com.mathnotes.capture.ui.MathNotesSecondaryButton
import com.mathnotes.capture.ui.MathNotesStatusDot
import com.mathnotes.capture.ui.MathNotesTheme
import com.mathnotes.capture.ui.AppearancePreferences
import com.mathnotes.capture.ui.MathNotesThemeId
import com.mathnotes.capture.ui.systemBarAppearanceFor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.mathnotes.capture.storage.CaptureSource
import com.mathnotes.capture.standalone.StandaloneScreen
import java.io.File

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val appearancePreferences = AppearancePreferences(applicationContext)
        val initialTheme = appearancePreferences.loadTheme()
        applySystemBars(initialTheme, mediaPreviewOpen = false)
        setContent {
            var themeId by remember { mutableStateOf(initialTheme) }
            var mediaPreviewOpen by remember { mutableStateOf(false) }
            LaunchedEffect(themeId, mediaPreviewOpen) {
                applySystemBars(themeId, mediaPreviewOpen)
            }
            MathNotesTheme(themeId) {
                MathNotesCaptureApp(
                    themeId = themeId,
                    onMediaPreviewChange = { mediaPreviewOpen = it },
                    onThemeChange = { next ->
                        if (appearancePreferences.saveTheme(next)) {
                            themeId = next
                        }
                    }
                )
            }
        }
    }

    private fun applySystemBars(themeId: MathNotesThemeId, mediaPreviewOpen: Boolean) {
        val appearance = systemBarAppearanceFor(themeId, mediaPreviewOpen)
        val style = if (appearance.useDarkIcons) {
            SystemBarStyle.light(appearance.backgroundArgb, appearance.backgroundArgb)
        } else {
            SystemBarStyle.dark(appearance.backgroundArgb)
        }
        enableEdgeToEdge(
            statusBarStyle = style,
            navigationBarStyle = style
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isNavigationBarContrastEnforced = false
        }
    }
}

private enum class AppSection(
    val key: String,
    val label: String,
    @DrawableRes val icon: Int
) {
    STANDALONE("standalone", "独立", R.drawable.ic_mathnotes_notes),
    NOTES("notes", "笔记", R.drawable.ic_mathnotes_notes),
    CAPTURE("capture", "拍照", R.drawable.ic_mathnotes_camera),
    QUEUE("queue", "队列", R.drawable.ic_mathnotes_queue),
    SETTINGS("settings", "设置", R.drawable.ic_mathnotes_settings)
}

internal enum class SystemCameraReturnAction {
    STOP,
    EDIT,
    ENQUEUE
}

internal fun systemCameraReturnAction(
    saved: Boolean,
    hasFile: Boolean,
    editAfterCapture: Boolean
): SystemCameraReturnAction = when {
    !saved || !hasFile -> SystemCameraReturnAction.STOP
    editAfterCapture -> SystemCameraReturnAction.EDIT
    else -> SystemCameraReturnAction.ENQUEUE
}

@Composable
fun MathNotesCaptureApp(
    themeId: MathNotesThemeId = MathNotesThemeId.DEFAULT_LIGHT,
    onMediaPreviewChange: (Boolean) -> Unit = {},
    onThemeChange: (MathNotesThemeId) -> Unit = {}
) {
    val context = LocalContext.current
    val pairingStore = remember(context) { PairingStore(context.applicationContext) }
    val captureViewModel: CaptureViewModel = viewModel()
    val captures by captureViewModel.captures.collectAsStateWithLifecycle()
    var section by remember { mutableStateOf(AppSection.CAPTURE) }
    var pairedConfig by remember { mutableStateOf(pairingStore.load()) }
    var pairingProfiles by remember { mutableStateOf(pairingStore.list()) }
    var scannerOpen by remember { mutableStateOf(false) }
    var pendingPairing by remember { mutableStateOf<PairingConfig?>(null) }
    var availableTargets by remember { mutableStateOf<List<PairingTarget>>(emptyList()) }
    var checking by remember { mutableStateOf(false) }
    var statusMessage by remember { mutableStateOf<String?>(null) }
    var captureMessage by remember { mutableStateOf<String?>(null) }
    var imageEditDraft by remember { mutableStateOf<ImageEditDraft?>(null) }
    var imageEditSaving by remember { mutableStateOf(false) }
    var imageEditMessage by remember { mutableStateOf<String?>(null) }
    var pendingSystemCameraFile by remember { mutableStateOf<File?>(null) }
    var pendingSystemCameraEdit by remember { mutableStateOf(false) }
    var editAfterCapture by rememberSaveable { mutableStateOf(false) }
    var systemCameraSessionActive by rememberSaveable { mutableStateOf(false) }
    var launchNextSystemCamera by remember { mutableStateOf(false) }
    var previewGalleryPaths by remember { mutableStateOf<List<String>?>(null) }
    LaunchedEffect(previewGalleryPaths) {
        onMediaPreviewChange(previewGalleryPaths != null)
    }
    val notificationPermission = rememberNotificationPermissionController()
    val galleryLauncher = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        val pairing = pairedConfig
        if (uri == null || pairing?.hasTarget != true) return@rememberLauncherForActivityResult
        captureMessage = "正在保存所选图片…"
        captureViewModel.stageImage(uri) { result ->
            captureMessage = result.fold(
                onSuccess = {
                    imageEditDraft = it
                    imageEditMessage = null
                    null
                },
                onFailure = { "无法导入图片：${it.message ?: "请重试"}" }
            )
        }
    }
    val systemCameraLauncher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
        val file = pendingSystemCameraFile
        val shouldEdit = pendingSystemCameraEdit
        pendingSystemCameraFile = null
        when (systemCameraReturnAction(saved, file != null, shouldEdit)) {
            SystemCameraReturnAction.STOP -> {
                file?.delete()
                systemCameraSessionActive = false
                launchNextSystemCamera = false
                if (!saved) captureMessage = "拍摄已结束"
            }
            SystemCameraReturnAction.EDIT -> {
                val capturedFile = requireNotNull(file)
                imageEditMessage = "正在打开图片编辑…"
                captureViewModel.stageCapturedFile(capturedFile) { result ->
                    result.fold(
                        onSuccess = {
                            imageEditDraft = it
                            imageEditMessage = null
                        },
                        onFailure = {
                            capturedFile.delete()
                            imageEditMessage = null
                            captureMessage = "无法打开系统相机照片：${it.message ?: "请重试"}"
                            launchNextSystemCamera = systemCameraSessionActive
                        }
                    )
                }
            }
            SystemCameraReturnAction.ENQUEUE -> {
                val capturedFile = requireNotNull(file)
                val pairing = pairedConfig
                if (pairing?.hasTarget != true) {
                    capturedFile.delete()
                    systemCameraSessionActive = false
                    launchNextSystemCamera = false
                    captureMessage = "当前没有可用的目标笔记"
                    return@rememberLauncherForActivityResult
                }
                captureMessage = "正在把系统相机照片加入队列…"
                captureViewModel.commit(capturedFile, pairing) { result ->
                    captureMessage = result.fold(
                        onSuccess = { "照片已加入队列，继续拍摄" },
                        onFailure = { "无法生成素材：${it.message ?: "请重试"}" }
                    )
                    launchNextSystemCamera = systemCameraSessionActive
                }
            }
        }
    }
    val pdfLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val pairing = pairedConfig
        if (uri == null || pairing?.hasTarget != true) return@rememberLauncherForActivityResult
        captureMessage = "正在保存所选 PDF…"
        captureViewModel.importPdf(uri, pairing) { result ->
            captureMessage = result.fold(
                onSuccess = { "PDF 已加入上传队列；到达电脑后再选择阅读或识别" },
                onFailure = { "无法导入 PDF：${it.message ?: "请重试"}" }
            )
        }
    }

    LaunchedEffect(Unit) {
        pairedConfig?.let { pendingPairing = it }
    }

    LaunchedEffect(pendingPairing) {
        val config = pendingPairing ?: return@LaunchedEffect
        checking = true
        val result = withContext(Dispatchers.IO) {
            PairingVerifier(deviceLabel = listOf(Build.MANUFACTURER, Build.MODEL).filter(String::isNotBlank).joinToString(" "))
                .verify(config)
        }
        checking = false
        statusMessage = result.userMessage()
        if (result is PairingVerificationResult.Verified) {
            if (pairingStore.save(result.config)) {
                pairedConfig = pairingStore.load()
                pairingProfiles = pairingStore.list()
                availableTargets = result.targets
                pairedConfig?.let(captureViewModel::resumeBlockedAfterPairing)
            } else {
                statusMessage = "配对已验证，但未能保存到本机，请重试"
            }
        }
        pendingPairing = null
    }

    fun acceptPairing(result: PairingParseResult): Boolean {
        when (result) {
            is PairingParseResult.Success -> {
                scannerOpen = false
                pendingPairing = result.config
                return true
            }
            is PairingParseResult.Failure -> {
                statusMessage = result.reason.userMessage
                return false
            }
        }
    }

    BackHandler(enabled = scannerOpen) {
        scannerOpen = false
    }
    BackHandler(enabled = imageEditDraft != null && !imageEditSaving) {
        imageEditDraft?.let(captureViewModel::discardImageDraft)
        imageEditDraft = null
        imageEditMessage = null
        launchNextSystemCamera = systemCameraSessionActive
    }

    if (scannerOpen) {
        QrScannerScreen(
            onResult = {
                acceptPairing(PairingConfig.parse(it))
            },
            onCancel = { scannerOpen = false }
        )
        return
    }

    fun launchSystemCamera() {
        val file = captureViewModel.createOutputFile()
        pendingSystemCameraEdit = editAfterCapture
        pendingSystemCameraFile = file
        val uri = FileProvider.getUriForFile(
            context,
            systemCameraAuthority(context.packageName),
            file
        )
        systemCameraLauncher.launch(uri)
    }

    LaunchedEffect(systemCameraSessionActive, launchNextSystemCamera, imageEditDraft) {
        if (
            systemCameraSessionActive &&
            launchNextSystemCamera &&
            imageEditDraft == null &&
            pendingSystemCameraFile == null
        ) {
            launchNextSystemCamera = false
            launchSystemCamera()
        }
    }

    val currentEditDraft = imageEditDraft
    if (currentEditDraft != null && pairedConfig?.hasTarget == true) {
        ImageEditScreen(
            draft = currentEditDraft,
            saving = imageEditSaving,
            message = imageEditMessage,
            onApply = { appliedDraft, turns, perspective, crop, lasso, annotations ->
                imageEditSaving = true
                imageEditMessage = "正在生成白底 PNG…"
                captureViewModel.commitImageDraft(appliedDraft, pairedConfig!!, turns, perspective, crop, lasso, annotations) { result ->
                    imageEditSaving = false
                    result.fold(
                        onSuccess = {
                            captureViewModel.discardImageDraft(appliedDraft)
                            imageEditDraft = null
                            imageEditMessage = null
                            captureMessage = "图片已加入上传队列"
                            launchNextSystemCamera = systemCameraSessionActive
                        },
                        onFailure = {
                            imageEditMessage = "无法生成素材：${it.message ?: "请重试"}"
                        }
                    )
                }
            },
            onWorkingDraftChange = { imageEditDraft = it },
            onDiscard = {
                captureViewModel.discardImageDraft(currentEditDraft)
                imageEditDraft = null
                imageEditMessage = null
                launchNextSystemCamera = systemCameraSessionActive
            }
        )
        return
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(MathNotesColors.Background)
    ) {
        Box(Modifier.fillMaxSize().statusBarsPadding()) {
            when (section) {
            AppSection.STANDALONE -> StandaloneScreen()
            AppSection.NOTES -> CompanionNotesScreen(
                pairing = pairedConfig,
                targets = availableTargets,
                themeId = themeId,
                endpointCandidates = pairedConfig?.let(pairingStore::endpointCandidates).orEmpty(),
                onPairingVerified = { verified, targets ->
                    if (pairingStore.save(verified)) {
                        pairedConfig = pairingStore.load()
                        pairingProfiles = pairingStore.list()
                        availableTargets = targets
                        pairedConfig?.let(captureViewModel::resumeBlockedAfterPairing)
                    }
                }
            )
            AppSection.CAPTURE -> CaptureScreen(
                pairedConfig,
                availableTargets,
                captures.count { isActiveQueueState(it.state) },
                onSelectTarget = { target ->
                    pairedConfig?.withTarget(target)?.let { updated ->
                        if (pairingStore.save(updated)) {
                            pairedConfig = pairingStore.load()
                            pairingProfiles = pairingStore.list()
                        }
                    }
                },
                editAfterCapture = editAfterCapture,
                onEditAfterCaptureChange = { editAfterCapture = it },
                onOpenSystemCamera = {
                    systemCameraSessionActive = true
                    launchNextSystemCamera = true
                },
                recentCapturePaths = captures.filter {
                    it.materialType == com.mathnotes.capture.storage.MaterialType.IMAGE && it.localCopyAvailable
                }.map(CaptureEntity::localPath).take(40),
                onOpenRecentGallery = { paths -> previewGalleryPaths = paths },
                onPickImage = {
                    galleryLauncher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                },
                onPickPdf = { pdfLauncher.launch(arrayOf("application/pdf")) },
                statusMessage = captureMessage
            )
            AppSection.QUEUE -> QueueScreen(
                captures,
                captureViewModel::deleteAcknowledged,
                captureViewModel::retry,
                captureViewModel::cancel,
                captureViewModel::clearRecentUploaded,
                captureViewModel::clearUploadedHistory
            )
            AppSection.SETTINGS -> PairingSettingsScreen(
                pairedConfig = pairedConfig,
                profiles = pairingProfiles,
                busy = checking,
                statusMessage = statusMessage,
                onScan = { scannerOpen = true },
                onPair = { acceptPairing(it) },
                onCheck = { pairedConfig?.let { pendingPairing = it } },
                onActivate = { profileId ->
                    if (pairingStore.activate(profileId)) {
                        pairedConfig = pairingStore.load()
                        pairingProfiles = pairingStore.list()
                        availableTargets = emptyList()
                        pairedConfig?.let { pendingPairing = it }
                    }
                },
                onRemove = { profileId ->
                    if (pairingStore.remove(profileId)) {
                        pairedConfig = pairingStore.load()
                        pairingProfiles = pairingStore.list()
                        availableTargets = emptyList()
                        statusMessage = "已移除电脑配对"
                    } else {
                        statusMessage = "未能移除配对信息，请重试"
                    }
                },
                notificationPermission = notificationPermission.state,
                onNotificationAction = notificationPermission.performAction,
                themeId = themeId,
                onThemeChange = onThemeChange
            )
        }

            MathNotesFloatingNavigation(
                items = AppSection.entries.map { MathNotesNavItem(it.key, it.label, it.icon) },
                selectedKey = section.key,
                onSelect = { key -> section = AppSection.entries.first { it.key == key } },
                modifier = Modifier.align(Alignment.BottomCenter)
            )
        }

        previewGalleryPaths?.takeIf { it.isNotEmpty() }?.let { paths ->
            CapturePreviewGallery(
                paths = paths,
                onClose = { previewGalleryPaths = null }
            )
        }
    }
}

@Composable
private fun CaptureScreen(
    pairedConfig: PairingConfig?,
    targets: List<PairingTarget>,
    queueCount: Int,
    onSelectTarget: (PairingTarget) -> Unit,
    editAfterCapture: Boolean,
    onEditAfterCaptureChange: (Boolean) -> Unit,
    onOpenSystemCamera: () -> Unit,
    recentCapturePaths: List<String>,
    onOpenRecentGallery: (List<String>) -> Unit,
    onPickImage: () -> Unit,
    onPickPdf: () -> Unit,
    statusMessage: String?
) {
    var targetMenuOpen by remember { mutableStateOf(false) }
    var targetNotebook by remember { mutableStateOf<String?>(null) }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(start = 22.dp, top = 28.dp, end = 22.dp, bottom = 112.dp)
    ) {
        MathNotesPageHeader(
            eyebrow = "MathNotes",
            title = "拍下这一页",
            detail = "照片会先安全保存在手机，再送往当前电脑的 Session。"
        )
        Spacer(Modifier.height(24.dp))
        if (pairedConfig != null && targets.isNotEmpty()) {
            BoxWithConstraints {
                MathNotesPaper(
                    Modifier
                        .fillMaxWidth()
                        .clickable {
                            targetNotebook = null
                            targetMenuOpen = true
                        }
                ) {
                    Text("照片送往", style = MaterialTheme.typography.labelMedium, color = MathNotesColors.Muted)
                    Spacer(Modifier.height(5.dp))
                    Text(
                        pairedConfig.targetTitle.ifBlank { pairedConfig.sessionId },
                        style = MaterialTheme.typography.titleMedium,
                        color = MathNotesColors.Ink
                    )
                    Text("点击切换 Session", style = MaterialTheme.typography.bodySmall, color = MathNotesColors.Accent)
                }
                val menuShape = RoundedCornerShape(10.dp)
                DropdownMenu(
                    expanded = targetMenuOpen,
                    onDismissRequest = { targetMenuOpen = false },
                    modifier = Modifier
                        .width(maxWidth)
                        .background(MathNotesColors.Paper, menuShape)
                        .border(BorderStroke(1.dp, MathNotesColors.Line), menuShape),
                    shape = menuShape,
                    containerColor = MathNotesColors.Paper,
                    tonalElevation = 0.dp,
                    shadowElevation = 8.dp
                ) {
                    if (targetNotebook == null) {
                        targets.groupBy { it.notebookId }.forEach { (notebookId, notebookTargets) ->
                            val notebookTitle = notebookTargets.firstOrNull()?.notebookTitle.orEmpty().ifBlank { notebookId }
                            DropdownMenuItem(
                                text = {
                                    Column {
                                        Text("▸  $notebookTitle", style = MaterialTheme.typography.titleMedium, color = MathNotesColors.Ink)
                                        Spacer(Modifier.height(3.dp))
                                        Text("${notebookTargets.size} 个 Session", style = MaterialTheme.typography.bodySmall, color = MathNotesColors.Muted)
                                    }
                                },
                                onClick = { targetNotebook = notebookId }
                            )
                        }
                    } else {
                        DropdownMenuItem(
                            text = { Text("‹  返回 Notebook", color = MathNotesColors.Accent) },
                            onClick = { targetNotebook = null }
                        )
                    }
                    targets.filter { it.notebookId == targetNotebook }.forEach { target ->
                        val selected = target.notebookId == pairedConfig.notebookId &&
                            target.sessionId == pairedConfig.sessionId
                        DropdownMenuItem(
                            text = {
                                Column {
                                    Text(
                                        target.title,
                                        style = MaterialTheme.typography.titleMedium,
                                        color = MathNotesColors.Ink
                                    )
                                    Spacer(Modifier.height(3.dp))
                                    Text(
                                        if (selected) "当前 Session" else "选择此 Session",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = if (selected) MathNotesColors.Accent else MathNotesColors.Muted
                                    )
                                }
                            },
                            onClick = {
                                onSelectTarget(target)
                                targetMenuOpen = false
                            },
                            modifier = Modifier.background(
                                if (selected) MathNotesColors.AccentSoft else MathNotesColors.Paper,
                                RoundedCornerShape(7.dp)
                            )
                        )
                    }
                }
            }
        }
        Spacer(Modifier.height(14.dp))
        MathNotesPaper(Modifier.fillMaxWidth()) {
            Text("本机队列", style = MaterialTheme.typography.labelMedium, color = MathNotesColors.Muted)
            Spacer(Modifier.height(7.dp))
            Text(
                if (queueCount == 0) "没有待处理素材" else "$queueCount 项素材正在等待或上传",
                style = MaterialTheme.typography.titleMedium,
                color = MathNotesColors.Ink
            )
        }
        Spacer(Modifier.height(22.dp))
        Row(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            MathNotesPrimaryButton(
                text = if (pairedConfig?.hasTarget == true) "拍照" else "请先选择笔记",
                onClick = onOpenSystemCamera,
                enabled = pairedConfig?.hasTarget == true,
                icon = R.drawable.ic_mathnotes_camera,
                modifier = Modifier.weight(1f)
            )
            MathNotesPaper(
                Modifier.clickable { onEditAfterCaptureChange(!editAfterCapture) }
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Text(
                        "拍后编辑",
                        color = MathNotesColors.Ink,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium
                    )
                    Switch(
                        checked = editAfterCapture,
                        onCheckedChange = onEditAfterCaptureChange
                    )
                }
            }
        }
        Spacer(Modifier.height(7.dp))
        Text(
            "使用手机厂商相机与防抖；确认一张后会继续拍摄，取消或返回时结束。",
            color = MathNotesColors.Muted,
            style = MaterialTheme.typography.bodySmall
        )
        if (recentCapturePaths.isNotEmpty()) {
            Spacer(Modifier.height(12.dp))
            MathNotesPaper(
                Modifier
                    .fillMaxWidth()
                    .clickable { onOpenRecentGallery(recentCapturePaths) }
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    val path = recentCapturePaths.first()
                    val thumbnail = remember(path) { loadCameraThumbnail(path) }
                    if (thumbnail != null) {
                        Image(
                            bitmap = thumbnail.asImageBitmap(),
                            contentDescription = "打开最近拍摄素材",
                            modifier = Modifier.size(64.dp)
                        )
                    }
                    Column {
                        Text("最近拍摄", style = MaterialTheme.typography.titleMedium, color = MathNotesColors.Ink)
                        Text(
                            "${recentCapturePaths.size} 张 · 点开后左右滑动",
                            style = MaterialTheme.typography.bodySmall,
                            color = MathNotesColors.Muted
                        )
                    }
                }
            }
        }
        Spacer(Modifier.height(9.dp))
        MathNotesSecondaryButton(
            text = "从相册选择",
            onClick = onPickImage,
            enabled = pairedConfig?.hasTarget == true,
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(Modifier.height(9.dp))
        MathNotesSecondaryButton(
            text = "选择 PDF",
            onClick = onPickPdf,
            enabled = pairedConfig?.hasTarget == true,
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(Modifier.height(7.dp))
        Text(
            "PDF 会先安全保存并上传；阅读、分页识别和目标位置由电脑端确认。",
            color = MathNotesColors.Muted,
            style = MaterialTheme.typography.bodySmall
        )
        statusMessage?.let {
            Spacer(Modifier.height(10.dp))
            Text(it, color = MathNotesColors.Muted, style = MaterialTheme.typography.bodySmall)
        }
    }

}

internal fun isActiveQueueState(state: String): Boolean = state == CaptureState.PENDING ||
    state == CaptureState.UPLOADING ||
    state == CaptureState.RETRYABLE

internal fun systemCameraAuthority(packageName: String): String = "$packageName.files"
