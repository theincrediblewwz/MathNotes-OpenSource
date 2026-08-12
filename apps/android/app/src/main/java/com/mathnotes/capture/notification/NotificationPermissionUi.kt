package com.mathnotes.capture.notification

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

data class NotificationPermissionController(
    val state: NotificationPermissionState,
    val performAction: () -> Unit
)

@Composable
fun rememberNotificationPermissionController(): NotificationPermissionController {
    val context = LocalContext.current
    val activity = context as? Activity
    val lifecycleOwner = LocalLifecycleOwner.current
    val store = remember(context) { NotificationPermissionStore(context.applicationContext) }
    var state by remember { mutableStateOf(currentState(context, activity, store)) }

    fun refresh() {
        state = currentState(context, activity, store)
    }

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        refresh()
    }

    DisposableEffect(lifecycleOwner, activity) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) refresh()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    return NotificationPermissionController(
        state = state,
        performAction = {
            when (state.action) {
                NotificationPermissionAction.NONE -> Unit
                NotificationPermissionAction.REQUEST -> {
                    store.markRequested()
                    launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
                NotificationPermissionAction.OPEN_SETTINGS -> {
                    context.startActivity(
                        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                            data = Uri.parse("package:${context.packageName}")
                            putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                        }
                    )
                }
            }
        }
    )
}

private fun currentState(
    context: Context,
    activity: Activity?,
    store: NotificationPermissionStore
): NotificationPermissionState {
    val granted = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
    val rationale = Build.VERSION.SDK_INT >= 33 &&
        activity != null &&
        ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.POST_NOTIFICATIONS)
    return resolveNotificationPermissionState(
        sdkInt = Build.VERSION.SDK_INT,
        granted = granted,
        requestedBefore = store.wasRequested(),
        shouldShowRationale = rationale
    )
}

private class NotificationPermissionStore(context: Context) {
    private val preferences = context.getSharedPreferences("notification_permission", Context.MODE_PRIVATE)

    fun wasRequested(): Boolean = preferences.getBoolean("requested", false)

    fun markRequested() {
        preferences.edit().putBoolean("requested", true).apply()
    }
}
