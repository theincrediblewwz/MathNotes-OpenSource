import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const tempRoot = await mkdtemp(join(tmpdir(), "mathnotes-quality-cli-"));

try {
  const notesRoot = join(tempRoot, "notes");
  const outputRoot = join(tempRoot, "reports");
  const benchmarkRoot = join(tempRoot, "benchmark");
  const imagePath = join(benchmarkRoot, "board.png");
  const goldPath = join(benchmarkRoot, "board.md");
  const manifestPath = join(benchmarkRoot, "benchmark.json");
  await mkdir(benchmarkRoot, { recursive: true });
  await writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));
  await writeFile(goldPath, "## Mock Gold\n", "utf8");
  await writeFile(manifestPath, `${JSON.stringify({
    version: 1,
    label: "mock-smoke",
    repeats: 1,
    variant: "pipeline-only",
    samples: [{
      id: "board-001",
      category: "smoke",
      imagePath: "board.png",
      goldMarkdownPath: "board.md",
      goldStatus: "candidate"
    }]
  }, null, 2)}\n`, "utf8");

  const result = await runNode([
    "test_tool/run_quality_benchmark.mjs",
    "--manifest",
    manifestPath,
    "--notes-root",
    notesRoot,
    "--output-root",
    outputRoot,
    "--allow-mock"
  ]);
  if (result.code !== 0) {
    throw new Error(`Quality benchmark CLI failed (${result.code}): ${result.stderr || result.stdout}`);
  }

  const jsonPath = result.stdout.match(/^JSON 报告：(.+)$/m)?.[1]?.trim();
  const markdownPath = result.stdout.match(/^Markdown 报告：(.+)$/m)?.[1]?.trim();
  if (!jsonPath || !markdownPath) {
    throw new Error(`Quality benchmark CLI did not print report paths: ${result.stdout}`);
  }
  const json = await readFile(jsonPath, "utf8");
  const markdown = await readFile(markdownPath, "utf8");
  const report = JSON.parse(json);
  if (report.provider?.id !== "mock" || report.summary?.total !== 1 || report.summary?.succeeded !== 1) {
    throw new Error(`Unexpected quality benchmark report: ${json}`);
  }
  for (const value of [json, markdown]) {
    if (/Authorization|Bearer\s+\S+|api[-_]?key\s*[=:]/i.test(value)) {
      throw new Error("Quality benchmark report contains a forbidden secret marker");
    }
    if (value.includes("## Mock Gold")) {
      throw new Error("Quality benchmark report contains the Gold Markdown body");
    }
  }

  process.stdout.write("QUALITY_BENCHMARK_SMOKE_OK provider=mock runs=1\n");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function runNode(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
  });
}
