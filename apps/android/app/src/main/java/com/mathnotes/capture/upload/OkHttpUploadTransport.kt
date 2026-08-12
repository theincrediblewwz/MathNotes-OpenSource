package com.mathnotes.capture.upload

import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.storage.CaptureEntity
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.Response
import java.io.File
import java.io.IOException
import java.time.Instant
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

class OkHttpUploadTransport(
    private val client: OkHttpClient = defaultClient()
) {
    suspend fun upload(capture: CaptureEntity, pairing: PairingConfig): UploadOutcome {
        val material = File(capture.localPath)
        if (!material.isFile || material.length() != capture.byteLength) {
            return UploadOutcome.PermanentFailure(null, "本地素材不存在或内容已变化")
        }

        val bodyBuilder = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("notebookId", capture.notebookId)
            .addFormDataPart("sessionId", capture.sessionId)
            .addFormDataPart("captureId", capture.captureId)
            .addFormDataPart("deviceId", capture.deviceId)
            .addFormDataPart("createdAt", Instant.ofEpochMilli(capture.createdAt).toString())
            .addFormDataPart("sha256", capture.sha256)
            .addFormDataPart("materialType", capture.materialType)
            .addFormDataPart("sourceName", capture.sourceName)
            .addFormDataPart(
                "material",
                capture.sourceName.ifBlank { material.name },
                material.asRequestBody(capture.mimeType.toMediaType())
            )
        val transformSidecar = File(material.parentFile, "${material.nameWithoutExtension}.annotation.json")
        if (capture.materialType == "image" && transformSidecar.isFile) {
            bodyBuilder.addFormDataPart("imageTransform", transformSidecar.readText(Charsets.UTF_8))
        }
        val body = bodyBuilder.build()
        val request = Request.Builder()
            .url("${pairing.endpoint}/api/v1/uploads")
            .header("Authorization", "Bearer ${pairing.token}")
            .post(body)
            .build()

        return try {
            val response = client.newCall(request).await()
            response.use {
                UploadResponseClassifier.classify(it.code, it.body?.string().orEmpty())
            }
        } catch (error: IOException) {
            UploadOutcome.Retryable(null, "连接电脑失败：${error.userSafeMessage()}")
        }
    }

    private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { cancel() }
        enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) {
                if (continuation.isActive) continuation.resumeWith(Result.failure(error))
            }

            override fun onResponse(call: Call, response: Response) {
                if (continuation.isActive) continuation.resume(response) else response.close()
            }
        })
    }

    private fun IOException.userSafeMessage(): String = when {
        message?.contains("timeout", ignoreCase = true) == true -> "连接超时"
        else -> "网络暂不可用"
    }

    companion object {
        private fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .writeTimeout(5, TimeUnit.MINUTES)
            .readTimeout(30, TimeUnit.SECONDS)
            .callTimeout(6, TimeUnit.MINUTES)
            .followRedirects(false)
            .build()
    }
}
