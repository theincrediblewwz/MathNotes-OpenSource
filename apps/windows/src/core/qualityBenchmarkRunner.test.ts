import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderTurnAcceptanceReport } from "./providerTurnAcceptance";
import type { ResolvedQualityBenchmarkManifest } from "./qualityBenchmarkManifest";
import { inspectQualityBenchmarkReuse, runQualityBenchmark } from "./qualityBenchmarkRunner";

describe("runQualityBenchmark", () => {
  let rootDir: string;
  let manifest: ResolvedQualityBenchmarkManifest;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-quality-runner-"));
    const imagePath = join(rootDir, "board.png");
    const goldMarkdownPath = join(rootDir, "board.md");
    await writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));
    await writeFile(goldMarkdownPath, "## 定理\n\n$$x^2$$\n", "utf8");
    manifest = {
      version: 1,
      manifestPath: join(rootDir, "benchmark.json"),
      label: "functional-analysis",
      repeats: 3,
      variant: "current-provider-settings",
      samples: [{
        id: "board-001",
        category: "dense-derivation",
        imagePath,
        goldMarkdownPath,
        imageFileName: "board.png",
        goldFileName: "board.md",
        imageSha256: "a".repeat(64),
        goldSha256: "b".repeat(64),
        goldStatus: "candidate"
      }]
    };
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("runs exactly three turns sequentially in sample and run order", async () => {
    const callOrder: string[] = [];
    let activeCalls = 0;
    let maxConcurrentCalls = 0;

    const report = await runQualityBenchmark({
      manifest,
      outputRoot: join(rootDir, "output"),
      provider: providerIdentity(),
      async runTurn(input) {
        callOrder.push(`${input.sample.id}:${input.runIndex}`);
        activeCalls += 1;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeCalls -= 1;
        return createTurnReport(await writeTranscript(input.runIndex));
      }
    });

    expect(callOrder).toEqual(["board-001:1", "board-001:2", "board-001:3"]);
    expect(maxConcurrentCalls).toBe(1);
    expect(report.summary).toMatchObject({ total: 3, succeeded: 3, failed: 0, skipped: 0 });
    expect(report.samples[0].runs).toHaveLength(3);
    expect(report.samples[0].metrics.contentSimilarity.mean).toBe(1);
  });

  it("resumes by skipping successful runs with the same fingerprint", async () => {
    const outputRoot = join(rootDir, "output");
    let firstCalls = 0;
    await runQualityBenchmark({
      manifest,
      outputRoot,
      provider: providerIdentity(),
      async runTurn(input) {
        firstCalls += 1;
        const turn = createTurnReport(await writeTranscript(input.runIndex));
        turn.artifacts.sessionDir = join(input.outputRoot, "session");
        turn.artifacts.exportPath = join(input.outputRoot, "export.md");
        turn.artifacts.reportPath = join(input.outputRoot, "report.json");
        return turn;
      }
    });

    let resumedCalls = 0;
    const resumed = await runQualityBenchmark({
      manifest,
      outputRoot,
      provider: providerIdentity(),
      async runTurn(input) {
        resumedCalls += 1;
        return createTurnReport(await writeTranscript(input.runIndex));
      }
    });

    expect(firstCalls).toBe(3);
    expect(resumedCalls).toBe(0);
    expect(resumed.summary).toMatchObject({ total: 3, succeeded: 3, failed: 0, skipped: 3 });
    expect(resumed.samples[0].runs[0].artifacts?.transcriptPath)
      .toBe("transcripts/board-001/1.md");
    expect(resumed.samples[0].runs[0].artifacts).toMatchObject({
      sessionDir: "provider-turns/board-001/1/session",
      exportPath: "provider-turns/board-001/1/export.md",
      reportPath: "provider-turns/board-001/1/report.json"
    });

    await expect(inspectQualityBenchmarkReuse({
      manifest,
      outputRoot,
      provider: providerIdentity()
    })).resolves.toEqual({ total: 3, reusable: 3, missing: 0 });
  });

  it("reports missing reusable evidence without creating files or calling a Provider", async () => {
    const outputRoot = join(rootDir, "missing-output");
    await expect(inspectQualityBenchmarkReuse({
      manifest,
      outputRoot,
      provider: providerIdentity()
    })).resolves.toEqual({ total: 3, reusable: 0, missing: 3 });
    await expect(readFile(join(outputRoot, "quality_benchmark_report.json"), "utf8")).rejects.toThrow();
  });

  it("does not reuse legacy records without an exact benchmark variant", async () => {
    const outputRoot = join(rootDir, "output");
    await runQualityBenchmark({
      manifest,
      outputRoot,
      provider: providerIdentity(),
      async runTurn(input) {
        return createTurnReport(await writeTranscript(input.runIndex));
      }
    });

    for (let runIndex = 1; runIndex <= 3; runIndex += 1) {
      const recordPath = join(outputRoot, "runs", "board-001", `${runIndex}.json`);
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      delete record.variant;
      await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    }
    manifest.variant = "changed-provider-settings";

    let providerCalls = 0;
    await runQualityBenchmark({
      manifest,
      outputRoot,
      provider: providerIdentity(),
      async runTurn(input) {
        providerCalls += 1;
        return createTurnReport(await writeTranscript(input.runIndex));
      }
    });

    expect(providerCalls).toBe(3);
  });

  it("rescoring changed Gold reuses successful provider transcripts without another call", async () => {
    const outputRoot = join(rootDir, "output");
    await runQualityBenchmark({
      manifest,
      outputRoot,
      provider: providerIdentity(),
      async runTurn(input) {
        return createTurnReport(await writeTranscript(input.runIndex));
      }
    });

    await writeFile(manifest.samples[0].goldMarkdownPath, "## 定理\n\n$$y^2$$\n", "utf8");
    manifest.samples[0].goldSha256 = "c".repeat(64);
    let providerCalls = 0;
    const rescored = await runQualityBenchmark({
      manifest,
      outputRoot,
      provider: providerIdentity(),
      async runTurn(input) {
        providerCalls += 1;
        return createTurnReport(await writeTranscript(input.runIndex));
      }
    });

    expect(providerCalls).toBe(0);
    expect(rescored.summary.skipped).toBe(3);
    expect(rescored.samples[0].goldSha256).toBe("c".repeat(64));
    expect(rescored.samples[0].metrics.contentSimilarity.mean).toBeLessThan(1);
  });

  it("recovers a successful run record left in the atomic replacement backup", async () => {
    const outputRoot = join(rootDir, "output");
    await runQualityBenchmark({
      manifest,
      outputRoot,
      provider: providerIdentity(),
      async runTurn(input) {
        return createTurnReport(await writeTranscript(input.runIndex));
      }
    });

    const recordPath = join(outputRoot, "runs", "board-001", "1.json");
    const transcriptPath = join(outputRoot, "transcripts", "board-001", "1.md");
    await rename(recordPath, `${recordPath}.bak`);
    await rename(transcriptPath, `${transcriptPath}.bak`);
    let providerCalls = 0;
    const resumed = await runQualityBenchmark({
      manifest,
      outputRoot,
      provider: providerIdentity(),
      async runTurn(input) {
        providerCalls += 1;
        return createTurnReport(await writeTranscript(input.runIndex));
      }
    });

    expect(providerCalls).toBe(0);
    expect(resumed.summary.skipped).toBe(3);
    await expect(readFile(recordPath, "utf8")).resolves.toContain('"status": "succeeded"');
  });

  it("records one failed run without deleting successful evidence", async () => {
    const report = await runQualityBenchmark({
      manifest,
      outputRoot: join(rootDir, "output"),
      provider: providerIdentity(),
      async runTurn(input) {
        if (input.runIndex === 2) throw new Error("network disconnected");
        return createTurnReport(await writeTranscript(input.runIndex));
      }
    });

    expect(report.summary).toMatchObject({ total: 3, succeeded: 2, failed: 1 });
    expect(report.samples[0].runs.map((run) => run.status)).toEqual(["succeeded", "runner_failed", "succeeded"]);
  });

  it("excludes failed turns from aggregate quality metrics", async () => {
    const report = await runQualityBenchmark({
      manifest,
      outputRoot: join(rootDir, "output"),
      provider: providerIdentity(),
      async runTurn(input) {
        const transcriptPath = await writeTranscript(input.runIndex);
        const turn = createTurnReport(transcriptPath);
        if (input.runIndex === 2) {
          await writeFile(transcriptPath, "completely wrong", "utf8");
          turn.result.status = "failed";
        }
        return turn;
      }
    });

    expect(report.summary).toMatchObject({ succeeded: 2, failed: 1 });
    expect(report.samples[0].metrics.contentSimilarity.mean).toBe(1);
  });

  it("writes JSON and Markdown aggregates without Gold bodies, endpoint queries, or redacted values", async () => {
    const secret = "super-secret-key";
    const outputRoot = join(rootDir, "output");
    const report = await runQualityBenchmark({
      manifest,
      outputRoot,
      provider: { ...providerIdentity(), endpoint: "https://api.example.test/v1?api_key=leak" },
      sensitiveValues: [secret],
      async runTurn(input) {
        if (input.runIndex === 2) throw new Error(`Bearer ${secret}`);
        return createTurnReport(await writeTranscript(input.runIndex));
      }
    });

    const json = await readFile(join(outputRoot, report.artifacts.jsonReportPath), "utf8");
    const markdown = await readFile(join(outputRoot, report.artifacts.markdownReportPath), "utf8");
    for (const serialized of [json, markdown]) {
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("api_key=leak");
      expect(serialized).not.toContain("$$x^2$$");
      expect(serialized).not.toContain(rootDir);
      expect(serialized).not.toContain("C:/private/provider-turn");
    }
    expect(report.provider.endpoint).toBe("https://api.example.test/v1");
  });

  async function writeTranscript(runIndex: number): Promise<string> {
    const path = join(rootDir, `transcript-${runIndex}.md`);
    await writeFile(path, "## 定理\n\n$$x^2$$\n", "utf8");
    return path;
  }
});

function providerIdentity() {
  return {
    id: "mimo_2_5",
    label: "Mimo v2.5",
    model: "mimo-v2.5",
    endpoint: "https://api.example.test/v1"
  };
}

function createTurnReport(transcriptPath: string): ProviderTurnAcceptanceReport {
  return {
    version: 1,
    provider: providerIdentity(),
    timing: { startedAt: "2026-07-11T00:00:00.000Z", firstTokenMs: 5, elapsedMs: 10 },
    stream: { eventCount: 3, warningCount: 0, previewUpdateCount: 2 },
    result: { status: "succeeded", warnings: [] },
    artifacts: {
      sessionDir: "C:/private/provider-turn",
      transcriptPath,
      exportPath: "C:/private/provider-turn/export.md",
      reportPath: "C:/private/provider-turn/report.json"
    }
  };
}
