package com.mathnotes.capture.upload

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import com.mathnotes.capture.storage.CaptureRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.CancellationException
import java.util.concurrent.TimeUnit

class UploadPauseReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION || intent.data?.scheme != "mathnotes-upload" || intent.data?.host != "pause") return
        val captureId = intent.data?.lastPathSegment?.takeIf { it.isNotBlank() } ?: return
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                CaptureRepository(context).markCancelled(captureId)
                UploadScheduler(context).cancel(captureId).result.get(8, TimeUnit.SECONDS)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                Log.w("MathNotesUpload", "Could not finish cancelling paused work", error)
            } finally { pending.finish() }
        }
    }

    companion object {
        private const val ACTION = "com.mathnotes.capture.PAUSE_UPLOAD"
        fun pendingIntent(context: Context, captureId: String): PendingIntent = PendingIntent.getBroadcast(
            context, 0, Intent(context, UploadPauseReceiver::class.java).setAction(ACTION)
                .setData(Uri.Builder().scheme("mathnotes-upload").authority("pause").appendPath(captureId).build()),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}
