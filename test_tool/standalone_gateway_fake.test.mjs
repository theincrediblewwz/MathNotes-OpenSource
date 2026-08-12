import assert from "node:assert/strict";
import test from "node:test";
import { createStandaloneGatewayFake } from "./standalone_gateway_fake.mjs";

test("local gateway requires auth, origin and idempotency without calling a provider", async () => {
  const server = createStandaloneGatewayFake({ token: "fixture", allowedOrigin: "http://127.0.0.1:4174" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/recognitions`, {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:4174", Authorization: "Bearer fixture",
        "Content-Type": "application/json", "Idempotency-Key": "request-1"
      },
      body: JSON.stringify({ version: 1, sessionId: "session", fileName: "page.jpg", imageDataUrl: "data:image/jpeg;base64,AQID" })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "succeeded");
    assert.match(body.markdown, /未调用任何真实 Provider/);
    const denied = await fetch(`http://127.0.0.1:${port}/v1/recognitions`, { method: "POST" });
    assert.equal(denied.status, 401);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
