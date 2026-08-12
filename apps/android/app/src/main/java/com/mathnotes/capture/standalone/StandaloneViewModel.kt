package com.mathnotes.capture.standalone

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

data class StandaloneUiState(
    val sessions: List<StandaloneSessionEntity> = emptyList(),
    val activeSession: StandaloneSessionEntity? = null,
    val blocks: List<StandaloneBlockEntity> = emptyList(),
    val tasks: List<StandaloneRecognitionTaskEntity> = emptyList()
)

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class StandaloneViewModel(application: Application) : AndroidViewModel(application) {
    private val repository = StandaloneRepository(application)
    private val scheduler = StandaloneRecognitionScheduler(application)
    private val profileStore = StandaloneProviderProfileStore(application)
    val providerProfile = MutableStateFlow(profileStore.load())

    val state: StateFlow<StandaloneUiState> = repository.sessions.flatMapLatest { sessions ->
        val active = sessions.firstOrNull()
        if (active == null) flowOf(StandaloneUiState())
        else repository.blocks(active.id).flatMapLatest { blocks ->
            repository.tasks(active.id).map { tasks -> StandaloneUiState(sessions, active, blocks, tasks) }
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), StandaloneUiState())

    init {
        viewModelScope.launch { repository.recoverInterruptedClaims() }
    }

    fun createSession(onComplete: (Result<Unit>) -> Unit) {
        viewModelScope.launch { onComplete(runCatching { repository.createSession(); Unit }) }
    }

    fun importImage(uri: Uri, onComplete: (Result<Unit>) -> Unit) {
        val sessionId = state.value.activeSession?.id
        if (sessionId == null) {
            onComplete(Result.failure(IllegalStateException("请先新建手机独立 Session")))
            return
        }
        viewModelScope.launch { onComplete(runCatching { repository.importImage(sessionId, uri, providerProfile.value); Unit }) }
    }

    fun confirmRecognition(task: StandaloneRecognitionTaskEntity) =
        scheduler.enqueueAfterUserConfirmation(task.id, task.providerId != "local-fake")

    fun saveProviderProfile(endpoint: String, model: String, apiKey: String, onComplete: (Result<Unit>) -> Unit) {
        viewModelScope.launch {
            val result = runCatching { providerProfile.value = profileStore.save(endpoint, model, apiKey); Unit }
            onComplete(result)
        }
    }

    fun useFakeProvider() {
        profileStore.useFake()
        providerProfile.value = profileStore.load()
    }
}
