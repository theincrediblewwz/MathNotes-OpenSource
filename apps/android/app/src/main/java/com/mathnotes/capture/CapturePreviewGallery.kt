package com.mathnotes.capture

import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.mathnotes.capture.ui.MathNotesColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal data class CaptureGalleryItem(
    val id: String,
    val path: String,
    val label: String,
    val canDelete: Boolean,
    val createdAt: Long = 0L
)

@Composable
internal fun CapturePreviewGallery(
    items: List<CaptureGalleryItem>,
    onClose: () -> Unit,
    onDelete: (CaptureGalleryItem) -> Unit,
    initialSelectedId: String? = null,
    detailOnly: Boolean = false,
    modifier: Modifier = Modifier
) {
    var selectedId by rememberSaveable(initialSelectedId) { mutableStateOf(initialSelectedId) }
    var pendingDelete by remember { mutableStateOf<CaptureGalleryItem?>(null) }
    var deleteNotice by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(items, selectedId) {
        if (selectedId != null && items.none { it.id == selectedId }) selectedId = null
    }

    if (selectedId == null || items.none { it.id == selectedId }) {
        BackHandler(onBack = onClose)
        CaptureGalleryGrid(
            items = items,
            onClose = onClose,
            onOpen = { selectedId = it.id },
            modifier = modifier
        )
    } else {
        val initialIndex = coerceGalleryIndex(items.indexOfFirst { it.id == selectedId }, items.size)
        BackHandler { if (detailOnly) onClose() else selectedId = null }
        CaptureGalleryDetail(
            items = items,
            initialIndex = initialIndex,
            onClose = { if (detailOnly) onClose() else selectedId = null },
            onDelete = { item ->
                if (item.canDelete) pendingDelete = item
                else deleteNotice = "这张照片仍在处理，完成后才能删除。"
            },
            modifier = modifier
        )
    }

    pendingDelete?.let { item ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("删除这张照片？") },
            text = { Text("会删除本机照片和对应历史记录；已经保存在其他设备上的内容不会被删除。") },
            confirmButton = {
                TextButton(
                    modifier = Modifier.testTag("confirm-gallery-delete"),
                    onClick = {
                    onDelete(item)
                    pendingDelete = null
                    if (detailOnly) onClose() else selectedId = null
                }) { Text("删除") }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text("取消") }
            }
        )
    }
    deleteNotice?.let { notice ->
        AlertDialog(
            onDismissRequest = { deleteNotice = null },
            title = { Text("暂时无法删除") },
            text = { Text(notice) },
            confirmButton = {
                TextButton(onClick = { deleteNotice = null }) { Text("知道了") }
            }
        )
    }
}

@Composable
private fun CaptureGalleryGrid(
    items: List<CaptureGalleryItem>,
    onClose: () -> Unit,
    onOpen: (CaptureGalleryItem) -> Unit,
    modifier: Modifier = Modifier
) {
    Column(
        modifier
            .fillMaxSize()
            .background(MathNotesColors.Background)
            .statusBarsPadding()
            .navigationBarsPadding()
            .padding(horizontal = 14.dp, vertical = 12.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("最近拍摄", style = MaterialTheme.typography.headlineSmall, color = MathNotesColors.Ink)
                Text("${items.size} 张照片", style = MaterialTheme.typography.bodySmall, color = MathNotesColors.Muted)
            }
            GalleryAction("关闭", onClose)
        }
        Spacer(Modifier.size(14.dp))
        LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 72.dp),
            modifier = Modifier.fillMaxWidth().weight(1f),
            horizontalArrangement = Arrangement.spacedBy(5.dp),
            verticalArrangement = Arrangement.spacedBy(5.dp)
        ) {
            items(items, key = { it.id }) { item ->
                val bitmap = rememberCameraThumbnail(item.path, maximumEdge = 384)
                Box(
                    Modifier
                        .aspectRatio(1f)
                        .clip(RoundedCornerShape(7.dp))
                        .background(MathNotesColors.AccentSoft)
                        .semantics { contentDescription = "打开${item.label}" }
                        .clickable { onOpen(item) }
                ) {
                    if (bitmap != null) {
                        Image(
                            bitmap = bitmap.asImageBitmap(),
                            contentDescription = null,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.fillMaxSize()
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun CaptureGalleryDetail(
    items: List<CaptureGalleryItem>,
    initialIndex: Int,
    onClose: () -> Unit,
    onDelete: (CaptureGalleryItem) -> Unit,
    modifier: Modifier = Modifier
) {
    val pagerState = rememberPagerState(initialPage = initialIndex, pageCount = { items.size })
    val currentItem = items.getOrNull(pagerState.currentPage)
    Box(modifier.fillMaxSize().background(Color(0xF2171816))) {
        HorizontalPager(state = pagerState, modifier = Modifier.fillMaxSize()) { page ->
            val item = items[page]
            val bitmap = rememberCameraThumbnail(item.path, maximumEdge = 2_048)
            if (bitmap != null) {
                Image(
                    bitmap = bitmap.asImageBitmap(),
                    contentDescription = "${item.label} ${page + 1} / ${items.size}",
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp, vertical = 76.dp)
                )
            } else {
                Text("这张照片暂时无法预览", color = Color.White, modifier = Modifier.align(Alignment.Center))
            }
        }
        Row(
            modifier = Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            GalleryAction("删除", { currentItem?.let(onDelete) }, destructive = true, testTag = "gallery-delete")
            GalleryAction("关闭", onClose)
        }
        Text(
            "${pagerState.currentPage + 1} / ${items.size} · 左右滑动",
            color = Color.White,
            modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 30.dp)
        )
    }
}

@Composable
private fun GalleryAction(
    text: String,
    onClick: () -> Unit,
    destructive: Boolean = false,
    testTag: String? = null
) {
    Surface(
        modifier = Modifier
            .then(if (testTag == null) Modifier else Modifier.testTag(testTag))
            .clip(RoundedCornerShape(14.dp))
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(14.dp),
        color = if (destructive) Color(0xE6FFF1EE) else Color(0xE6FFFEFD),
        border = BorderStroke(1.dp, if (destructive) MathNotesColors.Error.copy(alpha = 0.35f) else MathNotesColors.Line)
    ) {
        Text(
            text,
            color = if (destructive) MathNotesColors.Error else MathNotesColors.Ink,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)
        )
    }
}

internal fun coerceGalleryIndex(index: Int, count: Int): Int =
    if (count <= 0) 0 else index.coerceIn(0, count - 1)

@Composable
internal fun rememberCameraThumbnail(path: String, maximumEdge: Int = 256): android.graphics.Bitmap? {
    val bitmap by produceState<android.graphics.Bitmap?>(initialValue = null, path, maximumEdge) {
        value = withContext(Dispatchers.IO) { loadCameraThumbnail(path, maximumEdge) }
    }
    return bitmap
}

internal fun loadCameraThumbnail(path: String, maximumEdge: Int = 256): android.graphics.Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sampleSize = 1
    while (bounds.outWidth / sampleSize > maximumEdge * 2 || bounds.outHeight / sampleSize > maximumEdge * 2) {
        sampleSize *= 2
    }
    return BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sampleSize })
}
