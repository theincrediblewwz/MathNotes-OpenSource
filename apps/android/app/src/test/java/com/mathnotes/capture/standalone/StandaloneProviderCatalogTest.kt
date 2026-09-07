package com.mathnotes.capture.standalone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class StandaloneProviderCatalogTest {
    @Test
    fun `catalog exposes only Android visual providers`() {
        val ids = StandaloneProviderCatalog.recognitionProviders.map { it.providerId }
        assertEquals(
            listOf("deepseek", "openai_vision", "glm_5_2", "mimo_2_5", "gemini", "qwen", "custom_openai_compatible"),
            ids
        )
        assertFalse(ids.contains("codex_cli"))
        assertEquals("DeepSeek", StandaloneProviderCatalog.requireDescriptor("deepseek").label)
        assertEquals("GLM", StandaloneProviderCatalog.requireDescriptor("glm_5_2").label)
        assertEquals("MiMo", StandaloneProviderCatalog.requireDescriptor("mimo_2_5").label)
        assertEquals("deepseek-v4-flash-exp", StandaloneProviderCatalog.requireDescriptor("deepseek").defaultModel)
    }

    @Test
    fun `destinations and authentication follow provider contracts`() {
        assertEquals(
            "https://api.openai.com/v1/responses",
            StandaloneProviderCatalog.destination("openai_vision")
        )
        assertEquals(
            "https://api.xiaomimimo.com/v1/chat/completions",
            StandaloneProviderCatalog.destination("mimo_2_5")
        )
        assertEquals(
            "https://api.deepseek.com/chat/completions",
            StandaloneProviderCatalog.destination("deepseek")
        )
        assertEquals("secret", StandaloneProviderCatalog.requestHeaders("mimo_2_5", "secret")["api-key"])
        assertEquals("Bearer secret", StandaloneProviderCatalog.requestHeaders("deepseek", "secret")["Authorization"])
        assertEquals(
            "Bearer secret",
            StandaloneProviderCatalog.requestHeaders("openai_vision", "secret")["Authorization"]
        )
    }

    @Test
    fun `custom provider requires https except explicit loopback testing`() {
        assertEquals(
            "https://vision.example/v1/chat/completions",
            StandaloneProviderCatalog.destination("custom_openai_compatible", "https://vision.example/v1")
        )
        assertTrue(
            StandaloneProviderCatalog.destination("custom_openai_compatible", "http://10.0.2.2:8080/v1")
                .endsWith("/chat/completions")
        )
        try {
            StandaloneProviderCatalog.destination("custom_openai_compatible", "http://vision.example/v1")
            fail("non-loopback HTTP must be rejected")
        } catch (error: IllegalArgumentException) {
            assertTrue(error.message.orEmpty().contains("HTTPS"))
        }
    }

    @Test
    fun `faithful prompt preserves the Windows transcription contract`() {
        assertTrue(STANDALONE_FAITHFUL_TRANSCRIPTION_PROMPT.contains("不要总结、润色、改写或补充证明"))
        assertTrue(STANDALONE_FAITHFUL_TRANSCRIPTION_PROMPT.contains("分栏/列表/推导布局"))
        assertTrue(STANDALONE_FAITHFUL_TRANSCRIPTION_PROMPT.contains("[[mathnotes:source-image]]"))
        assertTrue(STANDALONE_FAITHFUL_TRANSCRIPTION_PROMPT.contains("行内公式统一使用 `\$...\$`"))
        assertTrue(STANDALONE_FAITHFUL_TRANSCRIPTION_PROMPT.contains("不要生成完整 LaTeX 文档"))
    }
}
