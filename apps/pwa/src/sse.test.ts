import { describe, expect, it } from "vitest";
import { parseSseStream } from "./sse";

describe("parseSseStream", () => {
  it("parses split UTF-8 chunks, comments, IDs, retry and multiple data lines", async () => {
    const encoder = new TextEncoder();
    const source = [
      ": hello\n",
      "id: 7\n",
      "event: session-changed\n",
      "retry: 2500\n",
      "data: {\"message\":\"数",
      "学\"}\n",
      "data: second\n\n"
    ].map((part) => encoder.encode(part));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of source) controller.enqueue(chunk);
        controller.close();
      }
    });
    const messages: unknown[] = [];
    await parseSseStream(stream, (message) => messages.push(message));
    expect(messages).toEqual([{
      event: "session-changed",
      data: "{\"message\":\"数学\"}\nsecond",
      id: "7",
      retry: 2500
    }]);
  });

  it("does not dispatch comment-only heartbeats", async () => {
    const bytes = new TextEncoder().encode(": heartbeat\n\n");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    });
    const messages: unknown[] = [];
    await parseSseStream(stream, (message) => messages.push(message));
    expect(messages).toEqual([]);
  });
});
