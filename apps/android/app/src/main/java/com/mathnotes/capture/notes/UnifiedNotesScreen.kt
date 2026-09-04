package com.mathnotes.capture.notes

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.mathnotes.capture.R
import com.mathnotes.capture.companion.CompanionNotesScreen
import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.pairing.PairingTarget
import com.mathnotes.capture.standalone.StandaloneScreen
import com.mathnotes.capture.standalone.StandaloneSessionEntity
import com.mathnotes.capture.standalone.StandaloneViewModel
import com.mathnotes.capture.ui.MathNotesColors
import com.mathnotes.capture.ui.MathNotesThemeId

internal enum class NotesSource(
    val label: String,
    val detail: String,
    val icon: Int
) {
    LOCAL("本机", "保存在这台手机", R.drawable.ic_mathnotes_folder),
    COMPUTER("电脑", "来自已连接电脑", R.drawable.ic_mathnotes_notes)
}

@Composable
fun UnifiedNotesScreen(
    standaloneViewModel: StandaloneViewModel,
    pairing: PairingConfig?,
    targets: List<PairingTarget>,
    themeId: MathNotesThemeId = MathNotesThemeId.DEFAULT_LIGHT,
    openLocalRequest: Int = 0,
    endpointCandidates: List<PairingConfig> = emptyList(),
    onPairingVerified: (PairingConfig, List<PairingTarget>) -> Unit = { _, _ -> },
    selectCaptureTarget: Boolean = false,
    onCaptureTargetSelected: (StandaloneSessionEntity) -> Unit = {},
    onCancelCaptureTargetSelection: () -> Unit = {}
) {
    var source by rememberSaveable { mutableStateOf(NotesSource.LOCAL) }
    var searchOpen by rememberSaveable { mutableStateOf(false) }
    var searchQuery by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(openLocalRequest, selectCaptureTarget) {
        if (openLocalRequest > 0 || selectCaptureTarget) source = NotesSource.LOCAL
    }

    val libraryHeader: @Composable () -> Unit = {
        NotesLibraryHeader(
            selectedSource = source,
            searching = searchQuery.isNotBlank(),
            selectionMode = selectCaptureTarget,
            onSelect = { if (!selectCaptureTarget) source = it },
            onSearch = { if (!selectCaptureTarget) searchOpen = true },
            onCancelSelection = onCancelCaptureTargetSelection
        )
    }

    when (source) {
        NotesSource.LOCAL -> StandaloneScreen(
            viewModel = standaloneViewModel,
            themeId = themeId,
            libraryHeader = libraryHeader,
            libraryQuery = searchQuery,
            onSelectSessionForCapture = onCaptureTargetSelected.takeIf { selectCaptureTarget },
            onCancelCaptureSelection = onCancelCaptureTargetSelection.takeIf { selectCaptureTarget }
        )
        NotesSource.COMPUTER -> CompanionNotesScreen(
            pairing = pairing,
            targets = targets,
            themeId = themeId,
            endpointCandidates = endpointCandidates,
            onPairingVerified = onPairingVerified,
            libraryHeader = libraryHeader,
            libraryQuery = searchQuery
        )
    }

    if (searchOpen) {
        var draft by remember(searchOpen) { mutableStateOf(searchQuery) }
        AlertDialog(
            onDismissRequest = { searchOpen = false },
            title = { Text("搜索笔记") },
            text = {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    placeholder = { Text("Notebook 或 Session 名称") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    searchQuery = draft.trim()
                    searchOpen = false
                }) { Text("应用") }
            },
            dismissButton = {
                TextButton(onClick = {
                    searchQuery = ""
                    searchOpen = false
                }) { Text("清除") }
            }
        )
    }
}

@Composable
private fun NotesLibraryHeader(
    selectedSource: NotesSource,
    searching: Boolean,
    selectionMode: Boolean,
    onSelect: (NotesSource) -> Unit,
    onSearch: () -> Unit,
    onCancelSelection: () -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth().height(44.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            if (selectionMode) "选择拍摄目标" else "我的笔记",
            style = MaterialTheme.typography.headlineLarge,
            color = MathNotesColors.Ink,
            fontFamily = FontFamily.Serif
        )
        Spacer(Modifier.weight(1f))
        if (selectionMode) {
            TextButton(onClick = onCancelSelection) { Text("取消") }
            return@Row
        }
        Surface(
            modifier = Modifier.width(132.dp).height(38.dp),
            shape = RoundedCornerShape(19.dp),
            color = MathNotesColors.Subtle,
            border = androidx.compose.foundation.BorderStroke(1.dp, MathNotesColors.Line),
            tonalElevation = 0.dp,
            shadowElevation = 0.dp
        ) {
            Row(Modifier.padding(3.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                NotesSource.entries.forEach { source ->
                    NotesSourceSegment(
                        source = source,
                        selected = source == selectedSource,
                        modifier = Modifier.weight(1f),
                        onClick = { onSelect(source) }
                    )
                }
            }
        }
        IconButton(onClick = onSearch, modifier = Modifier.size(40.dp)) {
            Icon(
                painter = painterResource(android.R.drawable.ic_menu_search),
                contentDescription = "搜索笔记",
                tint = if (searching) MathNotesColors.Accent else MathNotesColors.Ink,
                modifier = Modifier.size(23.dp)
            )
        }
    }
}

@Composable
private fun NotesSourceSegment(
    source: NotesSource,
    selected: Boolean,
    modifier: Modifier,
    onClick: () -> Unit
) {
    Surface(
        modifier = modifier
            .fillMaxSize()
            .semantics { this.selected = selected }
            .clip(RoundedCornerShape(11.dp))
            .clickable(role = Role.Tab, onClick = onClick),
        shape = RoundedCornerShape(11.dp),
        color = if (selected) MathNotesColors.Paper else androidx.compose.ui.graphics.Color.Transparent,
        tonalElevation = 0.dp,
        shadowElevation = 0.dp
    ) {
        Row(
            modifier = Modifier.fillMaxSize(),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                source.label,
                style = MaterialTheme.typography.labelLarge,
                color = if (selected) MathNotesColors.Accent else MathNotesColors.Muted,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium
            )
        }
    }
}
