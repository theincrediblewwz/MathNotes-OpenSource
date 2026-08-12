package com.mathnotes.capture.pairing

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.mlkit.vision.MlKitAnalyzer
import androidx.camera.view.CameraController
import androidx.camera.view.LifecycleCameraController
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.mathnotes.capture.R
import com.mathnotes.capture.ui.MathNotesColors
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.ZoomSuggestionOptions
import com.google.mlkit.vision.barcode.common.Barcode
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

@Composable
fun QrScannerScreen(onResult: (String) -> Boolean, onCancel: () -> Unit) {
    val context = LocalContext.current
    var granted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        granted = it
    }
    var scannerStatus by remember { mutableStateOf("正在启动相机…") }
    LaunchedEffect(Unit) {
        if (!granted) permissionLauncher.launch(Manifest.permission.CAMERA)
    }

    Box(Modifier.fillMaxSize().background(Color(0xFF111513))) {
        if (granted) CameraPreview(onResult, onStatus = { scannerStatus = it })
        else Text(
            "需要相机权限才能扫描电脑端配对二维码",
            color = Color.White,
            modifier = Modifier.align(Alignment.Center).padding(32.dp)
        )
        Box(
            Modifier
                .align(Alignment.Center)
                .size(248.dp)
                .border(2.dp, Color.White.copy(alpha = 0.78f), RoundedCornerShape(12.dp))
        )
        Column(
            modifier = Modifier.fillMaxSize().padding(20.dp),
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            Surface(
                shape = RoundedCornerShape(10.dp),
                color = Color(0xB2242424),
                border = BorderStroke(1.dp, Color.White.copy(alpha = 0.12f))
            ) {
                Column(Modifier.padding(horizontal = 14.dp, vertical = 11.dp)) {
                    Text("扫描配对二维码", color = Color.White)
                    Text("将方框对准电脑端配对页", color = Color.White.copy(alpha = 0.7f))
                    Text(scannerStatus, color = Color.White.copy(alpha = 0.62f))
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                Surface(
                    modifier = Modifier.clickable(onClick = onCancel),
                    shape = RoundedCornerShape(14.dp),
                    color = Color(0xE6FFFEFD),
                    border = BorderStroke(1.dp, MathNotesColors.Line),
                    shadowElevation = 8.dp
                ) {
                    Row(
                        Modifier.padding(horizontal = 16.dp, vertical = 13.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(7.dp)
                    ) {
                        Icon(
                            painterResource(R.drawable.ic_mathnotes_back),
                            contentDescription = null,
                            tint = MathNotesColors.Ink,
                            modifier = Modifier.size(18.dp)
                        )
                        Text("取消", color = MathNotesColors.Ink)
                    }
                }
            }
        }
    }
}

@Composable
private fun CameraPreview(onResult: (String) -> Boolean, onStatus: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    val currentOnResult = rememberUpdatedState(onResult)
    val currentOnStatus = rememberUpdatedState(onStatus)
    val resolved = remember { AtomicBoolean(false) }
    val dispatchingResult = remember { AtomicBoolean(false) }
    val frameCount = remember { AtomicInteger(0) }
    val maxZoomRatio = remember { AtomicReference(4f) }
    val mainExecutor = remember(context) { ContextCompat.getMainExecutor(context) }
    val reportStatus: (String) -> Unit = remember(mainExecutor) {
        { message -> mainExecutor.execute { currentOnStatus.value(message) } }
    }
    val controller = remember(context) {
        LifecycleCameraController(context).apply {
            cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA
            setEnabledUseCases(CameraController.IMAGE_ANALYSIS)
            imageAnalysisBackpressureStrategy = ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST
            isPinchToZoomEnabled = true
            isTapToFocusEnabled = true
        }
    }
    val scanner = remember(controller) {
        val zoomOptions = ZoomSuggestionOptions.Builder { ratio ->
            val boundedRatio = ratio.coerceIn(1f, maxZoomRatio.get())
            runCatching { controller.setZoomRatio(boundedRatio) }
                .onSuccess { reportStatus("发现远处二维码，正在自动拉近 ${"%.1f".format(boundedRatio)}×") }
                .isSuccess
        }
            .setMaxSupportedZoomRatio(maxZoomRatio.get())
            .build()
        val options = BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .enableAllPotentialBarcodes()
            .setZoomSuggestionOptions(zoomOptions)
            .build()
        BarcodeScanning.getClient(options)
    }
    val analyzer = remember(scanner, executor) {
        MlKitAnalyzer(
            listOf(scanner),
            ImageAnalysis.COORDINATE_SYSTEM_VIEW_REFERENCED,
            executor
        ) { result ->
            val count = frameCount.incrementAndGet()
            val failure = result.getThrowable(scanner)
            val barcodes = result.getValue(scanner).orEmpty()
            val rawValue = barcodes.firstNotNullOfOrNull { it.rawValue }
            when {
                failure != null -> reportStatus("相机帧已到达，但识别器失败；正在自动重试")
                rawValue != null && dispatchingResult.compareAndSet(false, true) -> mainExecutor.execute {
                    if (currentOnResult.value(rawValue)) {
                        resolved.set(true)
                        currentOnStatus.value("已读出配对码，正在验证电脑…")
                    } else {
                        currentOnStatus.value("已读出二维码，但不是有效的 MathNotes 配对码")
                        dispatchingResult.set(false)
                    }
                }
                barcodes.isNotEmpty() -> reportStatus("已发现二维码轮廓，正在对焦和解码…")
                count == 1 -> reportStatus("已收到第 1 帧，识别器正在工作")
                count % 20 == 0 -> reportStatus("已分析 $count 帧，尚未发现二维码；可点按二维码对焦或双指放大")
            }
        }
    }

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

    DisposableEffect(controller, lifecycleOwner, analyzer) {
        reportStatus("正在绑定相机和离线识别器…")
        runCatching {
            controller.setImageAnalysisAnalyzer(executor, analyzer)
            controller.bindToLifecycle(lifecycleOwner)
            controller.initializationFuture.addListener(
                {
                    runCatching {
                        maxZoomRatio.set(controller.cameraInfo?.zoomState?.value?.maxZoomRatio?.coerceAtMost(6f) ?: 4f)
                    }
                    reportStatus("相机已连接，等待第一帧；可点按二维码对焦")
                },
                mainExecutor
            )
        }.onFailure { error ->
            reportStatus("相机启动失败：${error.message ?: "请返回后重试"}")
        }
        onDispose {
            runCatching { controller.clearImageAnalysisAnalyzer() }
            runCatching { controller.unbind() }
            scanner.close()
            executor.shutdownNow()
        }
    }
}
