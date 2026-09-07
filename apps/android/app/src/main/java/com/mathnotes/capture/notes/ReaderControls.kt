package com.mathnotes.capture.notes

import android.content.Context
import android.view.ActionMode
import android.view.GestureDetector
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.webkit.WebView
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.ui.MathNotesColors

data class NoteReadingRequest(
    val requestId: String,
    val sessionId: String,
    val blockId: String,
    val notebookId: String = "",
    val imageLink: String? = null,
    val pairing: PairingConfig? = null,
    val targetAnchor: String? = null
)

internal data class ReaderHeading(val anchor: String, val label: String, val level: Int)

/** Native chrome is outside the scrolling document and remains reachable after a deep link. */
@Composable
internal fun ReaderOutlineBar(headings: List<ReaderHeading>, onNavigate: (ReaderHeading) -> Unit) {
    var expanded by remember(headings) { mutableStateOf(false) }
    val screen = LocalConfiguration.current
    val menuWidth = minOf(320, (screen.screenWidthDp - 24).coerceAtLeast(160)).dp
    val menuHeight = minOf(360, (screen.screenHeightDp / 2).coerceAtLeast(120)).dp
    val scroll = rememberScrollState()
    Box(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
        OutlinedButton(
            onClick = { expanded = !expanded },
            modifier = Modifier.testTag("reader-outline-button"),
            shape = RoundedCornerShape(14.dp),
            border = BorderStroke(1.dp, MathNotesColors.Line),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)
        ) {
            Text("目录", color = MathNotesColors.Accent)
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
            modifier = Modifier.width(menuWidth).heightIn(max = menuHeight).testTag("reader-outline-popup"),
            scrollState = scroll,
            shape = RoundedCornerShape(18.dp),
            containerColor = MathNotesColors.Paper,
            tonalElevation = 0.dp,
            shadowElevation = 8.dp
        ) {
            if (headings.isEmpty()) Text("这份笔记暂无标题目录", Modifier.padding(16.dp), color = MathNotesColors.Muted)
            val minLevel = headings.minOfOrNull { it.level } ?: 1
            headings.forEach { heading ->
                DropdownMenuItem(
                    text = { Text(heading.label, color = MathNotesColors.Ink) },
                    onClick = { expanded = false; onNavigate(heading) },
                    contentPadding = PaddingValues(start = (16 + (heading.level - minLevel).coerceIn(0, 5) * 14).dp, end = 16.dp)
                )
            }
        }
    }
}

/** Observe confirmed single taps without consuming WebView scrolling, links, images or selection. */
internal class ReaderInteractionWebView(context: Context) : WebView(context) {
    var onReadingTap: () -> Unit = {}
    private var selectionActive = false
    internal val isTextSelectionActive: Boolean get() = selectionActive
    private var interactiveDown = false
    private val tapDetector = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(event: MotionEvent) = true
        override fun onSingleTapConfirmed(event: MotionEvent): Boolean {
            if (!selectionActive && !interactiveDown && hitTestResult.type == HitTestResult.UNKNOWN_TYPE) onReadingTap()
            return false
        }
    })

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val handled = super.onTouchEvent(event)
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            interactiveDown = selectionActive || hitTestResult.type != HitTestResult.UNKNOWN_TYPE
        }
        tapDetector.onTouchEvent(event)
        return handled
    }

    override fun startActionMode(callback: ActionMode.Callback, type: Int): ActionMode? =
        super.startActionMode(object : ActionMode.Callback {
            override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean =
                callback.onCreateActionMode(mode, menu).also { selectionActive = it }
            override fun onPrepareActionMode(mode: ActionMode, menu: Menu) = callback.onPrepareActionMode(mode, menu)
            override fun onActionItemClicked(mode: ActionMode, item: MenuItem) = callback.onActionItemClicked(mode, item)
            override fun onDestroyActionMode(mode: ActionMode) { selectionActive = false; callback.onDestroyActionMode(mode) }
        }, type)
}
