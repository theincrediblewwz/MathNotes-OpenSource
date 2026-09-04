package com.mathnotes.capture.standalone

import android.util.Base64
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

internal class KnownProviderFailure(message: String) : Exception(message)

internal val STANDALONE_FAITHFUL_TRANSCRIPTION_PROMPT = listOf(
    "你将看到数学板书/手写笔记/书页照片。请忠实转写为 Markdown。",
    "不要总结、润色、改写或补充证明；保持原始顺序。",
    "尽量保持原照片中的换行、分组、缩进、编号、箭头、公式和分栏/列表/推导布局。",
    "可见的段首缩进不要丢失；普通空格会被 Markdown 折叠时，在行首使用 `&emsp;` 表达每个两字宽缩进。",
    "图中出现无法用 Markdown 忠实表达的几何图、坐标轴、箭头关系或示意图时，在对应位置写成 `[图片：...]`，简要说明图形内容、标注和它表达的数学关系；不要编造原图没有的结论。",
    "原图中被边框、浅色背景或输入框圈出的内容，用引用块、列表缩进或代码块保留为独立分组。",
    "表单字段、按钮、标签和警告提示按视觉层级转成简洁的 Markdown。",
    "行内公式统一使用 `\$...\$`。独立公式、多行推导和居中公式统一使用 `\$\$...\$\$`。",
    "不要使用 `\\(...\\)` 或 `\\[...\\]` 作为最终输出的数学分隔符；这些只作为本软件内部兼容输入。",
    "命令、配置项、代码片段使用 Markdown inline code 或 fenced code block；不要把普通文字乱包进数学公式。",
    "看不清的地方标记为 \"[看不清]\"。不确定的符号标记为 \"[不确定：...]\"。",
    "不要生成完整 LaTeX 文档，不要添加 \"\\documentclass\"，不要输出解释性废话，只输出 Markdown 草稿内容。",
    "不要输出 Markdown 代码围栏包住整篇转写；只有原图中确实是代码、命令或配置片段时才使用代码围栏。"
).joinToString("\n")

internal class OpenAiCompatibleStandaloneTransport(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()
) {
    fun transcribe(task: StandaloneRecognitionTaskEntity, image: File, apiKey: String): String {
        require(image.isFile && image.length() > 0) { "识别图片不存在或为空" }
        val descriptor = StandaloneProviderCatalog.requireDescriptor(task.providerId)
        val dataUrl = "data:${imageMimeType(image)};base64," +
            Base64.encodeToString(image.readBytes(), Base64.NO_WRAP)
        val body = when (descriptor.adapter) {
            StandaloneProviderAdapter.RESPONSES -> responsesBody(task.model, dataUrl)
            StandaloneProviderAdapter.CHAT_COMPLETIONS -> chatCompletionsBody(task.model, dataUrl)
        }
        val requestBuilder = Request.Builder().url(task.destination)
        StandaloneProviderCatalog.requestHeaders(task.providerId, apiKey).forEach(requestBuilder::header)
        val request = requestBuilder.post(body.toRequestBody(JSON_MEDIA_TYPE)).build()
        client.newCall(request).execute().use { response ->
            val raw = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val remote = runCatching { JSONObject(raw).optJSONObject("error")?.optString("message") }.getOrNull()
                throw KnownProviderFailure("Provider HTTP ${response.code}: ${remote?.take(240) ?: "请求被拒绝"}")
            }
            val markdown = when (descriptor.adapter) {
                StandaloneProviderAdapter.RESPONSES -> extractResponsesText(raw)
                StandaloneProviderAdapter.CHAT_COMPLETIONS -> extractChatCompletionText(raw)
            }.trim()
            if (markdown.isBlank()) throw KnownProviderFailure("Provider 返回了空草稿")
            return markdown
        }
    }

    private fun responsesBody(model: String, dataUrl: String): String {
        val content = JSONArray()
            .put(JSONObject().put("type", "input_text").put("text", STANDALONE_FAITHFUL_TRANSCRIPTION_PROMPT))
            .put(JSONObject().put("type", "input_image").put("image_url", dataUrl))
        return JSONObject()
            .put("model", model)
            .put("stream", false)
            .put("input", JSONArray().put(JSONObject().put("role", "user").put("content", content)))
            .toString()
    }

    private fun chatCompletionsBody(model: String, dataUrl: String): String {
        val content = JSONArray()
            .put(JSONObject().put("type", "text").put("text", STANDALONE_FAITHFUL_TRANSCRIPTION_PROMPT))
            .put(JSONObject().put("type", "image_url").put("image_url", JSONObject().put("url", dataUrl)))
        return JSONObject()
            .put("model", model)
            .put("stream", false)
            .put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", content)))
            .toString()
    }

    private fun extractResponsesText(raw: String): String {
        val response = runCatching { JSONObject(raw) }
            .getOrElse { throw KnownProviderFailure("Provider 返回格式无法识别") }
        response.optString("output_text").takeIf(String::isNotBlank)?.let { return it }
        val output = response.optJSONArray("output") ?: throw KnownProviderFailure("Provider 返回格式无法识别")
        val pieces = buildList {
            for (outputIndex in 0 until output.length()) {
                val content = output.optJSONObject(outputIndex)?.optJSONArray("content") ?: continue
                for (contentIndex in 0 until content.length()) {
                    content.optJSONObject(contentIndex)?.optString("text")?.takeIf(String::isNotBlank)?.let(::add)
                }
            }
        }
        return pieces.joinToString("\n\n")
    }

    private fun extractChatCompletionText(raw: String): String {
        val contentValue = runCatching {
            JSONObject(raw).getJSONArray("choices").getJSONObject(0).getJSONObject("message").get("content")
        }.getOrElse { throw KnownProviderFailure("Provider 返回格式无法识别") }
        return when (contentValue) {
            is String -> contentValue
            is JSONArray -> buildString {
                for (index in 0 until contentValue.length()) {
                    append(contentValue.optJSONObject(index)?.optString("text").orEmpty())
                }
            }
            else -> ""
        }
    }

    private fun imageMimeType(image: File): String = when (image.extension.lowercase()) {
        "png" -> "image/png"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        else -> "image/jpeg"
    }

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
