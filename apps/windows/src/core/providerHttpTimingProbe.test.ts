import { describe, expect, it, vi } from "vitest";
import { createProviderHttpTimingFetch, type ProviderHttpTiming } from "./providerHttpTimingProbe";

describe("createProviderHttpTimingFetch", () => {
  it("records request, response headers and the first consumed body chunk without changing the response", async () => {
    const timing: ProviderHttpTiming = {};
    const ticks = [10, 30, 45];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.body).toBe('{"stream":true}');
      return new Response("data: first\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });
    const timedFetch = createProviderHttpTimingFetch({
      timing,
      fetchImpl,
      now: () => ticks.shift() ?? 99
    });

    const response = await timedFetch("https://example.test/v1/chat/completions", {
      method: "POST",
      body: '{"stream":true}'
    });

    expect(timing).toEqual({
      fetchCalledAt: 10,
      requestBodyBytes: 15,
      responseHeadersAt: 30,
      responseStatus: 200,
      responseContentType: "text/event-stream"
    });
    await expect(response.text()).resolves.toBe("data: first\n\n");
    expect(timing.firstBodyChunkAt).toBe(45);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("forwards stream cancellation to the original response body", async () => {
    const timing: ProviderHttpTiming = {};
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      pull() {
        // Remain pending until the consumer cancels.
      },
      cancel
    });
    const timedFetch = createProviderHttpTimingFetch({
      timing,
      fetchImpl: async () => new Response(source, { status: 200 }),
      now: () => 1
    });

    const response = await timedFetch("https://example.test", { method: "POST" });
    await response.body?.cancel("stop");

    expect(cancel).toHaveBeenCalledWith("stop");
  });
});
