import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenAICompatibleVisionProvider } from "./openAiCompatibleVisionProvider";

describe("OpenAICompatibleVisionProvider", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-compatible-provider-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("sends a chat-completions vision request with faithful markdown instructions", async () => {
    const imagePath = join(rootDir, "blackboard.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const provider = new OpenAICompatibleVisionProvider({
      name: "glm_5_2",
      apiKey: "glm_key",
      baseUrl: "https://example.test/chat/completions",
      model: "glm-5.2",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ choices: [{ message: { content: "## 转写\n\n$T_n$" } }] }), { status: 200 });
      }
    });

    const result = await provider.transcribe({
      imagePaths: [imagePath],
      mode: "faithful",
      outputFormat: "markdown",
      context: "泛函分析第 3 讲"
    });

    expect(result.markdown).toContain("## 转写");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://example.test/chat/completions");
    expect(calls[0].init.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer glm_key",
        "Content-Type": "application/json"
      })
    );

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("glm-5.2");
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringMatching(/忠实转写为 Markdown/)
        }),
        expect.objectContaining({
          type: "image_url",
          image_url: {
            url: "data:image/png;base64,iVBORw=="
          }
        })
      ])
    );
  });

  it("extracts text from content-array compatible responses", async () => {
    const imagePath = join(rootDir, "blackboard.jpg");
    await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const provider = new OpenAICompatibleVisionProvider({
      name: "mimo_2_5",
      apiKey: "mimo_key",
      baseUrl: "https://example.test/v1/chat/completions",
      model: "mimo-v2.5",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: [{ type: "text", text: "### MiMo 转写" }] } }]
          }),
          { status: 200 }
        )
    });

    await expect(
      provider.transcribe({
        imagePaths: [imagePath],
        mode: "faithful",
        outputFormat: "markdown"
      })
    ).resolves.toEqual({
      markdown: "### MiMo 转写",
      rawResponse: expect.any(String)
    });
  });

  it("uses MiMo's api-key header instead of OpenAI bearer auth", async () => {
    const imagePath = join(rootDir, "blackboard.jpg");
    await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const calls: Array<{ init: RequestInit }> = [];
    const provider = new OpenAICompatibleVisionProvider({
      name: "mimo_2_5",
      apiKey: "mimo_key",
      baseUrl: "https://example.test/v1/chat/completions",
      model: "mimo-v2.5",
      fetchImpl: async (_url, init) => {
        calls.push({ init });
        return new Response(JSON.stringify({ choices: [{ message: { content: "### MiMo 转写" } }] }), { status: 200 });
      }
    });

    await provider.transcribe({
      imagePaths: [imagePath],
      mode: "faithful",
      outputFormat: "markdown"
    });

    expect(calls[0].init.headers).toEqual(
      expect.objectContaining({
        "api-key": "mimo_key",
        "Content-Type": "application/json"
      })
    );
    expect(calls[0].init.headers).not.toEqual(expect.objectContaining({ Authorization: expect.any(String) }));
  });

  it("accepts a base URL and calls the chat-completions endpoint", async () => {
    const imagePath = join(rootDir, "blackboard.jpg");
    await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const calls: Array<{ url: string }> = [];
    const provider = new OpenAICompatibleVisionProvider({
      name: "mimo_2_5",
      apiKey: "mimo_key",
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: "mimo-v2.5",
      fetchImpl: async (url) => {
        calls.push({ url });
        return new Response(JSON.stringify({ choices: [{ message: { content: "### MiMo 转写" } }] }), { status: 200 });
      }
    });

    await provider.transcribe({
      imagePaths: [imagePath],
      mode: "faithful",
      outputFormat: "markdown"
    });

    expect(calls[0].url).toBe("https://api.xiaomimimo.com/v1/chat/completions");
  });

  it("emits API runtime events around compatible vision requests", async () => {
    const imagePath = join(rootDir, "blackboard.jpg");
    await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const provider = new OpenAICompatibleVisionProvider({
      name: "mimo_2_5",
      apiKey: "mimo_key",
      baseUrl: "https://example.test/v1/chat/completions",
      model: "mimo-v2.5",
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "### MiMo 转写" } }] }), {
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
      markdown: "### MiMo 转写",
      rawResponse: expect.any(String)
    });

    expect(events).toEqual([
      "started:Mimo v2.5 API 请求已创建：model=mimo-v2.5，endpoint=https://example.test/v1/chat/completions，images=1。",
      "stderr:Mimo v2.5 API 响应：HTTP 200。",
      "completed:Mimo v2.5 API 响应已解析，Markdown 草稿已生成。"
    ]);
  });

  it("passes abort signals into compatible API fetch calls", async () => {
    const imagePath = join(rootDir, "blackboard.jpg");
    await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const abortController = new AbortController();
    const calls: Array<{ init: RequestInit }> = [];
    const provider = new OpenAICompatibleVisionProvider({
      name: "mimo_2_5",
      apiKey: "mimo_key",
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: "mimo-v2.5",
      fetchImpl: async (_url, init) => {
        calls.push({ init });
        return new Response(JSON.stringify({ choices: [{ message: { content: "### MiMo 转写" } }] }), { status: 200 });
      }
    });

    await provider.transcribe({
      imagePaths: [imagePath],
      mode: "faithful",
      outputFormat: "markdown",
      abortSignal: abortController.signal
    });

    expect(calls[0].init.signal).toBe(abortController.signal);
  });

  it("streams chat-completions delta content into runtime stdout events", async () => {
    const imagePath = join(rootDir, "blackboard.jpg");
    await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const calls: Array<{ init: RequestInit }> = [];
    const provider = new OpenAICompatibleVisionProvider({
      name: "mimo_2_5",
      apiKey: "mimo_key",
      baseUrl: "https://example.test/v1/chat/completions",
      model: "mimo-v2.5",
      fetchImpl: async (_url, init) => {
        calls.push({ init });
        return new Response(
          [
            'data: {"choices":[{"delta":{"content":"## "}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"MiMo"}}]}\n\n',
            'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n"
          ].join(""),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          }
        );
      }
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
      markdown: "## MiMo",
      rawResponse: expect.stringContaining('"delta"')
    });

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.stream).toBe(true);
    expect(events).toEqual([
      "started:Mimo v2.5 API 请求已创建：model=mimo-v2.5，endpoint=https://example.test/v1/chat/completions，images=1。",
      "stderr:Mimo v2.5 API 响应：HTTP 200。",
      "stdout:## ",
      "stdout:MiMo",
      "completed:Mimo v2.5 API 流式响应已完成，Markdown 草稿已生成。"
    ]);
  });

  it("uses the canonical text content shape for assistant turns without raster evidence", async () => {
    const calls: Array<{ body: string }> = [];
    const provider = new OpenAICompatibleVisionProvider({
      name: "mimo_2_5",
      apiKey: "mimo_key",
      baseUrl: "https://example.test/v1",
      model: "mimo-v2.5",
      fetchImpl: async (_url, init) => {
        calls.push({ body: String(init.body) });
        return new Response(JSON.stringify({ choices: [{ message: { content: "## 解读" } }] }), { status: 200 });
      }
    });

    await provider.assist({ mode: "explain", markdownContext: "# 笔记", imagePaths: [] });

    const body = JSON.parse(calls[0].body) as { messages: Array<{ content: unknown }> };
    expect(typeof body.messages[0].content).toBe("string");
    expect(body.messages[0].content).toContain("MathNotes 的独立学习助手");
  });

  it("throws a readable provider-specific error", async () => {
    const imagePath = join(rootDir, "blackboard.webp");
    await writeFile(imagePath, Buffer.from([0x52, 0x49, 0x46, 0x46]));
    const provider = new OpenAICompatibleVisionProvider({
      name: "glm_5_2",
      apiKey: "glm_key",
      baseUrl: "https://example.test/chat/completions",
      model: "glm-5.2",
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "vision disabled" } }), { status: 400 })
    });

    await expect(
      provider.transcribe({
        imagePaths: [imagePath],
        mode: "faithful",
        outputFormat: "markdown"
      })
    ).rejects.toThrow(/glm_5_2 转写 failed: 400 vision disabled/);
  });
});
