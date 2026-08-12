package com.mathnotes.capture.upload

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UploadResponseClassifierTest {
    @Test
    fun acceptsNewAndDuplicateWindowsReceipts() {
        val receipt = """{"uploadId":"upload_1","imageBlockId":"0001","recognitionJobId":"recognition_1","duplicate":false}"""
        val accepted = UploadResponseClassifier.classify(202, receipt)
        assertTrue(accepted is UploadOutcome.Accepted)
        assertEquals("upload_1", (accepted as UploadOutcome.Accepted).receipt.uploadId)

        val duplicate = UploadResponseClassifier.classify(200, receipt.replace("false", "true"))
        assertTrue(duplicate is UploadOutcome.Accepted)
        assertTrue((duplicate as UploadOutcome.Accepted).receipt.duplicate)
    }

    @Test
    fun acceptsPdfReceiptWithoutAnImageBlock() {
        val response = """{"uploadId":"pdf_1","materialType":"pdf","duplicate":false,"pageCount":50}"""
        val accepted = UploadResponseClassifier.classify(202, response)

        assertTrue(accepted is UploadOutcome.Accepted)
        val receipt = (accepted as UploadOutcome.Accepted).receipt
        assertEquals("pdf", receipt.materialType)
        assertEquals(null, receipt.imageBlockId)
        assertEquals(null, receipt.recognitionJobId)
    }

    @Test
    fun classifiesAuthenticationRetryableAndPermanentFailures() {
        assertTrue(UploadResponseClassifier.classify(401, "") is UploadOutcome.BlockedAuth)
        assertTrue(UploadResponseClassifier.classify(429, "") is UploadOutcome.Retryable)
        assertTrue(UploadResponseClassifier.classify(503, "") is UploadOutcome.Retryable)
        assertTrue(UploadResponseClassifier.classify(415, "") is UploadOutcome.PermanentFailure)
    }

    @Test
    fun invalidSuccessReceiptIsRetriedInsteadOfDiscardingThePhoto() {
        assertTrue(UploadResponseClassifier.classify(202, "{}") is UploadOutcome.Retryable)
    }

    @Test
    fun backoffIsBounded() {
        assertEquals(15_000L, UploadPolicy.backoffMillis(1))
        assertEquals(30_000L, UploadPolicy.backoffMillis(2))
        assertEquals(UploadPolicy.MAX_BACKOFF_MILLIS, UploadPolicy.backoffMillis(20))
    }
}
