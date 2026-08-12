import type { AssistantProvider, RecognitionProvider } from "@mathnotes/shared";

export class MockRecognitionProvider implements RecognitionProvider, AssistantProvider {
  readonly name = "mock";

  async transcribe(input: Parameters<RecognitionProvider["transcribe"]>[0]): ReturnType<RecognitionProvider["transcribe"]> {
    return {
      markdown: [
        "#### Mock 识别占位",
        "",
        "当前任务使用的是 mock provider，因此这里不是真实 OCR/GPT 识别结果。",
        "请在识别服务中选择 Codex CLI、OpenAI Vision、GLM 或 MiMo 后重新导入或重试。",
        "",
        "[mock_provider_used]"
      ].join("\n"),
      warnings: ["mock_provider_used"],
      rawResponse: JSON.stringify({
        provider: this.name,
        mode: input.mode,
        outputFormat: input.outputFormat,
        sessionId: input.sessionId
      })
    };
  }

  async assist(input: Parameters<AssistantProvider["assist"]>[0]): ReturnType<AssistantProvider["assist"]> {
    return {
      markdown: [
        "## Mock 学习助手",
        "",
        `模式：${input.mode}`,
        "",
        "这是本地管线占位结果，没有调用外部模型，也没有修改原笔记。",
        input.question?.trim() ? `\n用户问题：${input.question.trim()}` : "",
        "",
        "[mock_assistant_used]"
      ].filter(Boolean).join("\n"),
      warnings: ["mock_assistant_used"]
    };
  }
}
