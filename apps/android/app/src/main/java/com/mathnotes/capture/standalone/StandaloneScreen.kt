package com.mathnotes.capture.standalone

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.mathnotes.capture.ui.MathNotesColors
import com.mathnotes.capture.ui.MathNotesPageHeader
import com.mathnotes.capture.ui.MathNotesPaper
import com.mathnotes.capture.ui.MathNotesPrimaryButton
import com.mathnotes.capture.ui.MathNotesSecondaryButton

@Composable
fun StandaloneScreen(viewModel: StandaloneViewModel = viewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val providerProfile by viewModel.providerProfile.collectAsStateWithLifecycle()
    var message by remember { mutableStateOf<String?>(null) }
    var endpoint by remember { mutableStateOf(providerProfile?.destination.orEmpty()) }
    var model by remember { mutableStateOf(providerProfile?.model.orEmpty()) }
    var apiKey by remember { mutableStateOf("") }
    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) viewModel.importImage(uri) { result ->
            message = result.fold(
                onSuccess = { "图片已存入手机独立工作区；确认后才会开始识别。" },
                onFailure = { "导入失败：${it.message ?: "请重试"}" }
            )
        }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(start = 22.dp, top = 28.dp, end = 22.dp, bottom = 112.dp)
    ) {
        MathNotesPageHeader(
            eyebrow = "手机独立",
            title = "不连接电脑也能工作",
            detail = "这里是独立本地正本，与“连接电脑”的伴侣缓存完全隔离，不会自动合并。"
        )
        Spacer(Modifier.height(18.dp))
        MathNotesPaper(Modifier.fillMaxWidth()) {
            Text("当前模式", style = MaterialTheme.typography.labelMedium, color = MathNotesColors.Muted)
            Spacer(Modifier.height(6.dp))
            Text("手机独立 · 本地工作区", fontWeight = FontWeight.SemiBold, color = MathNotesColors.Ink)
            Text(
                if (providerProfile?.enabled == true) "真实 Provider · 每次识别都需再次确认" else "本地假 Provider · 付费调用次数为 0",
                style = MaterialTheme.typography.bodySmall,
                color = MathNotesColors.Muted
            )
        }
        Spacer(Modifier.height(14.dp))
        MathNotesPaper(Modifier.fillMaxWidth()) {
            Text("独立识别 Provider", fontWeight = FontWeight.SemiBold, color = MathNotesColors.Ink)
            Text("Key 由 Android Keystore 加密，不进入笔记数据库、日志或导出。", style = MaterialTheme.typography.bodySmall, color = MathNotesColors.Muted)
            Spacer(Modifier.height(9.dp))
            OutlinedTextField(
                value = endpoint,
                onValueChange = { endpoint = it },
                label = { Text("OpenAI-compatible Endpoint") },
                placeholder = { Text("https://example.com/v1") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(Modifier.height(7.dp))
            OutlinedTextField(
                value = model,
                onValueChange = { model = it },
                label = { Text("模型") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(Modifier.height(7.dp))
            OutlinedTextField(
                value = apiKey,
                onValueChange = { apiKey = it },
                label = { Text(if (providerProfile?.hasSecret == true) "重新输入 API Key（当前已安全保存）" else "API Key") },
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(Modifier.height(9.dp))
            MathNotesPrimaryButton(
                text = "保存并用于新任务",
                onClick = {
                    viewModel.saveProviderProfile(endpoint, model, apiKey) { result ->
                        message = result.fold(
                            onSuccess = { apiKey = ""; "Provider 已安全保存；之后导入的图片将使用真实识别" },
                            onFailure = { "Provider 保存失败：${it.message ?: "请检查输入"}" }
                        )
                    }
                },
                modifier = Modifier.fillMaxWidth()
            )
            if (providerProfile != null) {
                Spacer(Modifier.height(7.dp))
                MathNotesSecondaryButton(
                    text = "改用本地假 Provider",
                    onClick = { viewModel.useFakeProvider(); message = "之后导入的图片将使用本地假识别" },
                    selected = providerProfile?.enabled == false,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        }
        Spacer(Modifier.height(14.dp))
        if (state.activeSession == null) {
            MathNotesPrimaryButton(
                text = "新建独立 Session",
                onClick = { viewModel.createSession { message = it.exceptionOrNull()?.message ?: "已新建独立 Session" } },
                modifier = Modifier.fillMaxWidth()
            )
        } else {
            MathNotesPaper(Modifier.fillMaxWidth()) {
                Text(state.activeSession!!.title, fontWeight = FontWeight.SemiBold, color = MathNotesColors.Ink)
                Text("${state.blocks.count { it.kind == StandaloneBlockKind.IMAGE }} 张图片 · ${state.blocks.count { it.kind == StandaloneBlockKind.MARKDOWN_DRAFT }} 份草稿", style = MaterialTheme.typography.bodySmall, color = MathNotesColors.Muted)
            }
            Spacer(Modifier.height(10.dp))
            MathNotesSecondaryButton(
                text = "从相册加入图片",
                onClick = { imagePicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                modifier = Modifier.fillMaxWidth()
            )
        }
        state.tasks.forEach { task ->
            Spacer(Modifier.height(12.dp))
            MathNotesPaper(Modifier.fillMaxWidth()) {
                Text("识别任务", style = MaterialTheme.typography.labelMedium, color = MathNotesColors.Muted)
                Text(taskStatusLabel(task.status), fontWeight = FontWeight.SemiBold, color = MathNotesColors.Ink)
                Text("${task.providerId} · ${task.model}", style = MaterialTheme.typography.bodySmall, color = MathNotesColors.Muted)
                if (task.status == StandaloneTaskStatus.AWAITING_CONFIRMATION) {
                    Spacer(Modifier.height(9.dp))
                    MathNotesPrimaryButton(
                        text = if (task.providerId == "local-fake") "确认开始一次本地识别" else "确认一次可能付费的识别",
                        onClick = {
                            viewModel.confirmRecognition(task)
                            message = "已确认一次识别任务"
                        },
                        modifier = Modifier.fillMaxWidth()
                    )
                }
                task.lastError?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MathNotesColors.Muted) }
            }
        }
        state.blocks.filter { it.kind == StandaloneBlockKind.MARKDOWN_DRAFT }.forEach { block ->
            Spacer(Modifier.height(12.dp))
            MathNotesPaper(Modifier.fillMaxWidth()) {
                Text("Markdown 草稿", style = MaterialTheme.typography.labelMedium, color = MathNotesColors.Muted)
                Spacer(Modifier.height(6.dp))
                Text(block.markdown, color = MathNotesColors.Ink)
            }
        }
        message?.let {
            Spacer(Modifier.height(12.dp))
            Text(it, style = MaterialTheme.typography.bodySmall, color = MathNotesColors.Muted)
        }
    }
}

internal fun taskStatusLabel(status: String): String = when (status) {
    StandaloneTaskStatus.AWAITING_CONFIRMATION -> "等待你确认"
    StandaloneTaskStatus.CLAIMED -> "识别中（已一次性认领）"
    StandaloneTaskStatus.SUCCEEDED -> "草稿已生成"
    StandaloneTaskStatus.POSSIBLY_CHARGED -> "结果未知，可能已经计费"
    StandaloneTaskStatus.CANCELLED -> "已取消"
    else -> "失败，请查看原因"
}
