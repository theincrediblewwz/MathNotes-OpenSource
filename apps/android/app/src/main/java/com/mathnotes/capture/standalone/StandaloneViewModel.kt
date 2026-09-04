package com.mathnotes.capture.standalone

import android.app.Application
import android.content.Context
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class StandaloneUiState(
    val notebooks: List<StandaloneNotebookEntity> = emptyList(),
    val sessions: List<StandaloneSessionEntity> = emptyList(),
    val activeSession: StandaloneSessionEntity? = null,
    val blocks: List<StandaloneBlockEntity> = emptyList(),
    val tasks: List<StandaloneRecognitionTaskEntity> = emptyList(),
    val allBlocks: List<StandaloneBlockEntity> = emptyList(),
    val allTasks: List<StandaloneRecognitionTaskEntity> = emptyList()
)

private data class StandaloneCatalogState(
    val notebooks: List<StandaloneNotebookEntity>,
    val sessions: List<StandaloneSessionEntity>,
    val activeSession: StandaloneSessionEntity?
)

private data class StandaloneQueueState(
    val blocks: List<StandaloneBlockEntity>,
    val tasks: List<StandaloneRecognitionTaskEntity>
)

internal fun enqueueCapturedRecognitionIfReady(
    task: StandaloneRecognitionTaskEntity,
    autoStartRecognition: Boolean,
    enqueue: (taskId: String, requiresNetwork: Boolean) -> Unit
): Boolean {
    if (!autoStartRecognition || task.status != StandaloneTaskStatus.AWAITING_CONFIRMATION) return false
    enqueue(task.id, task.providerId != "local-fake")
    return true
}

@OptIn(ExperimentalCoroutinesApi::class)
class StandaloneViewModel(application: Application) : AndroidViewModel(application) {
    private val repository = StandaloneRepository(application)
    private val scheduler = StandaloneRecognitionScheduler(application)
    private val profileStore = StandaloneProviderProfileStore(application)
    private val selectionStore = application.getSharedPreferences(SELECTION_STORE, Context.MODE_PRIVATE)
    private val activeSessionId = MutableStateFlow(selectionStore.getString(ACTIVE_SESSION_ID, null))

    val providerProfile = MutableStateFlow(profileStore.load())

    private val catalogState = combine(repository.notebooks, repository.sessions, activeSessionId) { notebooks, sessions, selectedId ->
        StandaloneCatalogState(
            notebooks = notebooks,
            sessions = sessions,
            activeSession = sessions.firstOrNull { it.id == selectedId } ?: sessions.firstOrNull()
        )
    }
    private val queueState = combine(repository.allBlocks, repository.allTasks) { blocks, tasks ->
        StandaloneQueueState(blocks, tasks)
    }

