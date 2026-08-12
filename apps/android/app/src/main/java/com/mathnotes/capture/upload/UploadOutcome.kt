package com.mathnotes.capture.upload

data class UploadReceipt(
    val uploadId: String,
    val imageBlockId: String?,
    val recognitionJobId: String?,
    val duplicate: Boolean,
    val materialType: String = "image"
)

sealed interface UploadOutcome {
    data class Accepted(val httpStatus: Int, val receipt: UploadReceipt) : UploadOutcome
    data class Retryable(val httpStatus: Int?, val message: String) : UploadOutcome
    data class BlockedAuth(val httpStatus: Int, val message: String) : UploadOutcome
    data class PermanentFailure(val httpStatus: Int?, val message: String) : UploadOutcome
}

object UploadPolicy {
    const val MAX_AUTOMATIC_ATTEMPTS = 5
    const val INITIAL_BACKOFF_MILLIS = 15_000L
    const val MAX_BACKOFF_MILLIS = 15 * 60_000L

    fun backoffMillis(attempt: Int): Long {
        val exponent = (attempt - 1).coerceIn(0, 10)
        return (INITIAL_BACKOFF_MILLIS * (1L shl exponent)).coerceAtMost(MAX_BACKOFF_MILLIS)
    }
}
