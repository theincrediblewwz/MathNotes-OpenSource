package com.mathnotes.capture.upload

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkRequest
import android.net.Uri
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.CancellationException
import java.util.UUID
import java.util.concurrent.TimeUnit

/** One passive network notification that survives ordinary process exit. */
internal object OfflineNetworkWake {
    const val ACTION = "com.mathnotes.capture.UPLOAD_NETWORK_AVAILABLE"
    private const val PREFERENCES = "upload_network_wake"
    private const val GENERATION = "generation"

    @Synchronized fun arm(context: Context): Boolean {
        disarm(context)
        val generation = UUID.randomUUID().toString()
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        if (!preferences.edit().putString(GENERATION, generation).commit()) return false
        try {
            // Passive only: do not bring up a network or require INTERNET/VALIDATED capabilities.
            context.getSystemService(ConnectivityManager::class.java).registerNetworkCallback(
                NetworkRequest.Builder().clearCapabilities().build(), pendingIntent(context, generation))
            return true
        } catch (error: RuntimeException) {
            disarm(context)
            Log.w("MathNotesUpload", "Network wake registration failed; scheduled work remains retryable", error)
            return false
        }
    }

    @Synchronized fun disarm(context: Context) {
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        val generation = preferences.getString(GENERATION, null) ?: return
        preferences.edit().remove(GENERATION).commit()
        val pending = pendingIntent(context, generation)
        try { context.getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(pending) }
        catch (error: RuntimeException) { Log.w("MathNotesUpload", "Network wake registration was already released", error) }
        finally { pending.cancel() }
    }

    @Synchronized fun consume(context: Context, intent: Intent): Boolean {
        if (intent.action != ACTION) return false
        val generation = intent.data?.takeIf { it.scheme == "mathnotes-upload" && it.host == "network" }?.lastPathSegment ?: return false
        if (generation != context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString(GENERATION, null)) return false
        disarm(context)
        return true
    }

    private fun pendingIntent(context: Context, generation: String): PendingIntent = PendingIntent.getBroadcast(
        context, 0, Intent(context, UploadNetworkReceiver::class.java).setAction(ACTION)
            .setData(Uri.parse("mathnotes-upload://network/$generation")),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
}

class UploadNetworkReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val networkEvent = intent.action != Intent.ACTION_BOOT_COMPLETED
        if (networkEvent && !OfflineNetworkWake.consume(context, intent)) return
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try { NetworkRecoveryWorker.enqueue(context.applicationContext, networkEvent).result.get(8, TimeUnit.SECONDS) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { Log.w("MathNotesUpload", "Network wake could not schedule recovery; queued uploads are retained", error) }
            finally { pending.finish() }
        }
    }
}
