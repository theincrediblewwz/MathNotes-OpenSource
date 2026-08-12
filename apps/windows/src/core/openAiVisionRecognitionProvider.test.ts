import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenAIVisionRecognitionProvider } from "./openAiVisionRecognitionProvider";

describe("OpenAIVisionRecognitionProvider", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-openai-provider-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("sends a faithful markdown transcription request with image data URLs", async () => {
    const imagePath = join(rootDir, "blackboard.jpg");
    await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const provider = new OpenAIVisionRecognitionProvider({
      apiKey: "test_key",
      model: "gpt-4.1-mini",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ output_text: "## 忠实转写\n\n$T_n \\to T$" }), { status: 200 });
      }
    });

    const result = await provider.transcribe({
      imagePaths: [imagePath],
      mode: "faithful",
      outputFormat: "markdown",
      sessionId: "lecture"
    });

    expect(result.markdown).toContain("## 忠实转写");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer test_key",
        "Content-Type": "application/json"
      })
    );

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("gpt-4.1-mini");
    expect(body.input[0].role).toBe("user");
    expect(body.input[0].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "input_text",
          text: expect.stringMatching(/忠实转写为 Markdown/)
        }),
        expect.objectContaining({
          type: "input_image",
          image_url: "data:image/jpeg;base64,/9j/2Q=="
        })
      ])
    );
    expect(body.input[0].content[0].text).toMatch(/不要总结、润色、改写或补充证明/);
    expect(body.input[0].content[0].text).toMatch(/边框、浅色背景或输入框/);
  });

  it("throws a readable error when OpenAI returns an error response", async () => {
    const imagePath = join(rootDir, "blackboard.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const provider = new OpenAIVisionRecognitionProvider({
      apiKey: "test_key",
      model: "gpt-4.1-mini",
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "bad image" } }), { status: 400 })
    });

    await expect(
      provider.transcribe({
        imagePaths: [imagePath],
        mode: "faithful",
        outputFormat: "markdown"
      })
    ).rejects.toThrow(/OpenAI vision transcription failed: 400 bad image/);
  });

  it("emits runtime events around OpenAI Responses vision requests", async () => {
    const imagePath = join(rootDir, "blackboard.jpg");
    await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const provider = new OpenAIVisionRecognitionProvider({
      apiKey: "test_key",
      model: "gpt-4.1-mini",
      fetchImpl: async () =>
        new Response(JSON.stringify({ output_text: "### OpenAI 转写" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    });
    const events: string[] = [];

    await expect(
      provider.transcribeWithEvents?.({
        imagePaths: [imagePath],
        mode: "faithful",
        outputFormat: "markdown",
        onEvent: (event) => {
          if (event.type === "started" || event.type === "completed") {
            events.push(`${event.type}:${event.message}`);
          } else {
            events.push(`${event.type}:${event.text}`);
          }
        }
      })
    ).resolves.toEqual({
      markdown: "### OpenAI 转写",
      rawResponse: expect.any(String)
    });

    expect(events).toEqual([
      "started:OpenAI Vision API 请求已创建：model=gpt-4.1-mini，images=1。",
      "stderr:OpenAI Vision API 响应：HTTP 200。",
      "completed:OpenAI Vision API 响应已解析，Markdown 草稿已生成。"
    ]);
  });

  it("streams output_text deltas into stdout events", async () => {
    const imagePath = join(rootDir, "blackboard.jpg");
    await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const encoder = new TextEncoder();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const provider = new OpenAIVisionRecognitionProvider({
      apiKey: "test_key",
      model: "gpt-4.1-mini",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  [
                    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"## "}',
                    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"转写"}',
                    'event: response.output_text.done\ndata: {"type":"response.output_text.done","text":"## 转写"}',
                    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}',
                    "data: [DONE]",
                    ""
                  ].join("\n\n")
                )
              );
              controller.close();
            }
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        );
      }
    });
    const events: string[] = [];

    await expect(
      provider.transcribeWithEvents({
        imagePaths: [imagePath],
        mode: "faithful",
        outputFormat: "markdown",
        onEvent: (event) => {
          if (event.type === "stdout" || event.type === "stderr") {
            events.push(`${event.type}:${event.text}`);
          } else {
            events.push(`${event.type}:${event.message}`);
          }
        }
      })
    ).resolves.toEqual({
      markdown: "## 转写",
      rawResponse: expect.stringContaining("response.output_text.delta")
    });

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_obfuscation: false });
    expect(events).toEqual([
      "started:OpenAI Vision API 请求已创建：model=gpt-4.1-mini，images=1。",
      "stderr:OpenAI Vision API 响应：HTTP 200。",
      "stdout:## ",
      "stdout:转写",
      "completed:OpenAI Vision API 流式响应已完成，Markdown 草稿已生成。"
    ]);
  });
});