    val state: StateFlow<StandaloneUiState> = combine(catalogState, queueState) { catalog, queue -> catalog to queue }
        .flatMapLatest { (catalog, queue) ->
            val active = catalog.activeSession
            if (active == null) {
                flowOf(
                    StandaloneUiState(
                        notebooks = catalog.notebooks,
                        sessions = catalog.sessions,
                        allBlocks = queue.blocks,
                        allTasks = queue.tasks
                    )
                )
            } else {
                combine(repository.blocks(active.id), repository.tasks(active.id)) { blocks, tasks ->
                    StandaloneUiState(
                        notebooks = catalog.notebooks,
                        sessions = catalog.sessions,
                        activeSession = active,
                        blocks = blocks,
                        tasks = tasks,
                        allBlocks = queue.blocks,
                        allTasks = queue.tasks
                    )
                }
            }
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), StandaloneUiState())

    init {
        viewModelScope.launch {
            repository.recoverInterruptedClaims()
            val initial = repository.ensureCaptureSession()
            if (activeSessionId.value.isNullOrBlank()) selectSession(initial.id)
        }
    }

    fun selectSession(sessionId: String) {
        activeSessionId.value = sessionId
        selectionStore.edit().putString(ACTIVE_SESSION_ID, sessionId).apply()
    }

    fun createNotebook(title: String, onComplete: (Result<StandaloneNotebookEntity>) -> Unit) {
        viewModelScope.launch { onComplete(runCatching { repository.createNotebook(title) }) }
    }

    fun createSession(
        notebookId: String,
        title: String,
        onComplete: (Result<StandaloneSessionEntity>) -> Unit
    ) {
        viewModelScope.launch {
            val result = runCatching { repository.createSession(notebookId, title) }
            result.getOrNull()?.let { selectSession(it.id) }
            onComplete(result)
        }
    }

    fun createSession(onComplete: (Result<Unit>) -> Unit) {
        viewModelScope.launch {
            val result = runCatching {
                val notebook = state.value.activeSession?.notebookId?.let { id ->
                    state.value.notebooks.firstOrNull { it.id == id }
                } ?: state.value.notebooks.firstOrNull() ?: repository.createNotebook("本机笔记")
                val session = repository.createSession(notebook.id, "未命名 Session")
                selectSession(session.id)
            }
            onComplete(result)
        }
    }

    fun renameNotebook(notebookId: String, title: String, onComplete: (Result<Unit>) -> Unit) {
        viewModelScope.launch {
            onComplete(runCatching { check(repository.renameNotebook(notebookId, title)) { "Notebook 已经变化" } })
        }
    }

    fun renameSession(sessionId: String, title: String, onComplete: (Result<Unit>) -> Unit) {
        viewModelScope.launch {
            onComplete(runCatching { check(repository.renameSession(sessionId, title)) { "Session 已经变化" } })
        }
    }

    fun exportNotebook(notebookId: String, target: Uri, onComplete: (Result<Int>) -> Unit) {
        viewModelScope.launch {
            onComplete(runCatching { repository.exportNotebookMarkdown(notebookId, target) })
        }
    }

    fun exportSession(sessionId: String, target: Uri, onComplete: (Result<Unit>) -> Unit) {
        viewModelScope.launch {
            onComplete(runCatching { repository.exportSessionMarkdown(sessionId, target) })
        }
    }

    fun deleteNotebook(notebookId: String, onComplete: (Result<Unit>) -> Unit) {
        viewModelScope.launch {
            val result = runCatching { check(repository.deleteNotebook(notebookId)) { "Notebook 已经变化" } }
            if (result.isSuccess && state.value.activeSession?.notebookId == notebookId) clearSelection()
            onComplete(result)
        }
    }

    fun deleteSession(sessionId: String, onComplete: (Result<Unit>) -> Unit) {
        viewModelScope.launch {
            val result = runCatching { check(repository.deleteSession(sessionId)) { "Session 已经变化" } }
            if (result.isSuccess && activeSessionId.value == sessionId) clearSelection()
            onComplete(result)
        }
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
        saveProviderProfile(StandaloneProviderProfileStore.PROVIDER_ID, endpoint, model, apiKey, onComplete)
    }

    fun importCapturedFile(
        file: File,
        sessionId: String? = null,
        autoStartRecognition: Boolean = true,
        onComplete: (Result<StandaloneRecognitionTaskEntity>) -> Unit
    ) {
        viewModelScope.launch {
            val result = runCatching {
                val session = sessionId
                    ?.let { requested -> state.value.sessions.firstOrNull { it.id == requested } }
                    ?: state.value.activeSession
                    ?: repository.ensureCaptureSession()
                val task = repository.importCapturedFile(session.id, file, providerProfile.value)
                enqueueCapturedRecognitionIfReady(task, autoStartRecognition, scheduler::enqueueAfterUserConfirmation)
                if (file.exists()) file.delete()
                selectSession(session.id)
                task
            }
            onComplete(result)
        }
    }

    fun deleteImage(block: StandaloneBlockEntity, onComplete: (Result<Unit>) -> Unit = {}) {
        viewModelScope.launch {
            onComplete(runCatching {
                check(repository.deleteImage(block.id)) { "照片仍在识别或已经变化" }
            })
        }
    }

    fun deleteTask(task: StandaloneRecognitionTaskEntity, onComplete: (Result<Unit>) -> Unit = {}) {
        viewModelScope.launch {
            onComplete(runCatching {
                check(task.status != StandaloneTaskStatus.CLAIMED) { "正在识别，完成后才能删除" }
                val block = requireNotNull(repository.findBlock(task.assetBlockId)) { "任务素材已经不存在" }
                check(repository.deleteImage(block.id)) { "任务已经变化" }
            })
        }
    }

    fun configureRecognition(task: StandaloneRecognitionTaskEntity, onComplete: (Result<Unit>) -> Unit) {
        viewModelScope.launch {
            onComplete(runCatching {
                val profile = requireNotNull(providerProfile.value) { "请先在设置中保存本机识别模型" }
                check(repository.configureWaitingTask(task.id, profile)) { "识别任务已经变化" }
            })
        }
    }

    fun saveProviderProfile(
        providerId: String,
        endpoint: String,
        model: String,
        apiKey: String,
        onComplete: (Result<Unit>) -> Unit
    ) {
        viewModelScope.launch {
            val result = runCatching { providerProfile.value = profileStore.save(providerId, endpoint, model, apiKey); Unit }
            onComplete(result)
        }
    }

    fun useFakeProvider() {
        profileStore.useFake()
        providerProfile.value = profileStore.load()
    }

    private fun clearSelection() {
        activeSessionId.value = null
        selectionStore.edit().remove(ACTIVE_SESSION_ID).apply()
    }

    private companion object {
        const val SELECTION_STORE = "standalone_workspace_selection"
        const val ACTIVE_SESSION_ID = "active_session_id"
    }
}
