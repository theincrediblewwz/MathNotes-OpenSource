package com.mathnotes.capture.upload

import org.json.JSONObject

object UploadResponseClassifier {
    fun classify(httpStatus: Int, responseBody: String): UploadOutcome = when {
        httpStatus == 200 || httpStatus == 202 -> parseReceipt(httpStatus, responseBody)
        httpStatus == 401 || httpStatus == 403 -> UploadOutcome.BlockedAuth(
            httpStatus,
            "配对令牌已失效，请重新连接电脑"
        )
        httpStatus == 408 || httpStatus == 425 || httpStatus == 429 || httpStatus in 500..599 ->
            UploadOutcome.Retryable(httpStatus, "电脑暂时未能接收素材（HTTP $httpStatus）")
        else -> UploadOutcome.PermanentFailure(httpStatus, "电脑拒绝了这项素材（HTTP $httpStatus）")
    }

    private fun parseReceipt(httpStatus: Int, body: String): UploadOutcome = runCatching {
        val json = JSONObject(body)
        UploadReceipt(
            uploadId = json.getString("uploadId"),
            imageBlockId = json.optString("imageBlockId").takeIf { it.isNotBlank() },
            recognitionJobId = json.optString("recognitionJobId").takeIf { it.isNotBlank() },
            duplicate = json.optBoolean("duplicate", httpStatus == 200),
            materialType = json.optString("materialType", "image")
        )
    }.fold(
        onSuccess = { UploadOutcome.Accepted(httpStatus, it) },
        onFailure = { UploadOutcome.Retryable(httpStatus, "电脑回执格式无效，稍后重试") }
    )
}
