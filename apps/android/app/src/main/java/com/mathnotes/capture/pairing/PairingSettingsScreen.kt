package com.mathnotes.capture.pairing

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.mathnotes.capture.BuildConfig
import com.mathnotes.capture.R
import com.mathnotes.capture.companion.CompanionDatabase
import com.mathnotes.capture.companion.CompanionMarkdownMirror
import com.mathnotes.capture.notification.NotificationPermissionAction
import com.mathnotes.capture.notification.NotificationPermissionState
import com.mathnotes.capture.ui.MathNotesColors
import com.mathnotes.capture.ui.MathNotesPageHeader
import com.mathnotes.capture.ui.MathNotesPaper
import com.mathnotes.capture.ui.MathNotesPrimaryButton
import com.mathnotes.capture.ui.MathNotesSecondaryButton
import com.mathnotes.capture.ui.MathNotesStatusDot
import com.mathnotes.capture.ui.MathNotesThemeId
import kotlinx.coroutines.launch

@Composable
fun PairingSettingsScreen(
    pairedConfig: PairingConfig?,
    profiles: List<PairingConfig>,
    busy: Boolean,
    statusMessage: String?,
    onScan: () -> Unit,
    onPair: (PairingParseResult) -> Unit,
    onCheck: () -> Unit,
    onActivate: (String) -> Unit,
    onRemove: (String) -> Unit,
    notificationPermission: NotificationPermissionState,
    onNotificationAction: () -> Unit,
    themeId: MathNotesThemeId = MathNotesThemeId.DEFAULT_LIGHT,
    onThemeChange: (MathNotesThemeId) -> Unit = {}
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val markdownMirror = remember(context) { CompanionMarkdownMirror(context.applicationContext) }
    var manualOpen by remember { mutableStateOf(false) }
    var pendingRemoval by remember { mutableStateOf<PairingConfig?>(null) }
    var endpoint by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    var exportMessage by remember { mutableStateOf<String?>(null) }
    val folderLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri != null) {
            runCatching { markdownMirror.selectTree(uri) }
                .onSuccess { exportMessage = "已选择本地笔记目录。" }
                .onFailure { exportMessage = "无法使用所选目录：${it.message ?: "请重试"}" }
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(start = 22.dp, top = 28.dp, end = 22.dp, bottom = 112.dp)
    ) {
        MathNotesPageHeader(
            eyebrow = "连接与传输",
            title = "连接电脑",
            detail = "默认优先使用 Tailscale；不可用时可回退到电脑热点、USB 或可信局域网。同一手机上若已有 VPN，可改用 HTTPS 隧道。版本 ${BuildConfig.VERSION_NAME}"
        )
        Spacer(Modifier.height(22.dp))

        if (pairedConfig != null) {
            MathNotesPaper(Modifier.fillMaxWidth()) {
                Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                    MathNotesStatusDot(MathNotesColors.Success)
                    Text("已配对", color = MathNotesColors.Accent, style = MaterialTheme.typography.labelLarge)
                }
                Spacer(Modifier.height(9.dp))
                Text(pairedConfig.redactedSummary(), style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(14.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                    MathNotesPrimaryButton("检查连接", onCheck, Modifier.weight(1f), enabled = !busy)
                    MathNotesSecondaryButton(
                        "移除此电脑",
                        { pendingRemoval = pairedConfig },
                        Modifier.weight(1f),
                        enabled = !busy
                    )
                }
            }
        }

        if (profiles.size > 1) {
            Spacer(Modifier.height(16.dp))
            Text("配对历史", style = MaterialTheme.typography.titleMedium, color = MathNotesColors.Ink)
            Spacer(Modifier.height(8.dp))
            profiles.filterNot { it.profileId == pairedConfig?.profileId }.forEach { profile ->
                MathNotesPaper(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                    Text(profile.computerLabel.ifBlank { "${profile.host}:${profile.port}" }, style = MaterialTheme.typography.titleMedium)
                    Text(profile.redactedSummary(), color = MathNotesColors.Muted, style = MaterialTheme.typography.bodySmall)
                    Row(
                        modifier = Modifier.padding(top = 10.dp),
                        horizontalArrangement = Arrangement.spacedBy(9.dp)
                    ) {
                        MathNotesSecondaryButton("切换", { onActivate(profile.profileId) }, Modifier.weight(1f), enabled = !busy)
                        MathNotesSecondaryButton("移除", { pendingRemoval = profile }, Modifier.weight(1f), enabled = !busy)
                    }
                }
            }
        }

        Spacer(Modifier.height(16.dp))
        Text("添加电脑", style = MaterialTheme.typography.titleMedium, color = MathNotesColors.Ink)
        Spacer(Modifier.height(8.dp))
        MathNotesPrimaryButton(
            text = "扫描新电脑",
            onClick = onScan,
            enabled = !busy,
            icon = R.drawable.ic_mathnotes_qr,
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(Modifier.height(9.dp))
        MathNotesSecondaryButton(
            text = if (manualOpen) "收起手动配对" else "手动添加电脑",
            onClick = { manualOpen = !manualOpen },
            enabled = !busy,
            modifier = Modifier.fillMaxWidth()
        )

        statusMessage?.let {
            Spacer(Modifier.height(13.dp))
            Text(
                it,
                color = if (it == "已连接到电脑") MathNotesColors.Accent else MathNotesColors.Warning,
                style = MaterialTheme.typography.bodySmall
            )
        }

        Spacer(Modifier.height(18.dp))
        MathNotesPaper(Modifier.fillMaxWidth()) {
            Text("上传通知", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(7.dp))
            Text(notificationPermission.title, color = MathNotesColors.Accent, style = MaterialTheme.typography.labelMedium)
            Spacer(Modifier.height(3.dp))
            Text(notificationPermission.detail, color = MathNotesColors.Muted, style = MaterialTheme.typography.bodySmall)
            if (notificationPermission.action != NotificationPermissionAction.NONE) {
                MathNotesSecondaryButton(
                    text = notificationPermission.actionLabel.orEmpty(),
                    onClick = onNotificationAction,
                    enabled = !busy,
                    modifier = Modifier.padding(top = 10.dp)
                )
            }
        }

        Spacer(Modifier.height(16.dp))
        MathNotesPaper(Modifier.fillMaxWidth()) {
            Text("本地笔记", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(7.dp))
            Text(
                if (markdownMirror.treeUri == null) {
                    "可将电脑同步来的笔记另存为本地 Markdown；未选择目录也不影响离线阅读。"
                } else {
                    "同步成功后会自动更新所选目录中的 Markdown。"
                },
                color = MathNotesColors.Muted,
                style = MaterialTheme.typography.bodySmall
            )
            Spacer(Modifier.height(10.dp))
            MathNotesSecondaryButton(
                text = if (markdownMirror.treeUri == null) "选择保存文件夹" else "更改保存文件夹",
                onClick = { folderLauncher.launch(markdownMirror.treeUri) },
                modifier = Modifier.fillMaxWidth()
            )
            if (markdownMirror.treeUri != null && pairedConfig != null) {
                Spacer(Modifier.height(9.dp))
                MathNotesSecondaryButton(
                    text = "立即导出全部笔记",
                    onClick = {
                        scope.launch {
                            val profileId = pairedConfig.profileId.ifBlank { pairedConfig.endpointId }
                            val sessions = CompanionDatabase.get(context.applicationContext)
                                .sessionDao()
                                .listForProfile(profileId)
                            val exported = sessions.count { session ->
                                runCatching { markdownMirror.writeEntity(session) }.getOrNull() != null
                            }
                            exportMessage = "已导出 $exported 篇本地 Markdown。"
                        }
                    },
                    modifier = Modifier.fillMaxWidth()
                )
            }
            exportMessage?.let {
                Spacer(Modifier.height(7.dp))
                Text(it, color = MathNotesColors.Accent, style = MaterialTheme.typography.bodySmall)
            }
        }

        Spacer(Modifier.height(16.dp))
        MathNotesPaper(Modifier.fillMaxWidth()) {
            Text("界面主题", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(7.dp))
            Text("与电脑端使用同一组稳定主题标识；切换只影响本机显示。", color = MathNotesColors.Muted, style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(10.dp))
            MathNotesThemeId.entries.chunked(2).forEach { rowThemes ->
                Row(
                    modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(9.dp)
                ) {
                    rowThemes.forEach { option ->
                        if (option == themeId) {
                            MathNotesPrimaryButton(option.label, { onThemeChange(option) }, Modifier.weight(1f))
                        } else {
                            MathNotesSecondaryButton(option.label, { onThemeChange(option) }, Modifier.weight(1f))
                        }
                    }
                }
            }
        }

        if (manualOpen) {
            Spacer(Modifier.height(18.dp))
            MathNotesPaper(Modifier.fillMaxWidth()) {
                Text("手动输入", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(7.dp))
                Text("填写电脑端配对页中的地址和令牌；支持局域网、Tailscale 地址或 HTTPS 隧道。连接后再选择笔记。", color = MathNotesColors.Muted, style = MaterialTheme.typography.bodySmall)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = endpoint,
                    onValueChange = { endpoint = it },
                    label = { Text("电脑地址") },
                    placeholder = { Text("例如 http://100.x.y.z:4095") },
                    supportingText = { Text("优先填写 Tailscale 地址，也支持局域网或 HTTPS 隧道") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true
                )
                OutlinedTextField(
                    value = token,
                    onValueChange = { token = it },
                    label = { Text("配对令牌") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation()
                )
                Spacer(Modifier.height(12.dp))
                MathNotesPrimaryButton(
                    text = if (busy) "正在验证…" else "验证并保存",
                    onClick = { onPair(PairingConfig.fromManual(endpoint, token)) },
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        }
    }

    pendingRemoval?.let { profile ->
        AlertDialog(
            onDismissRequest = { pendingRemoval = null },
            title = { Text("移除这台电脑？") },
            text = { Text("上传历史会保留；之后仍可重新扫描配对。") },
            confirmButton = {
                TextButton(onClick = {
                    onRemove(profile.profileId)
                    pendingRemoval = null
                }) { Text("移除") }
            },
            dismissButton = {
                TextButton(onClick = { pendingRemoval = null }) { Text("取消") }
            }
        )
    }
}
