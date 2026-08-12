import type { AssistantProvider, RecognitionProvider, RecognitionProviderEvent, RecognitionResult } from "@mathnotes/shared";
import { buildAssistantPrompt } from "../domain/assistantPrompt";
import { buildFaithfulTranscriptionPrompt } from "../domain/faithfulTranscriptionPrompt";
import { imagePathToDataUrl } from "./imageDataUrl";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type OpenAICompatibleVisionProviderArgs = {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  promptTemplateContent?: string;
  promptTemplateContentProvider?: () => string;
  notationGuidanceProvider?: (context: string) => string;
  fetchImpl?: FetchLike;
};

export class OpenAICompatibleVisionProvider implements RecognitionProvider, AssistantProvider {
  readonly name: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly args: OpenAICompatibleVisionProviderArgs) {
    this.name = args.name;
    this.fetchImpl = args.fetchImpl ?? fetch;
  }

  async transcribe(input: Parameters<RecognitionProvider["transcribe"]>[0]): ReturnType<RecognitionProvider["transcribe"]> {
    return this.transcribeWithEvents({
      ...input,
      onEvent: () => undefined
    });
  }

  async transcribeWithEvents(
    input: Parameters<NonNullable<RecognitionProvider["transcribeWithEvents"]>>[0]
  ): ReturnType<RecognitionProvider["transcribe"]> {
    return this.runWithEvents({
      imagePaths: input.imagePaths,
      abortSignal: input.abortSignal,
      onEvent: input.onEvent,
      prompt: buildFaithfulTranscriptionPrompt(
        input.context,
        this.args.promptTemplateContentProvider?.() ?? this.args.promptTemplateContent,
        this.args.notationGuidanceProvider?.(input.context ?? "")
      ),
      taskLabel: "转写"
    });
  }

  async assist(input: Parameters<AssistantProvider["assist"]>[0]): ReturnType<AssistantProvider["assist"]> {
    return this.assistWithEvents({ ...input, onEvent: () => undefined });
  }

  async assistWithEvents(
    input: Parameters<NonNullable<AssistantProvider["assistWithEvents"]>>[0]
  ): ReturnType<AssistantProvider["assist"]> {
    return this.runWithEvents({
      imagePaths: input.imagePaths,
      abortSignal: input.abortSignal,
      onEvent: input.onEvent,
      prompt: buildAssistantPrompt(input),
      taskLabel: "学习助手"
    });
  }

  private async runWithEvents(input: {
    imagePaths: string[];
    abortSignal?: AbortSignal;
    onEvent: (event: RecognitionProviderEvent) => void;
    prompt: string;
    taskLabel: string;
  }): Promise<RecognitionResult> {
    const label = providerDisplayLabel(this.args.name);
    const endpoint = chatCompletionsUrl(this.args.baseUrl);
    input.onEvent({
      type: "started",
      message: `${label} API 请求已创建：model=${this.args.model}，endpoint=${endpoint}，images=${input.imagePaths.length}。`
    });

    const multimodalContent = [
      {
        type: "text",
        text: input.prompt
      },
      ...(await Promise.all(
        input.imagePaths.map(async (imagePath) => ({
          type: "image_url",
          image_url: {
            url: await imagePathToDataUrl(imagePath)
          }
        }))
      ))
    ];
    // Some compatible endpoints reject a multimodal content array when the
    // request contains no images. Use the canonical text-only shape then.
    const content = input.imagePaths.length === 0 ? input.prompt : multimodalContent;

    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: buildCompatibleProviderHeaders(this.args.name, this.args.apiKey),
      signal: input.abortSignal,
      body: JSON.stringify({
        model: this.args.model,
        stream: true,
        messages: [
          {
            role: "user",
            content
          }
        ]
      })
    });
    input.onEvent({ type: "stderr", text: `${label} API 响应：HTTP ${response.status}。` });

    if (response.ok && isEventStreamResponse(response)) {
      return readChatCompletionsEventStream(response, input.onEvent, label, input.taskLabel);
    }

    const rawResponse = await response.text();
    if (!response.ok) {
      const message = `${this.args.name} ${input.taskLabel} failed: ${response.status} ${extractErrorMessage(rawResponse)}`;
      input.onEvent({ type: "stderr", text: message });
      throw new Error(message);
    }

    const parsed = JSON.parse(rawResponse) as ChatCompletionResponse;
    input.onEvent({
      type: "completed",
      message: `${label} API 响应已解析，${completionLabel(input.taskLabel)}`
    });
    return {
      markdown: extractChoiceText(parsed, this.args.name),
      rawResponse
    };
  }
}

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
};

