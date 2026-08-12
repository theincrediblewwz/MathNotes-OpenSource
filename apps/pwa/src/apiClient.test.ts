import { describe, expect, it, vi } from "vitest";
import { CompanionApiClient, CompanionApiError, NotModifiedError } from "./apiClient";
import type { UploadTask } from "./domain";

describe("CompanionApiClient", () => {
  it("invokes the browser fetch function with the global object as its receiver", async () => {
    const originalFetch = globalThis.fetch;
    let receiver: unknown;
    globalThis.fetch = function (this: unknown) {
      receiver = this;
      return Promise.resolve(Response.json({ ok: true, version: 1, targets: [], activeTarget: null }));
    } as typeof fetch;
    try {
      await new CompanionApiClient("https://notes.test").verify("device-token");
      expect(receiver).toBe(globalThis);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("exchanges and verifies a device credential without using cross-origin endpoints", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device: { deviceId: "device-1", label: "iPhone" },
        token: "secret-token"
      }), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        version: 1,
        activeTarget: null,
        targets: [{ notebookId: "analysis", notebookTitle: "分析", sessionId: "lecture", title: "第 1 讲" }],
        capabilities: {
          upload: { image: true, pdf: true },
          recognition: { status: true, retry: true }
        }
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new CompanionApiClient("https://notes.example.test/app", request);
    const credential = await client.exchangePairing({ challengeId: "challenge", userCode: "CODE" }, "iPhone");
    const catalog = await client.verify(credential.token);

    expect(credential).toMatchObject({ origin: "https://notes.example.test", token: "secret-token", deviceId: "device-1" });
    expect(catalog.targets[0]).toMatchObject({ notebookId: "analysis", sessionId: "lecture" });
    expect(catalog.capabilities).toEqual({
      imageUpload: true,
      pdfUpload: true,
      recognitionStatus: true,
      recognitionRetry: true
    });
    expect(request.mock.calls[0]?.[0]).toBe("https://notes.example.test/api/v2/pairing/exchange");
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: "Bearer secret-token" });
  });

  it("exchanges a short code without inventing a challenge identifier", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      device: { deviceId: "device-2", label: "iPad" },
      token: "short-code-token"
    }), { status: 201, headers: { "content-type": "application/json" } }));
    const client = new CompanionApiClient("https://notes.example.test", request);

    await client.exchangePairing({ userCode: "ABCD-2345" }, "iPad");

    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      userCode: "ABCD-2345",
      deviceLabel: "iPad"
    });
  });

  it("surfaces actionable one-time pairing errors", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: "challenge_expired"
    }), { status: 400, headers: { "content-type": "application/json" } }));
    const client = new CompanionApiClient("https://notes.example.test", request);

    await expect(client.exchangePairing({ userCode: "ABCD-2345" }, "iPad")).rejects.toMatchObject({
      code: "challenge_expired",
      message: "这组配对码已经过期，请在电脑端刷新。"
    });
  });

  it("surfaces 304 and expired authorization distinctly", async () => {
    const target = { notebookId: "analysis", sessionId: "lecture", title: "Lecture" };
    const notModified = new CompanionApiClient(
      "https://notes.example.test",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 304 }))
    );
    await expect(notModified.fetchManifest("token", target, "revision")).rejects.toBeInstanceOf(NotModifiedError);

    const unauthorized = new CompanionApiClient(
      "https://notes.example.test",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" }
      }))
    );
    await expect(unauthorized.verify("old-token")).rejects.toMatchObject({
      status: 401,
      code: "unauthorized"
    } satisfies Partial<CompanionApiError>);
  });

  it("uploads a queued image with the authenticated multipart contract", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      uploadId: "upload-1",
      duplicate: false,
      assetPath: "assets/photos/board.jpg",
      imageBlockId: "0002",
      transcriptBlockId: "0003",
      recognitionJobId: "recognition-1",
      recognitionStatus: "running"
    }));
    const client = new CompanionApiClient("https://notes.example.test", request);
    const task: UploadTask = {
      id: "capture-1",
      version: 1,
      profileId: "device-1",
      kind: "image",
      fileName: "board.jpg",
      mimeType: "image/jpeg",
      byteLength: 5,
      bytes: new Blob(["photo"], { type: "image/jpeg" }),
      notebookId: "analysis",
      notebookTitle: "泛函分析",
      sessionId: "lecture",
      sessionTitle: "第 3 讲",
      createdAt: "2026-07-26T08:00:00.000Z",
      updatedAt: "2026-07-26T08:00:00.000Z",
      attempts: 0,
      status: "pending"
    };

    await expect(client.uploadMaterial("token", "device-1", task)).resolves.toEqual({
      uploadId: "upload-1",
      duplicate: false,
      assetPath: "assets/photos/board.jpg",
      imageBlockId: "0002",
      transcriptBlockId: "0003",
      recognitionJobId: "recognition-1",
      recognitionStatus: "running",
      recognitionWarnings: undefined
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe("https://notes.example.test/api/v1/uploads");
    const init = request.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ authorization: "Bearer token" });
    const body = init?.body as FormData;
    expect(body.get("notebookId")).toBe("analysis");
    expect(body.get("sessionId")).toBe("lecture");
    expect(body.get("materialType")).toBe("image");
    expect(body.get("captureId")).toBe("capture-1");
    expect(body.get("deviceId")).toBe("device-1");
    expect(body.get("byteLength")).toBe("5");
    expect(body.get("material")).toBeInstanceOf(Blob);
  });

  it("bounds a stalled revision check and names the failed stage", async () => {
    const request = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
        once: true
      });
    }));
    const client = new CompanionApiClient("https://notes.example.test", request, 5);

    await expect(client.fetchManifest(
      "token",
      { notebookId: "analysis", sessionId: "lecture", title: "Lecture" },
      "revision"
    )).rejects.toMatchObject({
      code: "request_timeout",
      message: "修订检查超过 1 秒仍未完成，请确认电脑端 MathNotes 正在运行后重试。"
    } satisfies Partial<CompanionApiError>);
  });

  it("reads recognition progress and starts an authorized retry", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        uploadId: "upload-1",
        duplicate: false,
        recognitionJobId: "recognition-1",
        recognitionStatus: "failed",
        warnings: ["provider unavailable"]
      }))
      .mockResolvedValueOnce(Response.json({
        uploadId: "upload-1",
        duplicate: false,
        recognitionJobId: "recognition-1",
        recognitionStatus: "pending"
      }, { status: 202 }));
    const client = new CompanionApiClient("https://notes.example.test", request);

    await expect(client.fetchUploadStatus("token", "upload-1")).resolves.toMatchObject({
      recognitionStatus: "failed",
      recognitionWarnings: ["provider unavailable"]
    });
    await expect(client.retryRecognition("token", "upload-1")).resolves.toMatchObject({
      recognitionStatus: "pending"
    });

    expect(request.mock.calls[0]?.[0]).toBe(
      "https://notes.example.test/api/v1/uploads/status?uploadId=upload-1"
    );
    expect(request.mock.calls[1]?.[0]).toBe(
      "https://notes.example.test/api/v1/uploads/retry-recognition"
    );
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: "Bearer token",
      "content-type": "application/json"
    });
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({ uploadId: "upload-1" });
  });

  it("reports an SSE connection as live as soon as response headers are accepted", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
        controller.close();
      }
    });
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }));
    const onOpen = vi.fn();

    await new CompanionApiClient("https://notes.example.test", request).stream(
      "/api/v1/companion/catalog-events",
      "token",
      {
        signal: new AbortController().signal,
        onOpen,
        onMessage: vi.fn()
      }
    );

    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
