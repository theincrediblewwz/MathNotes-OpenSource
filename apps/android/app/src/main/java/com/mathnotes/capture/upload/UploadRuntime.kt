package com.mathnotes.capture.upload

import android.app.ForegroundServiceStartNotAllowedException
import android.content.Context
import android.net.ConnectivityManager
import android.os.Build
import android.os.SystemClock
import androidx.annotation.RequiresApi
import kotlinx.coroutines.CancellationException

internal class UploadRuntime(
    val hasConnectedNetwork: (Context) -> Boolean = ::hasConnectedUploadNetwork,
    val elapsedRealtime: () -> Long = SystemClock::elapsedRealtime,
    val backgroundBudgetMillis: Long = 8 * 60_000L,
    val transport: () -> OkHttpUploadTransport = { OkHttpUploadTransport() },
    val armOfflineWake: (Context) -> Unit = { OfflineNetworkWake.arm(it) }
)

@Suppress("DEPRECATION")
internal fun hasConnectedUploadNetwork(context: Context): Boolean {
    val connectivity = context.getSystemService(ConnectivityManager::class.java) ?: return false
    // Include local networks; neither INTERNET nor VALIDATED is required to reach a paired host.
    return connectivity.allNetworks.any { connectivity.getNetworkInfo(it)?.isConnected == true }
}

internal suspend fun tryUploadForeground(promote: suspend () -> Unit): Boolean = try {
    promote()
    true
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (error: Exception) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && ForegroundDenialApi31.isDenied(error)) false
    else throw error
}

@RequiresApi(Build.VERSION_CODES.S)
private object ForegroundDenialApi31 {
    fun isDenied(error: Throwable): Boolean {
        var cause: Throwable? = error
        repeat(16) {
            if (cause is ForegroundServiceStartNotAllowedException) return true
            cause = cause?.cause ?: return false
        }
        return false
    }
}
