import type { AssistantProvider, RecognitionProvider, RecognitionProviderEvent, RecognitionResult } from "@mathnotes/shared";
import { buildAssistantPrompt } from "./assistantPrompt";
import { buildFaithfulTranscriptionPrompt } from "./faithfulTranscriptionPrompt";
import { imagePathToDataUrl } from "./imageDataUrl";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type OpenAIVisionRecognitionProviderArgs = {
  apiKey: string;
  model: string;
  promptTemplateContent?: string;
  fetchImpl?: FetchLike;
};

export class OpenAIVisionRecognitionProvider implements RecognitionProvider, AssistantProvider {
  readonly name = "openai_vision";
  private readonly fetchImpl: FetchLike;

  constructor(private readonly args: OpenAIVisionRecognitionProviderArgs) {
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
      prompt: buildFaithfulTranscriptionPrompt(input.context, this.args.promptTemplateContent),
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
    input.onEvent({
      type: "started",
      message: `OpenAI Vision API 请求已创建：model=${this.args.model}，images=${input.imagePaths.length}。`
    });

    const content = [
      {
        type: "input_text",
        text: input.prompt
      },
      ...(await Promise.all(
        input.imagePaths.map(async (imagePath) => ({
          type: "input_image",
          image_url: await imagePathToDataUrl(imagePath)
        }))
      ))
    ];

    const response = await this.fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.args.apiKey}`,
        "Content-Type": "application/json"
      },
      signal: input.abortSignal,
      body: JSON.stringify({
        model: this.args.model,
        stream: true,
        stream_options: {
          include_obfuscation: false
        },
        input: [
          {
            role: "user",
            content
          }
        ]
      })
    });
    input.onEvent({ type: "stderr", text: `OpenAI Vision API 响应：HTTP ${response.status}。` });

    if (response.ok && isEventStreamResponse(response)) {
      return readResponsesEventStream(response, input.onEvent, input.taskLabel);
    }

    const rawResponse = await response.text();
    if (!response.ok) {
      const message = `OpenAI vision transcription failed: ${response.status} ${extractErrorMessage(rawResponse)}`;
      input.onEvent({ type: "stderr", text: message });
      throw new Error(message);
    }

    const parsed = JSON.parse(rawResponse) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    input.onEvent({
      type: "completed",
      message: `OpenAI Vision API 响应已解析，${completionLabel(input.taskLabel)}`
    });
    return {
      markdown: extractOutputText(parsed),
      rawResponse
    };
  }
}

async function readResponsesEventStream(
  response: Response,
  onEvent: Parameters<NonNullable<RecognitionProvider["transcribeWithEvents"]>>[0]["onEvent"],
  taskLabel = "转写"
): ReturnType<RecognitionProvider["transcribe"]> {
  if (!response.body) {
    throw new Error("OpenAI vision transcription failed: streaming response did not include a body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const rawEvents: string[] = [];
  let buffer = "";
  let markdown = "";
  let finalText = "";

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
    const parsed = JSON.parse(data) as ResponsesStreamEvent;
    if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
      markdown += parsed.delta;
      onEvent({ type: "stdout", text: parsed.delta });
      return;
    }

    if (parsed.type === "response.output_text.done" && typeof parsed.text === "string") {
      finalText = parsed.text;
      return;
    }

    if (parsed.type === "error" || parsed.type === "response.failed") {
      const message = eventErrorMessage(parsed);
      onEvent({ type: "stderr", text: message });
      throw new Error(message);
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
    if (done) {
      break;
    }
  }

  if (buffer.trim()) {
    handleEventBlock(buffer);
  }

  const result = (finalText || markdown).trim();
  if (!result) {
    throw new Error("OpenAI vision transcription response did not include output_text");
  }

  onEvent({
    type: "completed",
    message: `OpenAI Vision API 流式响应已完成，${completionLabel(taskLabel)}`
  });
  return {
    markdown: result,
    rawResponse: rawEvents.join("\n")
  };
}

function completionLabel(taskLabel: string): string {
  return taskLabel === "转写" ? "Markdown 草稿已生成。" : `${taskLabel} Markdown 已生成。`;
}

type ResponsesStreamEvent =
  | {
      type?: "response.output_text.delta";
      delta?: string;
    }
  | {
      type?: "response.output_text.done";
      text?: string;
    }
  | {
      type?: "response.failed";
      response?: {
        error?: {
          message?: string;
        };
      };
    }
  | {
      type?: "error";
      message?: string;
      error?: {
        message?: string;
      };
    }
  | {
      type?: string;
      [key: string]: unknown;
    };

function isEventStreamResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
}

function eventErrorMessage(event: ResponsesStreamEvent): string {
  const message = readStringProperty(event, "message");
  if (message) {
    return `OpenAI vision transcription failed: ${message}`;
  }
  const error = readObjectProperty(event, "error");
  const errorMessage = error ? readStringProperty(error, "message") : "";
  if (errorMessage) {
    return `OpenAI vision transcription failed: ${errorMessage}`;
  }
  const response = readObjectProperty(event, "response");
  const responseError = response ? readObjectProperty(response, "error") : null;
  const responseErrorMessage = responseError ? readStringProperty(responseError, "message") : "";
  if (responseErrorMessage) {
    return `OpenAI vision transcription failed: ${responseErrorMessage}`;
  }
  return "OpenAI vision transcription failed: streaming response failed";
}

function readObjectProperty(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === "object" ? (nested as Record<string, unknown>) : null;
}

function readStringProperty(value: unknown, key: string): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "string" ? nested : "";
}

function extractOutputText(response: { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> }): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }

  const text = response.output?.flatMap((item) => item.content ?? []).map((content) => content.text).find(Boolean);
  if (text) {
    return text;
  }

  throw new Error("OpenAI vision transcription response did not include output_text");
}

function extractErrorMessage(rawResponse: string): string {
  try {
    const parsed = JSON.parse(rawResponse) as { error?: { message?: string } };
    return parsed.error?.message ?? rawResponse;
  } catch {
    return rawResponse;
  }
}
