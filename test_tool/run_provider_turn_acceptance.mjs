import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(projectRoot, "output", "provider-turn-acceptance");
const bundlePath = join(outputDir, "provider-turn-acceptance.mjs");

await mkdir(outputDir, { recursive: true });
await build({
  absWorkingDir: projectRoot,
  bundle: true,
  entryPoints: ["test_tool/provider_turn_acceptance.ts"],
  format: "esm",
  outfile: bundlePath,
  platform: "node",
  sourcemap: false
});

const exitCode = await new Promise((resolveExit, reject) => {
  const child = spawn(process.execPath, [bundlePath, ...process.argv.slice(2)], {
    cwd: projectRoot,
    stdio: "inherit",
    windowsHide: true
  });
  child.once("error", reject);
  child.once("exit", (code) => resolveExit(code ?? 1));
});

process.exitCode = exitCode;
