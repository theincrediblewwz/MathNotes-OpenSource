import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecognitionProvider } from "@mathnotes/shared";
import type { RecognitionProviderConfig } from "./providerConfigStore";
import { runProviderTurnAcceptance } from "./providerTurnAcceptance";

describe("runProviderTurnAcceptance", () => {
  let rootDir: string;
  let imagePath: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-provider-turn-"));
    imagePath = join(rootDir, "board.png");
    await writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("runs the full ingest queue and export path while writing a sanitized report", async () => {
    const provider: RecognitionProvider = {
      name: "mimo_2_5",
      async transcribe() {
        throw new Error("transcribe should not be used for streaming acceptance");
      },
      async transcribeWithEvents(input) {
        input.onEvent({ type: "started", message: "request started" });
        input.onEvent({ type: "stdout", text: "## 定理\n" });
        input.onEvent({ type: "stdout", text: "\\(x^2\\)\n" });
        return { markdown: "## 定理\n\n\\(x^2\\)" };
      }
    };
    const providerConfig = mimoProviderConfig();

    const report = await runProviderTurnAcceptance({
      outputRoot: rootDir,
      imagePath,
      provider,
      providerConfig,
      now: "2026-07-10T12:00:00.000Z"
    });

    expect(report).toMatchObject({
      version: 1,
      provider: {
        id: "mimo_2_5",
        label: "Mimo v2.5",
        model: "mimo-v2.5",
        endpoint: "https://api.example.test/v1/chat/completions"
      },
      result: {
        status: "succeeded"
      }
    });
    expect(report.timing.firstTokenMs).toBeTypeOf("number");
    expect(report.timing.elapsedMs).toBeGreaterThanOrEqual(report.timing.firstTokenMs ?? 0);
    expect(report.stream.eventCount).toBeGreaterThan(0);
    expect(report.stream.previewUpdateCount).toBeGreaterThan(0);

    await expect(stat(report.artifacts.transcriptPath ?? "")).resolves.toBeTruthy();
    await expect(stat(report.artifacts.exportPath ?? "")).resolves.toBeTruthy();
    await expect(stat(report.artifacts.reportPath)).resolves.toBeTruthy();
    await expect(readFile(report.artifacts.exportPath ?? "", "utf8")).resolves.toContain("$x^2$");

    const serialized = await readFile(report.artifacts.reportPath, "utf8");
    expect(serialized).not.toContain("secret-key");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("?api_key=");
  });

  it("records output anomaly failures and still exports the diagnostic draft", async () => {
    const provider: RecognitionProvider = {
      name: "mimo_2_5",
      async transcribe() {
        throw new Error("transcribe should not be used for streaming acceptance");
      },
      async transcribeWithEvents(input) {
        for (let index = 0; index < 4; index += 1) {
          input.onEvent({
            type: "stdout",
            text: `${index === 0 ? "## 健康前缀\n" : ""}${"\\quad ".repeat(8)}`
          });
          if (input.abortSignal?.aborted) {
            throw new Error("provider stopped after abort");
          }
        }
        return { markdown: "provider ignored anomaly guard" };
      }
    };

    const report = await runProviderTurnAcceptance({
      outputRoot: rootDir,
      imagePath,
      provider,
      providerConfig: mimoProviderConfig(),
      now: "2026-07-10T12:05:00.000Z"
    });

    expect(report.result).toMatchObject({
      status: "failed",
      failureKind: "output_anomaly"
    });
    expect(report.stream.warningCount).toBeGreaterThan(0);
    await expect(readFile(report.artifacts.exportPath ?? "", "utf8")).resolves.toContain("异常输出已停止");
  });
});

function mimoProviderConfig(): RecognitionProviderConfig {
  return {
    providerId: "mimo_2_5",
    model: "mimo-v2.5",
    apiKey: "secret-key",
    apiKeyEnvVar: "MIMO_API_KEY",
    baseUrl: "https://api.example.test/v1/chat/completions?api_key=secret-key",
    commandPath: "",
    codexRuntime: "windows",
    wslDistro: "",
    status: "configured"
  };
}
