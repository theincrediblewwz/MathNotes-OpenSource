import { describe, expect, it } from "vitest";
import { CodexAppServerClient, type WebSocketLike } from "./codexAppServerClient";

class FakeWebSocket implements WebSocketLike {
  sent: string[] = [];
  private listeners = new Map<string, Array<(event: { data?: string }) => void>>();

  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit("close", {});
  }

  open(): void {
    this.emit("open", {});
  }

  message(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }

  private emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe("CodexAppServerClient", () => {
  it("correlates JSON-RPC request responses by id", async () => {
    const socket = new FakeWebSocket();
    const client = new CodexAppServerClient({
      url: "ws://127.0.0.1:1234",
      WebSocketImpl: () => socket,
      requestTimeoutMs: 100
    });
    const connected = client.connect();
    socket.open();
    await connected;

    const responsePromise = client.request<{ ok: boolean }>("initialize", { clientInfo: { name: "test" } });
    expect(JSON.parse(socket.sent[0])).toEqual({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "test" } }
    });

    socket.message({ id: 1, result: { ok: true } });

    await expect(responsePromise).resolves.toEqual({ ok: true });
  });

  it("delivers server notifications to subscribers", async () => {
    const socket = new FakeWebSocket();
    const notifications: unknown[] = [];
    const client = new CodexAppServerClient({
      url: "ws://127.0.0.1:1234",
      WebSocketImpl: () => socket,
      requestTimeoutMs: 100
    });
    client.onNotification((message) => notifications.push(message));
    const connected = client.connect();
    socket.open();
    await connected;

    socket.message({ method: "item/agentMessage/delta", params: { delta: "abc" } });

    expect(notifications).toEqual([{ method: "item/agentMessage/delta", params: { delta: "abc" } }]);
  });

  it("rejects request promises when server returns an error", async () => {
    const socket = new FakeWebSocket();
    const client = new CodexAppServerClient({
      url: "ws://127.0.0.1:1234",
      WebSocketImpl: () => socket,
      requestTimeoutMs: 100
    });
    const connected = client.connect();
    socket.open();
    await connected;

    const responsePromise = client.request("thread/start", {});
    socket.message({ id: 1, error: { code: -32602, message: "bad params" } });

    await expect(responsePromise).rejects.toThrow("bad params");
  });

  it("rejects requests that time out", async () => {
    const socket = new FakeWebSocket();
    const client = new CodexAppServerClient({
      url: "ws://127.0.0.1:1234",
      WebSocketImpl: () => socket,
      requestTimeoutMs: 1
    });
    const connected = client.connect();
    socket.open();
    await connected;

    await expect(client.request("initialize", {})).rejects.toThrow("timed out");
  });
});
