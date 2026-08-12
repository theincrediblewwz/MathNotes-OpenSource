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

internal class OpenAiCompatibleStandaloneTransport(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()
) {
    fun transcribe(task: StandaloneRecognitionTaskEntity, image: File, apiKey: String): String {
        require(image.isFile && image.length() > 0) { "识别图片不存在或为空" }
        val dataUrl = "data:image/jpeg;base64," + Base64.encodeToString(image.readBytes(), Base64.NO_WRAP)
        val content = JSONArray()
            .put(JSONObject().put("type", "text").put("text", FAITHFUL_PROMPT))
            .put(JSONObject().put("type", "image_url").put("image_url", JSONObject().put("url", dataUrl)))
        val body = JSONObject()
            .put("model", task.model)
            .put("stream", false)
            .put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", content)))
            .toString()
        val request = Request.Builder()
            .url(task.destination)
            .header("Authorization", "Bearer $apiKey")
            .header("Content-Type", "application/json")
            .post(body.toRequestBody(JSON_MEDIA_TYPE))
            .build()
        client.newCall(request).execute().use { response ->
            val raw = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val remote = runCatching { JSONObject(raw).optJSONObject("error")?.optString("message") }.getOrNull()
                throw KnownProviderFailure("Provider HTTP ${response.code}: ${remote?.take(240) ?: "请求被拒绝"}")
            }
            val contentValue = runCatching {
                JSONObject(raw).getJSONArray("choices").getJSONObject(0).getJSONObject("message").get("content")
            }.getOrElse { throw KnownProviderFailure("Provider 返回格式无法识别") }
            val markdown = when (contentValue) {
                is String -> contentValue
                is JSONArray -> buildString {
                    for (index in 0 until contentValue.length()) append(contentValue.optJSONObject(index)?.optString("text").orEmpty())
                }
                else -> ""
            }.trim()
            if (markdown.isBlank()) throw KnownProviderFailure("Provider 返回了空草稿")
            return markdown
        }
    }

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        val FAITHFUL_PROMPT = listOf(
            "你将看到数学板书、手写笔记或书页照片。请忠实转写为 Markdown。",
            "不要总结、润色、改写或补充证明；保持原始顺序、编号、换行和推导布局。",
            "行内公式使用 \$...\$，独立公式使用 \$\$...\$\$。",
            "看不清处写 [看不清]，不确定符号写 [不确定：...]。",
            "只输出 Markdown 草稿，不要输出解释或包住整篇的代码围栏。"
        ).joinToString("\n")
    }
}
