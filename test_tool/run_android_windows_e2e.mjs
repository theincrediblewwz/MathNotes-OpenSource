import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(projectRoot, "output", "android-windows-e2e");
const bundlePath = join(outputDir, "android-windows-e2e.mjs");

await mkdir(outputDir, { recursive: true });
await build({
  absWorkingDir: projectRoot,
  alias: {
    "@mathnotes/shared": join(projectRoot, "packages", "shared", "src", "index.ts"),
    "@mathnotes/core-server/domain/faithful-transcription-prompt": join(
      projectRoot,
      "packages",
      "core-server",
      "src",
      "domain",
      "faithfulTranscriptionPrompt.ts"
    ),
    "@mathnotes/core-server/provider/image-data-url": join(
      projectRoot,
      "packages",
      "core-server",
      "src",
      "provider",
      "imageDataUrl.ts"
    ),
    "@mathnotes/core-server/provider/open-ai-compatible": join(
      projectRoot,
      "packages",
      "core-server",
      "src",
      "provider",
      "openAiCompatibleVisionProvider.ts"
    ),
    "@mathnotes/core-server": join(projectRoot, "packages", "core-server", "src", "index.ts")
  },
  bundle: true,
  packages: "external",
  entryPoints: ["test_tool/android_windows_e2e.ts"],
  format: "esm",
  outfile: bundlePath,
  platform: "node",
  sourcemap: false
});

const exitCode = await new Promise((resolveExit, reject) => {
  const child = spawn(process.execPath, [bundlePath], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true
  });
  child.once("error", reject);
  child.once("exit", (code) => resolveExit(code ?? 1));
});

process.exitCode = exitCode;
