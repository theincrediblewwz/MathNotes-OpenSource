package com.mathnotes.capture.standalone

import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.mathnotes.capture.companion.COMPANION_READER_BASE_URL
import com.mathnotes.capture.companion.companionReaderAssetResponse
import com.mathnotes.capture.ui.MathNotesThemeId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class StandaloneMarkdownReaderAssetTest {
    @Test
    fun bundledReaderScriptsAreAvailableButArbitraryOrNetworkPathsAreRejected() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val markdownIt = companionReaderAssetResponse(
            context,
            Uri.parse("https://appassets.androidplatform.net/assets/reader/markdown-it.min.js")
        )
        val katex = companionReaderAssetResponse(
            context,
            Uri.parse("https://appassets.androidplatform.net/assets/katex/katex.min.js")
        )

        assertNotNull(markdownIt)
        assertNotNull(katex)
        assertEquals("application/javascript", markdownIt!!.mimeType)
        assertTrue(markdownIt.data.readBytes().isNotEmpty())
        assertNull(companionReaderAssetResponse(
            context,
            Uri.parse("https://appassets.androidplatform.net/assets/reader/../secret.txt")
        ))
        assertNull(companionReaderAssetResponse(
            context,
            Uri.parse("https://example.com/reader/markdown-it.min.js")
        ))
    }

    @Test
    fun multilineIndentedDisplayMathRendersAsKatexInsteadOfRawCode() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val html = prepareStandaloneMarkdownReaderHtml(
            """
                函数为

                    ${'$'}${'$'}
                    \mathscr{D}Q(\xi,A,Q)=\rho_{f,0}-
                    \rho_{s,0}=\xi-\dfrac{A}
                    {\sqrt{Q+2s\xi}}+\mathcal{T}(-\xi).
                    ${'$'}${'$'}

                中性曲面。对每个 ${'$'}Q\in I_Q${'$'}，
            """.trimIndent(),
            MathNotesThemeId.READING
        )
        val pageLoaded = CountDownLatch(1)
        lateinit var webView: WebView
        instrumentation.runOnMainSync {
            webView = WebView(context).apply {
                settings.javaScriptEnabled = true
                settings.blockNetworkLoads = true
                webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?) =
                        request?.url?.let { companionReaderAssetResponse(context, it) }

                    override fun onPageFinished(view: WebView?, url: String?) {
                        pageLoaded.countDown()
                    }
                }
                loadDataWithBaseURL(COMPANION_READER_BASE_URL, html, "text/html", "utf-8", null)
            }
        }
        assertTrue("reader page did not finish", pageLoaded.await(10, TimeUnit.SECONDS))

        val rendered = AtomicReference<String>()
        val evaluated = CountDownLatch(1)
        instrumentation.runOnMainSync {
            webView.evaluateJavascript(
                """
                    (() => {
                      const root = document.getElementById('mathnotes-local-markdown');
                      return root.querySelectorAll('.katex-display').length + '|' +
                        root.innerText.includes('${'$'}${'$'}') + '|' +
                        root.querySelectorAll('pre,code').length + '|' +
                        getComputedStyle(root.querySelector('.katex-display')).overflowX;
                    })()
                """.trimIndent()
            ) { value ->
                rendered.set(value)
                evaluated.countDown()
            }
        }
        assertTrue("reader javascript did not finish", evaluated.await(10, TimeUnit.SECONDS))
        assertEquals("\"1|false|0|auto\"", rendered.get())
        instrumentation.runOnMainSync { webView.destroy() }
    }
}
