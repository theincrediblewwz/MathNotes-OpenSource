package com.mathnotes.capture.standalone

import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.mathnotes.capture.companion.COMPANION_READER_BASE_URL
import com.mathnotes.capture.companion.companionReaderAssetResponse
import com.mathnotes.capture.companion.isReaderOutlineNavigation
import com.mathnotes.capture.ui.MathNotesThemeId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class ReaderOutlineWebViewTest {
    @Test
    fun localMarkdownOutlineStartsCollapsedAndLinksToRealHeadings() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val pageLoaded = CountDownLatch(1)
        lateinit var webView: WebView
        instrumentation.runOnMainSync {
            webView = WebView(context).apply {
                settings.javaScriptEnabled = true
                settings.blockNetworkLoads = true
                webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?) =
                        request?.url?.let { companionReaderAssetResponse(context, it) }
                    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean =
                        !isReaderOutlineNavigation(request?.url?.toString().orEmpty())
                    override fun onPageFinished(view: WebView?, url: String?) { pageLoaded.countDown() }
                }
                loadDataWithBaseURL(
                    COMPANION_READER_BASE_URL,
                    prepareStandaloneMarkdownReaderHtml("# 第一章\n\n## 子节\n\n### 详细内容", MathNotesThemeId.READING),
                    "text/html", "utf-8", null
                )
            }
        }
        try {
            assertTrue(pageLoaded.await(10, TimeUnit.SECONDS))
            val result = AtomicReference<String>()
            val evaluated = CountDownLatch(1)
            instrumentation.runOnMainSync {
                webView.evaluateJavascript("""
                    (() => {
                      const outline = document.querySelector('.mathnotes-outline');
                      const wasClosed = !outline.open;
                      const links = outline.querySelectorAll('a');
                      outline.open = true; links[2].click();
                      return links.length + '|' + wasClosed + '|' + outline.open + '|' +
                        document.querySelector('#mathnotes-heading-2').textContent + '|' +
                        links[2].style.getPropertyValue('--outline-level');
                    })()
                """.trimIndent()) { value -> result.set(value); evaluated.countDown() }
            }
            assertTrue(evaluated.await(10, TimeUnit.SECONDS))
            assertEquals("\"3|true|false|详细内容|2\"", result.get())
        } finally {
            instrumentation.runOnMainSync { webView.destroy() }
        }
    }
}
