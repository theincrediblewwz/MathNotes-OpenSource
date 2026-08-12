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

    @Test fun keystoreSecretIsBoundToDestinationProviderAndModel() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val store = StandaloneProviderSecretStore(context)
        store.save("https://provider.example/v1/chat/completions", "custom", "vision", "secret-value")
        assertEquals("secret-value", store.load("https://provider.example/v1/chat/completions", "custom", "vision"))
        assertEquals(null, store.load("https://other.example/v1/chat/completions", "custom", "vision"))
    }
}
