package com.mathnotes.capture

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.imageedit.ImageEditDraft
import com.mathnotes.capture.imageedit.ImageAnnotationObject
import com.mathnotes.capture.imageedit.NormalizedPoint
import com.mathnotes.capture.imageedit.NormalizedRect
import com.mathnotes.capture.pairing.PairingStore
import com.mathnotes.capture.storage.CaptureEntity
import com.mathnotes.capture.storage.CaptureRepository
import com.mathnotes.capture.upload.UploadScheduler
import com.mathnotes.capture.upload.UploadRecovery
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File

class CaptureViewModel(application: Application) : AndroidViewModel(application) {
    private val repository = CaptureRepository(application)
    private val uploadScheduler = UploadScheduler(application)
    private val pairingStore = PairingStore(application)
    private val cameraCommitQueue = Mutex()
    val captures: StateFlow<List<CaptureEntity>> = repository.captures.stateIn(
        viewModelScope,
        SharingStarted.WhileSubscribed(5_000),
        emptyList()
    )

    init {
        viewModelScope.launch {
            UploadRecovery(repository, uploadScheduler).enqueueOutstanding()
        }
    }

    fun createOutputFile(): File = repository.createOutputFile()

    fun commit(file: File, pairing: PairingConfig, onComplete: (Result<CaptureEntity>) -> Unit) {
        viewModelScope.launch {
            val result = cameraCommitQueue.withLock {
                runCatching { repository.commitCapturedFile(file, pairing) }
            }
            result.getOrNull()?.let { uploadScheduler.enqueue(it.captureId) }
            onComplete(result)
        }
    }

    fun importImage(uri: Uri, pairing: PairingConfig, onComplete: (Result<CaptureEntity>) -> Unit) {
        viewModelScope.launch {
            val result = runCatching { repository.importImage(uri, pairing) }
            result.getOrNull()?.let { uploadScheduler.enqueue(it.captureId) }
            onComplete(result)
        }
    }

    fun stageImage(uri: Uri, onComplete: (Result<ImageEditDraft>) -> Unit) {
        viewModelScope.launch {
            onComplete(runCatching { repository.stageImage(uri) })
        }
    }

    fun stageCapturedFile(file: File, onComplete: (Result<ImageEditDraft>) -> Unit) {
        viewModelScope.launch {
            onComplete(runCatching { repository.stageCapturedFile(file) })
        }
    }

    fun commitImageDraft(
        draft: ImageEditDraft,
        pairing: PairingConfig,
        rotationQuarterTurns: Int,
        perspectiveCorners: List<NormalizedPoint>?,
        cropRect: NormalizedRect?,
        lassoPoints: List<NormalizedPoint>?,
        annotations: List<ImageAnnotationObject>,
        onComplete: (Result<CaptureEntity>) -> Unit
    ) {
        viewModelScope.launch {
            val result = runCatching {
                repository.commitImageDraft(draft, pairing, rotationQuarterTurns, perspectiveCorners, cropRect, lassoPoints, annotations)
            }
            result.getOrNull()?.let { uploadScheduler.enqueue(it.captureId) }
            onComplete(result)
        }
    }

    fun discardImageDraft(draft: ImageEditDraft) {
        repository.discardImageDraft(draft)
    }

    fun importPdf(uri: Uri, pairing: PairingConfig, onComplete: (Result<CaptureEntity>) -> Unit) {
        viewModelScope.launch {
            val result = runCatching { repository.importPdf(uri, pairing) }
            result.getOrNull()?.let { uploadScheduler.enqueue(it.captureId) }
            onComplete(result)
        }
    }

    fun deleteAcknowledged(capture: CaptureEntity) {
        viewModelScope.launch { repository.deleteAcknowledged(capture) }
    }

    fun clearUploadedHistory() {
        viewModelScope.launch { repository.clearUploadedHistory() }
    }

    fun clearRecentUploaded() {
        viewModelScope.launch { repository.clearRecentUploaded() }
    }

    fun retry(capture: CaptureEntity) {
        viewModelScope.launch {
            val activePairing = pairingStore.load() ?: return@launch
            if (repository.prepareManualRetry(capture.captureId, activePairing)) {
                uploadScheduler.enqueue(capture.captureId, replace = true)
            }
        }
    }

    fun resumeBlockedAfterPairing(pairing: PairingConfig) {
        viewModelScope.launch {
            repository.prepareBlockedAuthRetries(pairing).forEach { captureId ->
                uploadScheduler.enqueue(captureId, replace = true)
            }
        }
    }

    fun cancel(capture: CaptureEntity) {
        uploadScheduler.cancel(capture.captureId)
        viewModelScope.launch { repository.markCancelled(capture.captureId) }
    }
}
