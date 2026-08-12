import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const tempRoot = await mkdtemp(join(tmpdir(), "mathnotes-provider-turn-cli-"));

try {
  const notesRoot = join(tempRoot, "notes");
  const outputRoot = join(tempRoot, "acceptance");
  const imagePath = join(tempRoot, "board.png");
  await writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));

  const result = await runNode([
    "test_tool/run_provider_turn_acceptance.mjs",
    "--image",
    imagePath,
    "--notes-root",
    notesRoot,
    "--output-root",
    outputRoot,
    "--allow-mock"
  ]);
  if (result.code !== 0) {
    throw new Error(`Provider turn CLI failed (${result.code}): ${result.stderr || result.stdout}`);
  }

  const reportPath = result.stdout.match(/^Report: (.+)$/m)?.[1]?.trim();
  if (!reportPath) {
    throw new Error(`Provider turn CLI did not print a report path: ${result.stdout}`);
  }
  const reportText = await readFile(reportPath, "utf8");
  const report = JSON.parse(reportText);
  if (report.provider?.id !== "mock" || report.result?.status !== "succeeded") {
    throw new Error(`Unexpected provider turn report: ${reportText}`);
  }
  if (reportText.includes("Authorization") || reportText.includes("apiKey")) {
    throw new Error("Provider turn report contains forbidden secret-bearing fields");
  }
  await stat(report.artifacts.transcriptPath);
  await stat(report.artifacts.exportPath);

  process.stdout.write("PROVIDER_TURN_SMOKE_OK provider=mock status=succeeded\n");
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
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
  });
}
