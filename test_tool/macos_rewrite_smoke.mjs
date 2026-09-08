import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const root = await mkdtemp(path.join(tmpdir(), "mathnotes-native-rewrite-"));
function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`rewrite test failed: ${code}`)));
  });
}
try {
  const sidecar = path.join(root, "rewrite-fixture.mjs");
  await build({ entryPoints: ["test_tool/macos_rewrite_fixture.ts"], bundle: true, platform: "node", format: "esm", outfile: sidecar,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  await run(process.execPath, ["test_tool/macos_supervisor_smoke.mjs", "test_tool/macos_rewrite_smoke.swift"], {
    ...process.env, MATHNOTES_TEST_REWRITE_ROOT: root, MATHNOTES_TEST_SIDECAR_OVERRIDE: sidecar
  });
} finally { await rm(root, { recursive: true, force: true }); }
