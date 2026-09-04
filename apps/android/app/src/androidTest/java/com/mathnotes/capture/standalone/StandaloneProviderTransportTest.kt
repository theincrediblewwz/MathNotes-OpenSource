package com.mathnotes.capture.standalone

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class StandaloneProviderTransportTest {
    @Test fun sendsFaithfulVisionRequestWithoutLeakingSecretIntoBody() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setHeader("Content-Type", "application/json")
            .setBody("""{"choices":[{"message":{"content":"## 忠实草稿\n\n${'$'}${'$'}x+y=z${'$'}${'$'}"}}]}"""))
        server.start()
        try {
            val image = File(ApplicationProvider.getApplicationContext<android.content.Context>().cacheDir, "provider-fixture.jpg")
            image.writeBytes(byteArrayOf(1, 2, 3, 4))
            val task = StandaloneRecognitionTaskEntity(
                id = "task", sessionId = "session", assetBlockId = "asset",
                providerId = StandaloneProviderProfileStore.PROVIDER_ID,
                destination = server.url("/v1/chat/completions").toString(), model = "vision-test",
                status = StandaloneTaskStatus.CLAIMED, createdAt = 1, updatedAt = 1
            )
            val markdown = OpenAiCompatibleStandaloneTransport().transcribe(task, image, "test-secret-never-log")
            val request = server.takeRequest()
            assertEquals("Bearer test-secret-never-log", request.getHeader("Authorization"))
            val body = request.body.readUtf8()
            assertFalse(body.contains("test-secret-never-log"))
            val imageUrl = org.json.JSONObject(body).getJSONArray("messages").getJSONObject(0)
                .getJSONArray("content").getJSONObject(1).getJSONObject("image_url").getString("url")
            assertTrue(imageUrl.startsWith("data:image/jpeg;base64,"))
            assertTrue(body.contains("忠实转写"))
            assertEquals("## 忠实草稿\n\n${'$'}${'$'}x+y=z${'$'}${'$'}", markdown)
        } finally {
            server.shutdown()
        }
    }

    @Test fun openAiUsesResponsesImageInputAndBearerAuthentication() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setHeader("Content-Type", "application/json")
            .setBody("""{"output_text":"## Responses 草稿"}"""))
        server.start()
        try {
            val image = File(ApplicationProvider.getApplicationContext<android.content.Context>().cacheDir, "responses-fixture.png")
            image.writeBytes(byteArrayOf(9, 8, 7, 6))
            val task = StandaloneRecognitionTaskEntity(
                id = "responses", sessionId = "session", assetBlockId = "asset",
                providerId = "openai_vision", destination = server.url("/v1/responses").toString(),
                model = "gpt-4.1-mini", status = StandaloneTaskStatus.CLAIMED, createdAt = 1, updatedAt = 1
            )

            assertEquals("## Responses 草稿", OpenAiCompatibleStandaloneTransport().transcribe(task, image, "openai-secret"))
            val request = server.takeRequest()
            assertEquals("Bearer openai-secret", request.getHeader("Authorization"))
            val body = request.body.readUtf8()
            assertFalse(body.contains("openai-secret"))
            val content = org.json.JSONObject(body).getJSONArray("input").getJSONObject(0).getJSONArray("content")
            assertEquals("input_text", content.getJSONObject(0).getString("type"))
            assertEquals("input_image", content.getJSONObject(1).getString("type"))
            assertTrue(content.getJSONObject(1).getString("image_url").startsWith("data:image/png;base64,"))
            image.delete()
        } finally {
            server.shutdown()
        }
    }

    @Test fun mimoUsesApiKeyHeaderWithoutBearerOrBodyLeak() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setHeader("Content-Type", "application/json")
            .setBody("""{"choices":[{"message":{"content":"## Mimo 草稿"}}]}"""))
        server.start()
        try {
            val image = File(ApplicationProvider.getApplicationContext<android.content.Context>().cacheDir, "mimo-fixture.jpg")
            image.writeBytes(byteArrayOf(5, 4, 3, 2))
            val task = StandaloneRecognitionTaskEntity(
                id = "mimo", sessionId = "session", assetBlockId = "asset",
                providerId = "mimo_2_5", destination = server.url("/v1/chat/completions").toString(),
                model = "mimo-v2.5", status = StandaloneTaskStatus.CLAIMED, createdAt = 1, updatedAt = 1
            )

            assertEquals("## Mimo 草稿", OpenAiCompatibleStandaloneTransport().transcribe(task, image, "mimo-secret"))
            val request = server.takeRequest()
            assertEquals("mimo-secret", request.getHeader("api-key"))
            assertEquals(null, request.getHeader("Authorization"))
            assertFalse(request.body.readUtf8().contains("mimo-secret"))
            image.delete()
        } finally {
            server.shutdown()
        }
    }

    @Test fun keystoreSecretIsBoundToDestinationProviderAndModel() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val store = StandaloneProviderSecretStore(context)
        store.save("https://provider.example/v1/chat/completions", "custom", "vision", "secret-value")
        assertEquals("secret-value", store.load("https://provider.example/v1/chat/completions", "custom", "vision"))
        assertEquals(null, store.load("https://other.example/v1/chat/completions", "custom", "vision"))
    }
}
