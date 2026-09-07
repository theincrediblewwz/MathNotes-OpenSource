package com.mathnotes.capture

import android.os.Bundle
import android.content.ActivityNotFoundException
import android.content.Intent
import android.provider.MediaStore
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
import androidx.compose.foundation.selection.toggleable
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
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
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Surface
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.core.content.FileProvider
import com.mathnotes.capture.notification.rememberNotificationPermissionController
import com.mathnotes.capture.imageedit.ImageEditDraft
import com.mathnotes.capture.imageedit.ImageEditScreen
import com.mathnotes.capture.companion.resolveNotebookTitle
import com.mathnotes.capture.notes.UnifiedNotesScreen
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
import com.mathnotes.capture.standalone.StandaloneViewModel
import com.mathnotes.capture.standalone.StandaloneBlockKind
import com.mathnotes.capture.standalone.StandaloneNotebookEntity
import com.mathnotes.capture.standalone.StandaloneProviderCatalog
import com.mathnotes.capture.standalone.StandaloneSessionEntity
import com.mathnotes.capture.standalone.StandaloneTaskStatus
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
    NOTES("notes", "笔记", R.drawable.ic_mathnotes_notes),
    CAPTURE("capture", "拍摄", R.drawable.ic_mathnotes_camera),
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
    val routingPreferences = remember(context) { CaptureRoutingPreferences(context.applicationContext) }
    val captureViewModel: CaptureViewModel = viewModel()
    val standaloneViewModel: StandaloneViewModel = viewModel()
    val captures by captureViewModel.captures.collectAsStateWithLifecycle()
    val standaloneProviderProfile by standaloneViewModel.providerProfile.collectAsStateWithLifecycle()
    val standaloneState by standaloneViewModel.state.collectAsStateWithLifecycle()
    val recentGalleryItems = remember(captures, standaloneState.allBlocks, standaloneState.allTasks) {
        val uploadItems = captures.filter {
            it.materialType == com.mathnotes.capture.storage.MaterialType.IMAGE &&
                it.localCopyAvailable && File(it.localPath).isFile
        }.map { capture ->
            CaptureGalleryItem(
                id = "upload:${capture.captureId}",
                path = capture.localPath,
                label = capture.sourceName.ifBlank { "最近拍摄" },
                canDelete = capture.state == CaptureState.UPLOADED,
                createdAt = capture.createdAt
            )
        }
        val localItems = standaloneState.allBlocks.filter {
            it.kind == StandaloneBlockKind.IMAGE && File(it.localPath).isFile
        }
            .map { block ->
                val tasks = standaloneState.allTasks.filter { it.assetBlockId == block.id }
                CaptureGalleryItem(
                    id = "local:${block.id}",
                    path = block.localPath,
                    label = "本机拍摄",
                    canDelete = tasks.none { it.status == StandaloneTaskStatus.CLAIMED },
                    createdAt = block.createdAt
                )
            }
        (uploadItems + localItems).sortedByDescending(CaptureGalleryItem::createdAt).take(80)
    }
    var section by rememberSaveable { mutableStateOf(AppSection.NOTES) }
    var openLocalNotesRequest by remember { mutableStateOf(0) }
    var selectingLocalCaptureTarget by rememberSaveable { mutableStateOf(false) }
    var pairedConfig by remember { mutableStateOf(pairingStore.load()) }
    var windowsConnectionVerified by remember { mutableStateOf(false) }
    var preferWindowsRecognition by remember { mutableStateOf(routingPreferences.preferWindows()) }
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
    var pendingSystemCameraDestination by remember { mutableStateOf<CaptureRecognitionDestination?>(null) }
    var pendingSystemCameraLocalSessionId by remember { mutableStateOf<String?>(null) }
    var imageEditDestination by remember { mutableStateOf(CaptureRecognitionDestination.ANDROID_LOCAL_DRAFT) }
    var imageEditLocalSessionId by remember { mutableStateOf<String?>(null) }
    var editAfterCapture by rememberSaveable { mutableStateOf(false) }
    var systemCameraSessionActive by rememberSaveable { mutableStateOf(false) }
    var originalCameraImportPending by rememberSaveable { mutableStateOf(false) }
    var launchNextSystemCamera by remember { mutableStateOf(false) }
    var previewGalleryOpen by remember { mutableStateOf(false) }
    var queueFocusCaptureId by remember { mutableStateOf<String?>(null) }
    var noteReadingRequest by remember { mutableStateOf<com.mathnotes.capture.notes.NoteReadingRequest?>(null) }
    var readerActive by remember { mutableStateOf(false) }
    var readingBottomBarHidden by remember { mutableStateOf(false) }
    LaunchedEffect(previewGalleryOpen) {
        onMediaPreviewChange(previewGalleryOpen)
    }
    val notificationPermission = rememberNotificationPermissionController()
    val captureDestination = resolveCaptureRecognitionDestination(
        preferWindows = preferWindowsRecognition,
        windowsConnectionVerified = windowsConnectionVerified,
        hasWindowsTarget = pairedConfig?.hasTarget == true
    )
    val galleryLauncher = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        originalCameraImportPending = false
        val destination = captureDestination
        captureMessage = "正在保存所选图片…"
        captureViewModel.stageImage(uri) { result ->
            captureMessage = result.fold(
                onSuccess = {
                    imageEditDestination = destination
                    imageEditLocalSessionId = standaloneState.activeSession?.id
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
        val destination = pendingSystemCameraDestination ?: CaptureRecognitionDestination.ANDROID_LOCAL_DRAFT
        val localSessionId = pendingSystemCameraLocalSessionId
        pendingSystemCameraFile = null
        pendingSystemCameraDestination = null
        pendingSystemCameraLocalSessionId = null
        when (systemCameraReturnAction(saved, file != null, shouldEdit)) {
            SystemCameraReturnAction.STOP -> {
                file?.delete()
                systemCameraSessionActive = false
                launchNextSystemCamera = false
                if (!saved) captureMessage = "已返回 MathNotes，可以继续使用下方快门拍摄"
            }
            SystemCameraReturnAction.EDIT -> {
                val capturedFile = requireNotNull(file)
                imageEditDestination = destination
                imageEditLocalSessionId = localSessionId
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
                if (destination == CaptureRecognitionDestination.WINDOWS_SESSION && pairing?.hasTarget == true) {
                    captureMessage = "正在把系统相机照片加入 Windows 队列…"
                    captureViewModel.commit(capturedFile, pairing) { result ->
                        captureMessage = result.fold(
                            onSuccess = { "照片已加入 Windows 队列，继续拍摄" },
                            onFailure = { "无法生成素材：${it.message ?: "请重试"}" }
                        )
                        launchNextSystemCamera = systemCameraSessionActive
                    }
                } else {
                    captureMessage = "正在保存到本机识别队列…"
                    standaloneViewModel.importCapturedFile(capturedFile, localSessionId) { result ->
                        captureMessage = result.fold(
                            onSuccess = {
                                if (standaloneProviderProfile?.enabled == true) "照片已加入本机队列并开始识别"
                                else "照片已保存在本机；请先到设置中配置识别模型"
                            },
                            onFailure = { "无法保存本机照片：${it.message ?: "请重试"}" }
                        )
                        launchNextSystemCamera = systemCameraSessionActive
                    }
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
        windowsConnectionVerified = false
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
                windowsConnectionVerified = true
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
        pendingSystemCameraDestination = captureDestination
        pendingSystemCameraLocalSessionId = standaloneState.activeSession?.id
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
    if (currentEditDraft != null) {
        ImageEditScreen(
            draft = currentEditDraft,
            saving = imageEditSaving,
            message = imageEditMessage,
            onApply = { appliedDraft, turns, perspective, crop, lasso, annotations ->
                imageEditSaving = true
                imageEditMessage = "正在生成白底 PNG…"
                val pairing = pairedConfig
                if (imageEditDestination == CaptureRecognitionDestination.WINDOWS_SESSION && pairing?.hasTarget == true) {
                    captureViewModel.commitImageDraft(appliedDraft, pairing, turns, perspective, crop, lasso, annotations) { result ->
                        imageEditSaving = false
                        result.fold(
                            onSuccess = {
                                captureViewModel.discardImageDraft(appliedDraft)
                                imageEditDraft = null
                                imageEditLocalSessionId = null
                                imageEditMessage = null
                                captureMessage = "图片已加入 Windows 上传队列"
                                launchNextSystemCamera = systemCameraSessionActive
                            },
                            onFailure = {
                                imageEditMessage = "无法生成素材：${it.message ?: "请重试"}"
                            }
                        )
                    }
                } else {
                    captureViewModel.renderImageDraft(appliedDraft, turns, perspective, crop, lasso, annotations) { renderResult ->
                        renderResult.fold(
                            onSuccess = { rendered ->
                                standaloneViewModel.importCapturedFile(rendered, imageEditLocalSessionId) { importResult ->
                                    imageEditSaving = false
                                    importResult.fold(
                                        onSuccess = {
                                            captureViewModel.discardImageDraft(appliedDraft)
                                            imageEditDraft = null
                                            imageEditLocalSessionId = null
                                            imageEditMessage = null
                                            captureMessage = if (standaloneProviderProfile?.enabled == true) {
                                                "图片已加入本机队列并开始识别"
                                            } else {
                                                "图片已保存在本机；请先到设置中配置识别模型"
                                            }
                                            launchNextSystemCamera = systemCameraSessionActive
                                        },
                                        onFailure = {
                                            rendered.delete()
                                            imageEditMessage = "无法保存本机素材：${it.message ?: "请重试"}"
                                        }
                                    )
                                }
                            },
                            onFailure = {
                                imageEditSaving = false
                                imageEditMessage = "无法生成素材：${it.message ?: "请重试"}"
                            }
                        )
                    }
                }
            },
            onWorkingDraftChange = { imageEditDraft = it },
            onDiscard = {
                captureViewModel.discardImageDraft(currentEditDraft)
                imageEditDraft = null
                imageEditMessage = null
                imageEditDestination = CaptureRecognitionDestination.ANDROID_LOCAL_DRAFT
                imageEditLocalSessionId = null
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
            AppSection.NOTES -> UnifiedNotesScreen(
                standaloneViewModel = standaloneViewModel,
                pairing = pairedConfig,
                targets = availableTargets,
                themeId = themeId,
                openLocalRequest = openLocalNotesRequest,
                readingRequest = noteReadingRequest,
                onReadingTap = { if (readerActive) readingBottomBarHidden = !readingBottomBarHidden },
                onReaderActive = { active -> readerActive = active; if (!active) readingBottomBarHidden = false },
                bottomBarHidden = readingBottomBarHidden,
                selectCaptureTarget = selectingLocalCaptureTarget,
                onCaptureTargetSelected = { session ->
                    standaloneViewModel.selectSession(session.id)
                    selectingLocalCaptureTarget = false
                    captureMessage = "已选择拍摄目标：${session.title}"
                    section = AppSection.CAPTURE
                },
                onCancelCaptureTargetSelection = {
                    selectingLocalCaptureTarget = false
                    section = AppSection.CAPTURE
                },
                endpointCandidates = pairedConfig?.let(pairingStore::endpointCandidates).orEmpty(),
                onPairingVerified = { verified, targets ->
                    if (pairingStore.save(verified)) {
                        windowsConnectionVerified = true
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
                captures.count { isActiveQueueState(it.state) } + standaloneState.allTasks.count {
                    it.status == StandaloneTaskStatus.NEEDS_CONFIGURATION ||
                        it.status == StandaloneTaskStatus.AWAITING_CONFIRMATION ||
                        it.status == StandaloneTaskStatus.CLAIMED
                },
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
                preferWindowsRecognition = preferWindowsRecognition,
                windowsConnectionVerified = windowsConnectionVerified,
                onPreferWindowsRecognitionChange = { next ->
                    if (routingPreferences.setPreferWindows(next)) preferWindowsRecognition = next
                },
                localNotebooks = standaloneState.notebooks,
                localSessions = standaloneState.sessions,
                activeLocalSessionId = standaloneState.activeSession?.id,
                onSelectLocalSession = standaloneViewModel::selectSession,
                onOpenLocalNotebooks = {
                    selectingLocalCaptureTarget = true
                    openLocalNotesRequest += 1
                    section = AppSection.NOTES
                },
                onScanComputer = { scannerOpen = true },
                onOpenSystemCamera = {
                    originalCameraImportPending = false
                    systemCameraSessionActive = true
                    launchNextSystemCamera = true
                    captureMessage = "已切换到系统相机；退出系统相机即可返回 MathNotes"
                },
                onOpenOriginalCamera = {
                    systemCameraSessionActive = false
                    launchNextSystemCamera = false
                    try {
                        context.startActivity(Intent(MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA))
                        originalCameraImportPending = true
                        captureMessage = null
                    } catch (_: ActivityNotFoundException) {
                        captureMessage = "无法打开原相机，请先用手机相机拍摄，再从相册选择照片"
                    } catch (_: SecurityException) {
                        captureMessage = "手机未允许打开原相机，请先拍摄，再从相册选择照片"
                    }
                },
                originalCameraImportPending = originalCameraImportPending,
                onDismissOriginalCameraImport = { originalCameraImportPending = false },
                onOpenQueue = {
                    val upload = captures.firstOrNull { isActiveQueueState(it.state) }
                    if (upload != null) {
                        queueFocusCaptureId = upload.captureId
                        section = AppSection.QUEUE
                    } else {
                        section = AppSection.QUEUE
                    }
                },
                createOutputFile = captureViewModel::createOutputFile,
                onPhotoSaved = { capturedFile ->
                    val destination = captureDestination
                    val localSessionId = standaloneState.activeSession?.id
                    if (editAfterCapture) {
                        imageEditDestination = destination
                        imageEditLocalSessionId = localSessionId
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
                                    captureMessage = "无法打开照片：${it.message ?: "请重试"}"
                                }
                            )
                        }
                    } else if (destination == CaptureRecognitionDestination.WINDOWS_SESSION && pairedConfig?.hasTarget == true) {
                        captureMessage = "正在加入 Windows 队列…"
                        captureViewModel.commit(capturedFile, pairedConfig!!) { result ->
                            captureMessage = result.fold(
                                onSuccess = { "照片已加入 Windows 队列" },
                                onFailure = { "无法生成素材：${it.message ?: "请重试"}" }
                            )
                        }
                    } else {
                        captureMessage = "正在保存到本机识别队列…"
                        standaloneViewModel.importCapturedFile(capturedFile, localSessionId) { result ->
                            captureMessage = result.fold(
                                onSuccess = {
                                    if (standaloneProviderProfile?.enabled == true) "照片已加入本机队列并开始识别"
                                    else "照片已保存在本机；请先到设置中配置识别模型"
                                },
                                onFailure = { "无法保存本机照片：${it.message ?: "请重试"}" }
                            )
                        }
                    }
                },
                onCaptureError = { captureMessage = it },
                localProviderLabel = standaloneProviderProfile?.providerId
                    ?.let(StandaloneProviderCatalog::displayLabel)
                    ?: "DeepSeek",
                recentCaptures = recentGalleryItems,
                onOpenRecentGallery = { previewGalleryOpen = true },
                onPickImage = {
                    galleryLauncher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                },
                onPickPdf = { pdfLauncher.launch(arrayOf("application/pdf")) },
                statusMessage = captureMessage
            )
            AppSection.QUEUE -> QueueScreen(
                captures = captures,
                onDelete = captureViewModel::deleteAcknowledged,
                onRetry = captureViewModel::retry,
                onCancel = captureViewModel::cancel,
                onClearRecentUploaded = captureViewModel::clearRecentUploaded,
                onClearUploadedHistory = captureViewModel::clearUploadedHistory,
                onDeleteHistory = { capture ->
                    captureViewModel.deleteUploadedHistory(capture) { result ->
                        captureMessage = result.fold(
                            onSuccess = { "已删除上传历史" },
                            onFailure = { "删除失败：${it.message ?: "请重试"}" }
                        )
                    }
                },
                focusCaptureId = queueFocusCaptureId,
                onFocusConsumed = { queueFocusCaptureId = null },
                onDeleteTask = { capture ->
                    captureViewModel.deleteQueueTask(capture) { result ->
                        captureMessage = result.fold(
                            onSuccess = { "已删除队列任务" },
                            onFailure = { "删除失败：${it.message ?: "请重试"}" }
                        )
                    }
                },
                localTasks = standaloneState.allTasks,
                localBlocks = standaloneState.allBlocks,
                localSessions = standaloneState.sessions,
                localNotebooks = standaloneState.notebooks,
                onDeleteLocalTask = { task ->
                    standaloneViewModel.deleteTask(task) { result ->
                        captureMessage = result.fold(
                            onSuccess = { "已删除本机识别任务" },
                            onFailure = { "删除失败：${it.message ?: "请重试"}" }
                        )
                    }
                },
                connectionLabel = if (preferWindowsRecognition && windowsConnectionVerified && pairedConfig?.hasTarget == true) {
                    "已连接 · ${pairedConfig?.computerLabel.orEmpty().ifBlank { "Windows" }}"
                } else {
                    "本机识别"
                },
                captureTargetLabel = if (preferWindowsRecognition && windowsConnectionVerified && pairedConfig?.hasTarget == true) {
                    pairedConfig?.targetTitle.orEmpty().ifBlank { "Windows Session" }
                } else {
                    listOfNotNull(
                        standaloneState.activeSession?.notebookId?.let { notebookId ->
                            standaloneState.notebooks.firstOrNull { it.id == notebookId }?.title
                        },
                        standaloneState.activeSession?.title
                    ).joinToString(" · ").ifBlank { "本机笔记" }
                },
                onContinueCapture = { section = AppSection.CAPTURE },
                onOpenNote = { request ->
                    noteReadingRequest = request
                    readingBottomBarHidden = false
                    section = AppSection.NOTES
                },
                findPairing = { capture -> pairingStore.findForCapture(capture.pairingProfileId, capture.endpointId) }
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
                        windowsConnectionVerified = false
                        pairedConfig = pairingStore.load()
                        pairingProfiles = pairingStore.list()
                        availableTargets = emptyList()
                        pairedConfig?.let { pendingPairing = it }
                    }
                },
                onRemove = { profileId ->
                    if (pairingStore.remove(profileId)) {
                        windowsConnectionVerified = false
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
                onThemeChange = onThemeChange,
                providerProfile = standaloneProviderProfile,
                onSaveProvider = standaloneViewModel::saveProviderProfile
            )
        }

            if (section != AppSection.NOTES || !readerActive || !readingBottomBarHidden) MathNotesFloatingNavigation(
                items = AppSection.entries.map { MathNotesNavItem(it.key, it.label, it.icon) },
                selectedKey = section.key,
                onSelect = { key ->
                    val next = AppSection.entries.first { it.key == key }
                    if (next != AppSection.NOTES) selectingLocalCaptureTarget = false
                    if (next != AppSection.NOTES) noteReadingRequest = null
                    section = next
                },
                modifier = Modifier.align(Alignment.BottomCenter)
            )
        }

        if (previewGalleryOpen) {
            CapturePreviewGallery(
                items = recentGalleryItems,
                onClose = { previewGalleryOpen = false },
                onDelete = { item ->
                    when {
                        item.id.startsWith("upload:") -> captures.firstOrNull {
                            it.captureId == item.id.removePrefix("upload:")
                        }?.let { capture ->
                            captureViewModel.deleteUploadedHistory(capture) { result ->
                                captureMessage = result.fold(
                                    onSuccess = { "照片已删除" },
                                    onFailure = { "删除失败：${it.message ?: "请重试"}" }
                                )
                            }
                        }
                        item.id.startsWith("local:") -> standaloneState.allBlocks.firstOrNull {
                            it.id == item.id.removePrefix("local:")
                        }?.let { block ->
                            standaloneViewModel.deleteImage(block) { result ->
                                captureMessage = result.fold(
                                    onSuccess = { "照片已删除" },
                                    onFailure = { "删除失败：${it.message ?: "请重试"}" }
                                )
                            }
                        }
                    }
                }
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
    preferWindowsRecognition: Boolean,
    windowsConnectionVerified: Boolean,
    onPreferWindowsRecognitionChange: (Boolean) -> Unit,
    localNotebooks: List<StandaloneNotebookEntity>,
    localSessions: List<StandaloneSessionEntity>,
    activeLocalSessionId: String?,
    onSelectLocalSession: (String) -> Unit,
    onOpenLocalNotebooks: () -> Unit,
    onScanComputer: () -> Unit,
    onOpenSystemCamera: () -> Unit,
    onOpenOriginalCamera: () -> Unit,
    originalCameraImportPending: Boolean,
    onDismissOriginalCameraImport: () -> Unit,
    onOpenQueue: () -> Unit,
    createOutputFile: () -> File,
    onPhotoSaved: (File) -> Unit,
    onCaptureError: (String) -> Unit,
    localProviderLabel: String,
    recentCaptures: List<CaptureGalleryItem>,
    onOpenRecentGallery: () -> Unit,
    onPickImage: () -> Unit,
    onPickPdf: () -> Unit,
    statusMessage: String?
) {
    var targetMenuOpen by remember { mutableStateOf(false) }
    var targetNotebook by remember { mutableStateOf<String?>(null) }
    var importMenuOpen by remember { mutableStateOf(false) }
    val routesToWindows = preferWindowsRecognition && windowsConnectionVerified && pairedConfig?.hasTarget == true
    val activeLocalSession = localSessions.firstOrNull { it.id == activeLocalSessionId } ?: localSessions.firstOrNull()
    val activeLocalNotebook = activeLocalSession?.let { session -> localNotebooks.firstOrNull { it.id == session.notebookId } }
    LaunchedEffect(routesToWindows) {
        targetMenuOpen = false
        targetNotebook = null
    }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(start = 22.dp, top = 8.dp, end = 22.dp, bottom = 138.dp)
    ) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f)) {
                Text("拍下这一页", style = MaterialTheme.typography.headlineMedium, color = MathNotesColors.Ink, fontWeight = FontWeight.Bold)
                Text("保持光线均匀，对齐页面边缘", style = MaterialTheme.typography.bodySmall, color = MathNotesColors.Muted)
            }
            val connectShape = RoundedCornerShape(15.dp)
            Surface(
                modifier = Modifier
                    .width(94.dp)
                    .height(42.dp)
                    .clip(connectShape)
                    .clickable(onClick = onScanComputer),
                shape = connectShape,
                color = MathNotesColors.AccentSoft
            ) {
                Row(
                    Modifier.fillMaxSize().padding(horizontal = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    androidx.compose.material3.Icon(
                        painter = androidx.compose.ui.res.painterResource(R.drawable.ic_mathnotes_qr),
                        contentDescription = "扫码连接电脑",
                        tint = MathNotesColors.Accent,
                        modifier = Modifier.size(18.dp)
                    )
                    Text("连电脑", style = MaterialTheme.typography.labelMedium, color = MathNotesColors.Accent)
                }
            }
        }
        Spacer(Modifier.height(10.dp))
        if (originalCameraImportPending) {
            MathNotesPaper(Modifier.fillMaxWidth().padding(bottom = 10.dp)) {
                Text("原相机拍摄完成后", style = MaterialTheme.typography.titleSmall, color = MathNotesColors.Ink)
                Text("从相册选择刚拍的照片，裁剪或遮盖后再加入队列。", style = MaterialTheme.typography.bodySmall, color = MathNotesColors.Muted)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    MathNotesSecondaryButton("选择刚拍的照片", onPickImage, Modifier.weight(1f))
                    androidx.compose.material3.TextButton(onClick = onDismissOriginalCameraImport) { Text("取消") }
                }
            }
        }
        BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {
            InlineCaptureCamera(
                createOutputFile = createOutputFile,
                onPhotoSaved = onPhotoSaved,
                onError = onCaptureError,
                recentPath = recentCaptures.firstOrNull()?.path,
                onOpenRecent = onOpenRecentGallery,
                onOpenImport = { importMenuOpen = true },
                modifier = Modifier.fillMaxSize(),
                overlayContent = {
                    val targetShape = RoundedCornerShape(18.dp)
                    val recognitionShape = RoundedCornerShape(18.dp)
                    val editShape = RoundedCornerShape(18.dp)
                    Row(
                        Modifier
                            .align(Alignment.BottomCenter)
                            .fillMaxWidth()
                            .padding(horizontal = 10.dp, vertical = 10.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Surface(
                            modifier = Modifier
                                .weight(1.15f)
                                .height(36.dp)
                                .clip(targetShape)
                                .semantics { contentDescription = "选择拍摄目标" }
                                .clickable {
                                    targetNotebook = null
                                    targetMenuOpen = true
                                },
                            shape = targetShape,
                            color = MathNotesColors.Paper.copy(alpha = 0.94f)
                        ) {
                            Box(Modifier.fillMaxSize().padding(horizontal = 11.dp), contentAlignment = Alignment.CenterStart) {
                                Text(
                                    if (routesToWindows) {
                                        pairedConfig?.targetTitle.orEmpty().ifBlank { "选择 Session" }
                                    } else {
                                        activeLocalSession?.title ?: "选择 Session"
                                    },
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MathNotesColors.Ink,
                                    maxLines = 1
                                )
                            }
                        }
                        Surface(
                            modifier = Modifier
                                .weight(1f)
                                .height(36.dp)
                                .clip(recognitionShape)
                                .clickable(
                                    enabled = pairedConfig != null,
                                    onClick = { onPreferWindowsRecognitionChange(!preferWindowsRecognition) }
                                ),
                            shape = recognitionShape,
                            color = MathNotesColors.Paper.copy(alpha = 0.94f)
                        ) {
                            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                Text(
                                    if (routesToWindows) "电脑识别" else "本机识别 · $localProviderLabel",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MathNotesColors.Ink,
                                    maxLines = 1
                                )
                            }
                        }
                        Surface(
                            modifier = Modifier
                                .weight(0.9f)
                                .height(36.dp)
                                .clip(editShape)
                                .toggleable(
                                    value = editAfterCapture,
                                    role = Role.Switch,
                                    onValueChange = onEditAfterCaptureChange
                                )
                                .semantics { contentDescription = "拍后编辑开关" },
                            shape = editShape,
                            color = MathNotesColors.Paper.copy(alpha = 0.94f)
                        ) {
                            Row(
                                Modifier.fillMaxSize().padding(horizontal = 9.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp)
                            ) {
                                Text("拍后编辑", style = MaterialTheme.typography.labelMedium, color = MathNotesColors.Ink, maxLines = 1)
                                Switch(
                                    checked = editAfterCapture,
                                    onCheckedChange = null,
                                    modifier = Modifier.scale(0.66f),
                                    colors = SwitchDefaults.colors(
                                        checkedThumbColor = MathNotesColors.Paper,
                                        checkedTrackColor = MathNotesColors.Accent,
                                        uncheckedThumbColor = MathNotesColors.Muted,
                                        uncheckedTrackColor = MathNotesColors.Line,
                                        uncheckedBorderColor = MathNotesColors.Line
                                    )
                                )
                            }
                        }
                    }
                    statusMessage?.let { message ->
                        Surface(
                            modifier = Modifier.align(Alignment.TopCenter).padding(10.dp),
                            shape = RoundedCornerShape(12.dp),
                            color = MathNotesColors.Paper.copy(alpha = 0.9f)
                        ) {
                            Text(message, style = MaterialTheme.typography.bodySmall, color = MathNotesColors.Muted, modifier = Modifier.padding(horizontal = 11.dp, vertical = 7.dp), maxLines = 1)
                        }
                    }
                }
            )

            val menuShape = RoundedCornerShape(16.dp)
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
                val notebookRows = if (routesToWindows) {
                    targets.groupBy { it.notebookId }.map { (id, grouped) ->
                        Triple(id, resolveNotebookTitle(id, grouped.firstOrNull()?.notebookTitle.orEmpty()), grouped.size)
                    }
                } else {
                    localNotebooks.map { notebook ->
                        Triple(notebook.id, notebook.title, localSessions.count { it.notebookId == notebook.id })
                    }
                }
                if (targetNotebook == null) {
                    notebookRows.forEach { (notebookId, notebookTitle, sessionCount) ->
                        DropdownMenuItem(
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp).clip(RoundedCornerShape(12.dp)),
                            text = {
                                Column {
                                    Text(notebookTitle, style = MaterialTheme.typography.titleMedium, color = MathNotesColors.Ink)
                                    Text("$sessionCount 个 Session", style = MaterialTheme.typography.bodySmall, color = MathNotesColors.Muted)
                                }
                            },
                            onClick = { targetNotebook = notebookId }
                        )
                    }
                    if (!routesToWindows) {
                        DropdownMenuItem(
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp).clip(RoundedCornerShape(12.dp)),
                            text = { Text("打开 Notebooks…", color = MathNotesColors.Accent) },
                            onClick = {
                                targetMenuOpen = false
                                onOpenLocalNotebooks()
                            }
                        )
                    }
                } else {
                    DropdownMenuItem(
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp).clip(RoundedCornerShape(12.dp)),
                        text = { Text("返回 Notebooks", color = MathNotesColors.Accent) },
                        onClick = { targetNotebook = null }
                    )
                    if (routesToWindows) {
                        targets.filter { it.notebookId == targetNotebook }.forEach { target ->
                            val selected = target.notebookId == pairedConfig?.notebookId && target.sessionId == pairedConfig?.sessionId
                            DropdownMenuItem(
                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp).clip(RoundedCornerShape(12.dp)),
                                text = { Text(target.title, color = if (selected) MathNotesColors.Accent else MathNotesColors.Ink) },
                                onClick = {
                                    onSelectTarget(target)
                                    targetMenuOpen = false
                                }
                            )
                        }
                    } else {
                        localSessions.filter { it.notebookId == targetNotebook }.forEach { session ->
                            val selected = session.id == activeLocalSession?.id
                            DropdownMenuItem(
                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp).clip(RoundedCornerShape(12.dp)),
                                text = { Text(session.title, color = if (selected) MathNotesColors.Accent else MathNotesColors.Ink) },
                                onClick = {
                                    onSelectLocalSession(session.id)
                                    targetMenuOpen = false
                                }
                            )
                        }
                    }
                }
            }
            DropdownMenu(
                expanded = importMenuOpen,
                onDismissRequest = { importMenuOpen = false },
                shape = menuShape,
                containerColor = MathNotesColors.Paper,
                tonalElevation = 0.dp,
                shadowElevation = 8.dp
            ) {
                DropdownMenuItem(
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp).clip(RoundedCornerShape(12.dp)),
                    text = { Text("打开手机原相机 · 拍完后导入") },
                    onClick = {
                        importMenuOpen = false
                        onOpenOriginalCamera()
                    }
                )
                DropdownMenuItem(
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp).clip(RoundedCornerShape(12.dp)),
                    text = { Text("系统相机快捷拍摄 · 自动返回") },
                    onClick = {
                        importMenuOpen = false
                        onOpenSystemCamera()
                    }
                )
                DropdownMenuItem(
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp).clip(RoundedCornerShape(12.dp)),
                    text = { Text("从相册选择") },
                    onClick = {
                        importMenuOpen = false
                        onPickImage()
                    }
                )
                DropdownMenuItem(
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp).clip(RoundedCornerShape(12.dp)),
                    text = { Text("导入 PDF") },
                    enabled = windowsConnectionVerified && pairedConfig?.hasTarget == true,
                    onClick = {
                        importMenuOpen = false
                        onPickPdf()
                    }
                )
                DropdownMenuItem(
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp).clip(RoundedCornerShape(12.dp)),
                    text = { Text(if (queueCount == 0) "打开本机队列" else "打开本机队列 · $queueCount") },
                    onClick = {
                        importMenuOpen = false
                        onOpenQueue()
                    }
                )
            }
        }
    }
}

internal fun isActiveQueueState(state: String): Boolean = state == CaptureState.PENDING ||
    state == CaptureState.UPLOADING ||
    state == CaptureState.RETRYABLE

internal fun systemCameraAuthority(packageName: String): String = "$packageName.files"
