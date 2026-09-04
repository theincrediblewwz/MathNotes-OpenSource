package com.mathnotes.capture

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ZoomState
import androidx.camera.view.CameraController
import androidx.camera.view.LifecycleCameraController
import androidx.camera.view.PreviewView
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.Observer
import com.mathnotes.capture.ui.MathNotesColors
import java.io.File
import java.util.Locale

@Composable
internal fun InlineCaptureCamera(
    createOutputFile: () -> File,
    onPhotoSaved: (File) -> Unit,
    onError: (String) -> Unit,
    recentPath: String? = null,
    onOpenRecent: () -> Unit = {},
    onOpenImport: () -> Unit = {},
    overlayContent: @Composable BoxScope.() -> Unit = {},
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var granted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED
        )
    }
    var capturing by remember { mutableStateOf(false) }
    var cameraReady by remember { mutableStateOf(false) }
    var zoomRatio by remember { mutableStateOf(1f) }
    var focusPoint by remember { mutableStateOf<Offset?>(null) }
    var focusState by remember { mutableStateOf(CameraController.TAP_TO_FOCUS_NOT_STARTED) }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        granted = it
        if (!it) onError("需要相机权限才能拍摄笔记")
    }
    val mainExecutor = remember(context) { ContextCompat.getMainExecutor(context) }
    val controller = remember(context) {
        LifecycleCameraController(context).apply {
            cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA
            setEnabledUseCases(CameraController.IMAGE_CAPTURE)
            imageCaptureMode = ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY
            isPinchToZoomEnabled = true
            isTapToFocusEnabled = true
        }
    }
    val recentThumbnail = recentPath?.let { rememberCameraThumbnail(it) }

    fun takePhoto() {
        if (!granted || !cameraReady || capturing) return
        val output = runCatching(createOutputFile).getOrElse {
            onError("无法创建照片文件：${it.message ?: "请重试"}")
            return
        }
        capturing = true
        controller.takePicture(
            ImageCapture.OutputFileOptions.Builder(output).build(),
            mainExecutor,
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                    capturing = false
                    onPhotoSaved(output)
                }

                override fun onError(exception: ImageCaptureException) {
                    capturing = false
                    output.delete()
                    onError("拍摄失败：${exception.message ?: "请重试"}")
                }
            }
        )
    }

    LaunchedEffect(Unit) {
        if (!granted) permissionLauncher.launch(Manifest.permission.CAMERA)
    }

    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(22.dp),
        color = Color(0xFF1F2421),
        border = BorderStroke(1.dp, MathNotesColors.Line),
        tonalElevation = 0.dp,
        shadowElevation = 0.dp
    ) {
        Column(Modifier.fillMaxSize()) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .background(Color.Black)
                    .pointerInput(controller) {
                        awaitPointerEventScope {
                            while (true) {
                                val event = awaitPointerEvent(PointerEventPass.Initial)
                                event.changes.firstOrNull { it.pressed && !it.previousPressed }?.let { change ->
                                    focusPoint = change.position
                                }
                            }
                        }
                    }
            ) {
                if (granted) {
                    AndroidView(
                        modifier = Modifier.fillMaxSize(),
                        factory = {
                            PreviewView(it).apply {
                                implementationMode = PreviewView.ImplementationMode.COMPATIBLE
                                scaleType = PreviewView.ScaleType.FILL_CENTER
                                this.controller = controller
                            }
                        },
                        update = { it.controller = controller }
                    )
                } else {
                    Column(Modifier.align(Alignment.Center).padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("允许相机权限后即可拍摄", color = Color.White)
                        Spacer(Modifier.height(12.dp))
                        Surface(
                            modifier = Modifier
                                .clip(RoundedCornerShape(12.dp))
                                .clickable { permissionLauncher.launch(Manifest.permission.CAMERA) },
                            shape = RoundedCornerShape(12.dp),
                            color = Color.White
                        ) {
                            Text("授权相机", color = MathNotesColors.Ink, modifier = Modifier.padding(horizontal = 18.dp, vertical = 11.dp))
                        }
                    }
                }

                Box(
                    Modifier
                        .align(Alignment.Center)
                        .padding(horizontal = 26.dp, vertical = 34.dp)
                        .fillMaxSize()
                        .border(1.dp, Color.White.copy(alpha = 0.42f), RoundedCornerShape(12.dp))
                )
                if (focusState != CameraController.TAP_TO_FOCUS_NOT_STARTED) {
                    focusPoint?.let { point ->
                        val focusColor = when (focusState) {
                            CameraController.TAP_TO_FOCUS_FOCUSED -> MathNotesColors.Success
                            CameraController.TAP_TO_FOCUS_FAILED,
                            CameraController.TAP_TO_FOCUS_NOT_FOCUSED -> MathNotesColors.Error
                            else -> Color.White
                        }
                        Canvas(Modifier.matchParentSize()) {
                            drawCircle(
                                color = focusColor,
                                radius = 25.dp.toPx(),
                                center = point,
                                style = Stroke(width = 2.dp.toPx())
                            )
                            drawCircle(
                                color = focusColor.copy(alpha = 0.5f),
                                radius = 7.dp.toPx(),
                                center = point,
                                style = Stroke(width = 1.dp.toPx())
                            )
                        }
                    }
                }
                Surface(
                    modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 56.dp),
                    shape = RoundedCornerShape(14.dp),
                    color = Color.Black.copy(alpha = 0.58f),
                    border = BorderStroke(1.dp, Color.White.copy(alpha = 0.18f))
                ) {
                    Text(
                        String.format(Locale.ROOT, "%.1f×", zoomRatio),
                        color = Color.White,
                        modifier = Modifier.padding(horizontal = 11.dp, vertical = 6.dp)
                    )
                }
                overlayContent()
            }

            Row(
                Modifier.fillMaxWidth().height(88.dp).background(MathNotesColors.Paper).padding(horizontal = 18.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = androidx.compose.foundation.layout.Arrangement.SpaceBetween
            ) {
                Surface(
                    modifier = Modifier
                        .size(50.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .clickable(enabled = recentThumbnail != null, onClick = onOpenRecent),
                    shape = RoundedCornerShape(12.dp),
                    color = MathNotesColors.Subtle,
                    border = BorderStroke(1.dp, MathNotesColors.Line)
                ) {
                    if (recentThumbnail != null) {
                        Image(
                            bitmap = recentThumbnail.asImageBitmap(),
                            contentDescription = "最近拍摄",
                            modifier = Modifier.fillMaxSize(),
                            contentScale = ContentScale.Crop
                        )
                    } else {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Icon(
                                painterResource(android.R.drawable.ic_menu_recent_history),
                                contentDescription = "最近拍摄",
                                tint = MathNotesColors.Muted,
                                modifier = Modifier.size(22.dp)
                            )
                        }
                    }
                }

                Surface(
                    modifier = Modifier
                        .size(72.dp)
                        .clip(CircleShape)
                        .semantics { contentDescription = "拍照" }
                        .clickable(enabled = granted && cameraReady && !capturing, onClick = ::takePhoto),
                    shape = CircleShape,
                    color = MathNotesColors.Paper,
                    border = BorderStroke(4.dp, MathNotesColors.Accent),
                    shadowElevation = 0.dp
                ) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Box(Modifier.size(54.dp).background(MathNotesColors.Paper, CircleShape))
                        if (capturing) CircularProgressIndicator(Modifier.size(26.dp), color = MathNotesColors.Accent, strokeWidth = 2.dp)
                    }
                }

                Surface(
                    modifier = Modifier
                        .size(50.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .clickable(onClick = onOpenImport),
                    shape = RoundedCornerShape(12.dp),
                    color = MathNotesColors.Subtle
                ) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Icon(
                            painterResource(android.R.drawable.ic_menu_gallery),
                            contentDescription = "导入图片或 PDF",
                            tint = MathNotesColors.Ink,
                            modifier = Modifier.size(24.dp)
                        )
                    }
                }
            }
        }
    }

    DisposableEffect(controller, lifecycleOwner, granted) {
        val focusObserver = Observer<Int> { next ->
            focusState = next ?: CameraController.TAP_TO_FOCUS_NOT_STARTED
            if (focusState == CameraController.TAP_TO_FOCUS_NOT_STARTED) focusPoint = null
        }
        val zoomObserver = Observer<ZoomState> { state ->
            zoomRatio = state?.zoomRatio ?: 1f
        }
        controller.tapToFocusState.observe(lifecycleOwner, focusObserver)
        controller.zoomState.observe(lifecycleOwner, zoomObserver)
        fun rebindCamera() {
            cameraReady = false
            if (!granted) return
            runCatching {
                controller.unbind()
                controller.bindToLifecycle(lifecycleOwner)
                controller.initializationFuture.addListener(
                    { cameraReady = true },
                    mainExecutor
                )
            }.onFailure {
                cameraReady = false
                onError("相机启动失败：${it.message ?: "请重试"}")
            }
        }
        val lifecycleObserver = LifecycleEventObserver { _, event ->
            when {
                shouldRebindInlineCamera(event) -> rebindCamera()
                event == Lifecycle.Event.ON_PAUSE -> cameraReady = false
            }
        }
        lifecycleOwner.lifecycle.addObserver(lifecycleObserver)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(lifecycleObserver)
            controller.tapToFocusState.removeObserver(focusObserver)
            controller.zoomState.removeObserver(zoomObserver)
            cameraReady = false
            runCatching { controller.unbind() }
        }
    }
}

internal fun shouldRebindInlineCamera(event: Lifecycle.Event): Boolean = event == Lifecycle.Event.ON_RESUME
