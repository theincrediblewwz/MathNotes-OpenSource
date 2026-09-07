package com.mathnotes.capture.upload

import kotlinx.coroutines.sync.Mutex

internal object UploadQueueLock {
    val mutex = Mutex()
}