type ChatCompletionStreamEvent = {
  choices?: Array<{
    delta?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
    finish_reason?: string | null;
  }>;
  error?: {
    message?: string;
  };
};

async function readChatCompletionsEventStream(
  response: Response,
  onEvent: Parameters<NonNullable<RecognitionProvider["transcribeWithEvents"]>>[0]["onEvent"],
  label: string,
  taskLabel = "转写"
): ReturnType<RecognitionProvider["transcribe"]> {
  if (!response.body) {
    throw new Error(`${label} transcription failed: streaming response did not include a body`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const rawEvents: string[] = [];
  let buffer = "";
  let markdown = "";

  const handleEventBlock = (block: string) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n")
      .trim();

    if (!data || data === "[DONE]") {
      return;
    }

    rawEvents.push(data);
    const parsed = JSON.parse(data) as ChatCompletionStreamEvent;
    if (parsed.error?.message) {
      onEvent({ type: "stderr", text: parsed.error.message });
      throw new Error(parsed.error.message);
    }

    const delta = extractDeltaContent(parsed);
    if (delta) {
      markdown += delta;
      onEvent({ type: "stdout", text: delta });
    }
  };

  const drainBuffer = () => {
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      handleEventBlock(block);
      boundary = buffer.indexOf("\n\n");
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    drainBuffer();
    if (done) break;
  }

  if (buffer.trim()) {
    handleEventBlock(buffer);
  }

  const result = markdown.trim();
  if (!result) {
    throw new Error(`${label} transcription response did not include message content`);
  }

  onEvent({
    type: "completed",
    message: `${label} API 流式响应已完成，${completionLabel(taskLabel)}`
  });
  return {
    markdown: result,
    rawResponse: rawEvents.join("\n")
  };
}

function completionLabel(taskLabel: string): string {
  return taskLabel === "转写" ? "Markdown 草稿已生成。" : `${taskLabel} Markdown 已生成。`;
}

function extractDeltaContent(response: ChatCompletionStreamEvent): string {
  const content = response.choices?.[0]?.delta?.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => item.text)
      .filter(Boolean)
      .join("");
  }

  return "";
}

function extractChoiceText(response: ChatCompletionResponse, providerName: string): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content.map((item) => item.text).filter(Boolean).join("\n\n").trim();
    if (text) return text;
  }

  throw new Error(`${providerName} transcription response did not include message content`);
}

function extractErrorMessage(rawResponse: string): string {
  try {
    const parsed = JSON.parse(rawResponse) as { error?: { message?: string } };
    return parsed.error?.message ?? rawResponse;
  } catch {
    return rawResponse;
  }
}

export function buildCompatibleProviderHeaders(providerId: string, apiKey: string): Record<string, string> {
  if (providerId === "mimo_2_5") {
    return {
      "api-key": apiKey,
      "Content-Type": "application/json"
    };
  }

  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
}

export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed || /\/chat\/completions$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

function isEventStreamResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
}

function providerDisplayLabel(providerName: string): string {
  if (providerName === "mimo_2_5") return "Mimo v2.5";
  if (providerName === "glm_5_2") return "GLM 5.2";
  return providerName;
}
