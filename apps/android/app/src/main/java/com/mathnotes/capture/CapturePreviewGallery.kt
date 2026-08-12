package com.mathnotes.capture

import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.dp
import com.mathnotes.capture.ui.MathNotesColors

@Composable
internal fun CapturePreviewGallery(
    paths: List<String>,
    onClose: () -> Unit,
    modifier: Modifier = Modifier
) {
    BackHandler(onBack = onClose)
    val pagerState = rememberPagerState(
        initialPage = coerceGalleryIndex(0, paths.size),
        pageCount = { paths.size }
    )
    Box(modifier.fillMaxSize().background(Color(0xF2171816))) {
        HorizontalPager(
            state = pagerState,
            modifier = Modifier.fillMaxSize()
        ) { page ->
            val path = paths[page]
            val bitmap = remember(path) { loadCameraThumbnail(path, maximumEdge = 2_048) }
            if (bitmap != null) {
                Image(
                    bitmap = bitmap.asImageBitmap(),
                    contentDescription = "最近拍摄 ${page + 1} / ${paths.size}",
                    modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp, vertical = 76.dp)
                )
            } else {
                Text("这张照片暂时无法预览", color = Color.White, modifier = Modifier.align(Alignment.Center))
            }
        }
        Surface(
            modifier = Modifier
                .align(Alignment.TopStart)
                .statusBarsPadding()
                .padding(20.dp)
                .clickable(onClick = onClose),
            shape = RoundedCornerShape(14.dp),
            color = Color(0xE6FFFEFD),
            border = BorderStroke(1.dp, MathNotesColors.Line)
        ) {
            Text("关闭", color = MathNotesColors.Ink, modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp))
        }
        Text(
            "${pagerState.currentPage + 1} / ${paths.size} · 左右滑动",
            color = Color.White,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .padding(bottom = 30.dp)
        )
    }
}

internal fun coerceGalleryIndex(index: Int, count: Int): Int =
    if (count <= 0) 0 else index.coerceIn(0, count - 1)

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
