package com.mathnotes.capture.companion

import com.mathnotes.capture.pairing.PairingConfig
import com.mathnotes.capture.pairing.PairingTarget
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.retryWhen
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class CompanionRepository(
    private val dao: CompanionSessionDao,
    private val client: CompanionApiClient = CompanionApiClient(),
    private val markdownMirror: CompanionMarkdownMirror? = null,
    private val contentStore: CompanionContentStore? = null
) {
    private val sessionRefreshMutex = Mutex()
    private val catalogRefreshMutex = Mutex()

    fun sessions(pairing: PairingConfig): Flow<List<CompanionSessionEntity>> =
        dao.observeForProfile(profileKey(pairing))
            .map { sessions -> sessions.map { hydrate(pairing, it) } }
            .flowOn(Dispatchers.IO)

    suspend fun refresh(pairing: PairingConfig, target: PairingTarget) = sessionRefreshMutex.withLock {
        val cached = dao.find(profileKey(pairing), target.notebookId, target.sessionId)?.let { hydrate(pairing, it) }
        val snapshot = try {
            client.fetchSession(pairing, target, cached?.usableRevision()) { cacheSnapshot(pairing, it) }
        } catch (_: CompanionNotModifiedException) {
            cached?.toSnapshot() ?: throw CompanionSyncException("本地笔记缓存缺失，请重新同步。")
        }
        cacheSnapshot(pairing, snapshot)
    }

    suspend fun refresh(
        preferred: PairingConfig,
        target: PairingTarget,
        candidates: List<PairingConfig>
    ): ResolvedCompanionSession = sessionRefreshMutex.withLock {
        var lastError: Throwable? = null
        for (candidate in orderedEndpointCandidates(preferred, candidates)) {
            try {
                val cached = dao.find(profileKey(candidate), target.notebookId, target.sessionId)?.let { hydrate(candidate, it) }
                val snapshot = try {
                    client.fetchSession(candidate, target, cached?.usableRevision()) { cacheSnapshot(candidate, it) }
                } catch (_: CompanionNotModifiedException) {
                    cached?.toSnapshot() ?: throw CompanionSyncException("本地笔记缓存缺失，请重新同步。")
                }
                cacheSnapshot(candidate, snapshot)
                return@withLock ResolvedCompanionSession(candidate, snapshot)
            } catch (error: CompanionAuthenticationException) {
                throw error
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                android.util.Log.e("CompanionSync", "候选地址 ${candidate.endpointId} 同步失败", error)
                lastError = if (error is CompanionSyncException) {
                    error
                } else {
                    CompanionSyncException(describeUnexpectedSyncError(error), error)
                }
            }
        }
        throw lastError ?: CompanionConnectionException("没有可用的电脑连接地址。")
    }

    suspend fun refreshCatalog(pairing: PairingConfig): CompanionCatalogSnapshot = catalogRefreshMutex.withLock {
        val catalog = client.fetchCatalog(pairing)
        reconcileCatalog(pairing, catalog)
        catalog
    }

    suspend fun refreshCatalog(
        preferred: PairingConfig,
        candidates: List<PairingConfig>
    ): ResolvedCompanionCatalog = catalogRefreshMutex.withLock {
        var lastError: Throwable? = null
        for (candidate in orderedEndpointCandidates(preferred, candidates)) {
            try {
                val catalog = client.fetchCatalog(candidate)
                reconcileCatalog(candidate, catalog)
                return@withLock ResolvedCompanionCatalog(candidate, catalog)
            } catch (error: CompanionAuthenticationException) {
                throw error
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                android.util.Log.e("CompanionSync", "候选地址 ${candidate.endpointId} 目录同步失败", error)
                lastError = if (error is CompanionSyncException) {
                    error
                } else {
                    CompanionSyncException(describeUnexpectedSyncError(error), error)
                }
            }
        }
        throw lastError ?: CompanionConnectionException("没有可用的电脑连接地址。")
    }

    suspend fun deleteSession(pairing: PairingConfig, target: PairingTarget) {
        dao.delete(profileKey(pairing), target.notebookId, target.sessionId)
        contentStore?.delete(pairing, target)
    }

    private suspend fun cacheSnapshot(pairing: PairingConfig, snapshot: CompanionSessionSnapshot) {
        contentStore?.write(pairing, snapshot)
        val entity = CompanionSessionEntity(
                profileId = profileKey(pairing),
                notebookId = snapshot.notebookId,
                sessionId = snapshot.sessionId,
                title = snapshot.title,
                revision = snapshot.revision,
                markdown = if (contentStore == null) snapshot.markdown else "",
                html = if (contentStore == null) snapshot.html else "",
                updatedAt = snapshot.updatedAt,
                syncedAt = System.currentTimeMillis()
            )
        dao.upsert(entity)
        if (snapshot.markdown.isNotBlank()) runCatching { markdownMirror?.writeSnapshot(snapshot) }
    }

    private suspend fun reconcileCatalog(pairing: PairingConfig, catalog: CompanionCatalogSnapshot) {
        val profileId = profileKey(pairing)
        val advertised = catalog.targets.associateBy { it.notebookId to it.sessionId }
        val cachedSessions = dao.listForProfile(profileId)
        val cachedByTarget = cachedSessions.associateBy { it.notebookId to it.sessionId }
        cachedSessions.forEach { cached ->
            val target = advertised[cached.notebookId to cached.sessionId]
            if (target == null) {
                dao.delete(profileId, cached.notebookId, cached.sessionId)
                contentStore?.delete(
                    pairing,
                    PairingTarget(cached.notebookId, cached.sessionId, cached.title)
                )
            } else if (cached.title != target.title) {
                dao.upsert(cached.copy(title = target.title))
            }
        }
        catalog.targets.forEach { target ->
            if ((target.notebookId to target.sessionId) !in cachedByTarget) {
                dao.upsert(
                    CompanionSessionEntity(
                        profileId = profileId,
                        notebookId = target.notebookId,
                        sessionId = target.sessionId,
                        title = target.title,
                        revision = "",
                        markdown = "",
                        html = "",
                        updatedAt = "",
                        syncedAt = 0L
                    )
                )
            }
        }
        // Version 1 had no computer profile key. It remains readable until the
        // first authoritative catalog succeeds, then the derivative cache can rebuild safely.
        dao.deleteLegacy()
    }

    fun observeChanges(pairing: PairingConfig, target: PairingTarget): Flow<CompanionSessionChange> =
        client.observeChanges(pairing, target)
            .conflate()
            .retryWhen { _, attempt ->
                delay((1_000L shl attempt.coerceAtMost(4).toInt()).coerceAtMost(15_000L))
                true
            }

    fun observeCatalogChanges(pairing: PairingConfig): Flow<Unit> =
        client.observeCatalogChanges(pairing)
            .conflate()
            .retryWhen { _, attempt ->
                delay((1_000L shl attempt.coerceAtMost(4).toInt()).coerceAtMost(15_000L))
                true
            }

    internal fun profileKey(pairing: PairingConfig): String = pairing.profileId.ifBlank {
        pairing.endpointId
    }

    private fun hydrate(pairing: PairingConfig, entity: CompanionSessionEntity): CompanionSessionEntity =
        contentStore?.hydrate(pairing, entity) ?: entity
}

private fun CompanionSessionEntity.toSnapshot() = CompanionSessionSnapshot(
    notebookId = notebookId,
    sessionId = sessionId,
    title = title,
    revision = revision,
    updatedAt = updatedAt,
    markdown = markdown,
    html = html,
    assets = emptyList()
)

private fun CompanionSessionEntity.usableRevision(): String? = revision.takeUnless {
    html.contains("data:image/", ignoreCase = true)
}

internal fun orderedEndpointCandidates(
    preferred: PairingConfig,
    candidates: List<PairingConfig>
): List<PairingConfig> = (listOf(preferred) + candidates)
    .distinctBy { it.endpointId }
    .map { candidate ->
        candidate.copy(
            profileId = preferred.profileId.ifBlank { preferred.endpointId },
            notebookId = preferred.notebookId,
            sessionId = preferred.sessionId,
            targetTitle = preferred.targetTitle
        )
    }

data class ResolvedCompanionCatalog(
    val pairing: PairingConfig,
    val catalog: CompanionCatalogSnapshot
)

data class ResolvedCompanionSession(
    val pairing: PairingConfig,
    val snapshot: CompanionSessionSnapshot
)
