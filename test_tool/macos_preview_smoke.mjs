import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = await mkdtemp(path.join(tmpdir(), "mathnotes-preview-fixture-"));
async function run(args, env = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`preview smoke failed (${code})`)));
  });
}
try {
  await run(["test_tool/create_macos_phase1d_fixture.mjs", path.join(root, "notes")]);
  await run(["test_tool/macos_supervisor_smoke.mjs", "test_tool/macos_preview_smoke.swift"], {
    ...process.env, MATHNOTES_TEST_PREVIEW_ROOT: root
  });
} finally { await rm(root, { recursive: true, force: true }); }
