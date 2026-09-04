package com.mathnotes.capture.standalone

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.mathnotes.capture.ui.MathNotesColors
import com.mathnotes.capture.ui.MathNotesPaper
import com.mathnotes.capture.ui.MathNotesPrimaryButton

@Composable
internal fun StandaloneProviderSettingsSection(
    profile: StandaloneProviderProfile?,
    onSave: (
        providerId: String,
        baseUrl: String,
        model: String,
        apiKey: String,
        onComplete: (Result<Unit>) -> Unit
    ) -> Unit
) {
    val initialProviderId = profile?.providerId
        ?.takeIf { StandaloneProviderCatalog.descriptor(it) != null }
        ?: StandaloneProviderCatalog.recognitionProviders.first().providerId
    var providerId by remember { mutableStateOf(initialProviderId) }
    var model by remember { mutableStateOf(profile?.model.orEmpty()) }
    var endpoint by remember { mutableStateOf(profile?.destination.orEmpty()) }
    var apiKey by remember { mutableStateOf("") }
    var menuOpen by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(profile) {
        val nextId = profile?.providerId?.takeIf { StandaloneProviderCatalog.descriptor(it) != null }
            ?: StandaloneProviderCatalog.recognitionProviders.first().providerId
        providerId = nextId
        model = profile?.model ?: StandaloneProviderCatalog.requireDescriptor(nextId).defaultModel
        endpoint = profile?.destination.orEmpty()
        apiKey = ""
    }

    val descriptor = StandaloneProviderCatalog.requireDescriptor(providerId)
    MathNotesPaper(Modifier.fillMaxWidth()) {
        Text("本机识别模型", style = MaterialTheme.typography.titleMedium, color = MathNotesColors.Ink)
        Spacer(Modifier.height(5.dp))
        Text(
            "未连接电脑或关闭 Windows 识别时使用。API Key 只以本机 Keystore 保护的密文保存。",
            color = MathNotesColors.Muted,
            style = MaterialTheme.typography.bodySmall
        )
        Spacer(Modifier.height(12.dp))
        Box {
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(MathNotesColors.AccentSoft, RoundedCornerShape(10.dp))
                    .clip(RoundedCornerShape(10.dp))
                    .clickable { menuOpen = true }
                    .padding(horizontal = 12.dp, vertical = 10.dp)
            ) {
                Text(
                    "识别服务",
                    color = MathNotesColors.Muted,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.fillMaxWidth()
                )
                Text(
                    descriptor.label,
                    color = MathNotesColors.Ink,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.fillMaxWidth()
                )
            }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                StandaloneProviderCatalog.recognitionProviders.forEach { option ->
                    DropdownMenuItem(
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp).clip(RoundedCornerShape(12.dp)),
                        text = { Text(option.label) },
                        onClick = {
                            providerId = option.providerId
                            model = option.defaultModel
                            endpoint = option.defaultBaseUrl
                            apiKey = ""
                            message = null
                            menuOpen = false
                        }
                    )
                }
            }
        }
        Spacer(Modifier.height(9.dp))
        OutlinedTextField(
            value = model,
            onValueChange = { model = it },
            label = { Text("模型 ID") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        if (descriptor.customEndpoint) {
            Spacer(Modifier.height(7.dp))
            OutlinedTextField(
                value = endpoint,
                onValueChange = { endpoint = it },
                label = { Text("HTTPS 请求地址") },
                supportingText = { Text("可填写服务根地址或完整 chat/completions 地址") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
        }
        Spacer(Modifier.height(7.dp))
        val sameSecretBinding = profile?.hasSecret == true &&
            profile.providerId == providerId &&
            profile.model == model.trim() &&
            (!descriptor.customEndpoint || profile.destination.trimEnd('/') == endpoint.trim().trimEnd('/'))
        OutlinedTextField(
            value = apiKey,
            onValueChange = { apiKey = it },
            label = { Text(if (sameSecretBinding) "API Key（已保存，留空不变）" else "API Key") },
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(Modifier.height(10.dp))
        MathNotesPrimaryButton(
            text = if (saving) "正在保存…" else "保存本机识别设置",
            onClick = {
                saving = true
                message = null
                onSave(providerId, endpoint, model, apiKey) { result ->
                    saving = false
                    message = result.fold(
                        onSuccess = { apiKey = ""; "已保存；新的本机识别任务会使用此模型。" },
                        onFailure = { "保存失败：${it.message ?: "请检查设置"}" }
                    )
                }
            },
            enabled = !saving,
            modifier = Modifier.fillMaxWidth()
        )
        message?.let {
            Spacer(Modifier.height(8.dp))
            Text(it, color = if (it.startsWith("已保存")) MathNotesColors.Accent else MathNotesColors.Error, style = MaterialTheme.typography.bodySmall)
        }
    }
}
