import { describe, expect, it, vi } from "vitest";
import {
  benchmarkPathSegment,
  parseQualityBenchmarkArgs,
  runQualityBenchmarkCli,
  type QualityBenchmarkCliDependencies
} from "../../../../test_tool/quality_benchmark";

describe("quality benchmark CLI", () => {
  it("creates non-traversing collision-resistant output path segments", () => {
    expect(benchmarkPathSegment("..")).toMatch(/^benchmark-[a-f0-9]{12}$/);
    expect(benchmarkPathSegment("数学/分析")).not.toBe(benchmarkPathSegment("数学\\分析"));
  });

  it("parses manifest paths and explicit execution gates", () => {
    expect(parseQualityBenchmarkArgs([
      "--manifest",
      "C:/bench/benchmark.json",
      "--notes-root",
      "C:/MathNotes",
      "--output-root",
      "C:/reports",
      "--resume-only",
      "--allow-mock"
    ])).toEqual({
      manifestPath: "C:/bench/benchmark.json",
      notesRoot: "C:/MathNotes",
      outputRoot: "C:/reports",
      confirmPaid: false,
      allowMock: true,
      resumeOnly: true
    });
  });

  it("rejects paid confirmation in resume-only mode", () => {
    expect(() => parseQualityBenchmarkArgs([
      "--manifest",
      "C:/bench/benchmark.json",
      "--resume-only",
      "--confirm-paid"
    ])).toThrow("cannot be combined");
  });

  it("rejects invocations without an explicit manifest", () => {
    expect(() => parseQualityBenchmarkArgs([])).toThrow("--manifest");
  });

  it("performs a zero-call preflight for a real provider without confirmation", async () => {
    const createProvider = vi.fn();
    const runBenchmark = vi.fn();
    const output: string[] = [];
    const dependencies = fakeDependencies({ createProvider, runBenchmark, output });

    const result = await runQualityBenchmarkCli(
      ["--manifest", "C:/bench/benchmark.json", "--notes-root", "C:/MathNotes"],
      {},
      dependencies
    );

    expect(result).toMatchObject({
      mode: "preflight",
      plannedCalls: 3,
      reusable: 2,
      requiredCalls: 1
    });
    expect(createProvider).not.toHaveBeenCalled();
    expect(runBenchmark).not.toHaveBeenCalled();
    expect(output.join("")).toContain("计划调用：1 张图片 × 3 次 = 3 次");
    expect(output.join("")).toContain("预计复用：2 次；仍需调用：1 次");
    expect(output.join("")).toContain("未发送任何图片");
  });

  it("refreshes reports from complete reusable evidence without creating a Provider", async () => {
    const createProvider = vi.fn();
    const report = {
      summary: { total: 3, succeeded: 3, failed: 0, skipped: 3 },
      artifacts: { jsonReportPath: "report.json", markdownReportPath: "report.md" }
    };
    const runBenchmark = vi.fn().mockResolvedValue(report);
    const dependencies = fakeDependencies({
      createProvider,
      runBenchmark,
      reusable: 3
    });

    const result = await runQualityBenchmarkCli(
      ["--manifest", "C:/bench/benchmark.json", "--notes-root", "C:/MathNotes", "--resume-only"],
      {},
      dependencies
    );

    expect(result).toMatchObject({ mode: "resume-only", reusable: 3, requiredCalls: 0 });
    expect(createProvider).not.toHaveBeenCalled();
    expect(runBenchmark).toHaveBeenCalledOnce();
  });

  it("refuses resume-only mode when any reusable run is missing", async () => {
    const createProvider = vi.fn();
    const runBenchmark = vi.fn();
    const dependencies = fakeDependencies({ createProvider, runBenchmark, reusable: 2 });

    await expect(runQualityBenchmarkCli(
      ["--manifest", "C:/bench/benchmark.json", "--notes-root", "C:/MathNotes", "--resume-only"],
      {},
      dependencies
    )).rejects.toThrow("1 run(s) are missing");
    expect(createProvider).not.toHaveBeenCalled();
    expect(runBenchmark).not.toHaveBeenCalled();
  });

  it("rejects the mock provider unless the smoke gate is explicit", async () => {
    const dependencies = fakeDependencies({ providerId: "mock" });

    await expect(runQualityBenchmarkCli(
      ["--manifest", "C:/bench/benchmark.json", "--notes-root", "C:/MathNotes"],
      {},
      dependencies
    )).rejects.toThrow("--allow-mock");
  });
});

function fakeDependencies(options: {
  providerId?: "mimo_2_5" | "mock";
  createProvider?: ReturnType<typeof vi.fn>;
  runBenchmark?: ReturnType<typeof vi.fn>;
  output?: string[];
  reusable?: number;
} = {}): QualityBenchmarkCliDependencies {
  const providerId = options.providerId ?? "mimo_2_5";
  return {
    async readSettings() {
      return {
        notesRootDir: "C:/MathNotes",
        defaultExportDir: "",
        sourceFontFamily: "Cascadia Mono",
        sourceFontSize: 13,
        previewFontFamily: "Segoe UI",
        previewFontSize: 16,
        assistantFontFamily: "Segoe UI",
        assistantFontSize: 16,
        themeId: "default_light",
        locale: "zh-CN",
        showCodexAssistant: true
      };
    },
    async readConfig() {
      return {
        providerId,
        model: providerId === "mock" ? "mock-faithful-markdown" : "mimo-v2.5",
        apiKey: providerId === "mock" ? "" : "secret-key",
        apiKeyEnvVar: "MIMO_API_KEY",
        baseUrl: "https://api.example.test/v1?api_key=secret-key",
        commandPath: "",
        codexRuntime: "windows",
        wslDistro: "",
        status: "configured"
      };
    },
    async readManifest() {
      return {
        version: 1,
        manifestPath: "C:/bench/benchmark.json",
        label: "functional-analysis",
        repeats: 3,
        variant: "current-provider-settings",
        samples: [{
          id: "board-001",
          category: "dense-derivation",
          imagePath: "C:/bench/board.png",
          goldMarkdownPath: "C:/bench/board.md",
          imageFileName: "board.png",
          goldFileName: "board.md",
          imageSha256: "a".repeat(64),
          goldSha256: "b".repeat(64),
          goldStatus: "candidate"
        }]
      };
    },
    createProvider: (options.createProvider ?? vi.fn()) as QualityBenchmarkCliDependencies["createProvider"],
    async inspectReuse() {
      const reusable = options.reusable ?? 2;
      return { total: 3, reusable, missing: 3 - reusable };
    },
    runBenchmark: (options.runBenchmark ?? vi.fn()) as QualityBenchmarkCliDependencies["runBenchmark"],
    writeOutput(value) {
      options.output?.push(value);
    }
  };
}
