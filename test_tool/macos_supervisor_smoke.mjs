import path from "node:path";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

// Standalone runtime test, like the existing native contracts. This also works
// on Macs with Command Line Tools that do not ship XCTest / Swift Testing.
const root = await mkdtemp(path.join(tmpdir(), "mathnotes-supervisor-build-"));
const sourceRoot = "apps/macos/Sources/MathNotesMac";
const sources = (await readdir(sourceRoot)).filter(name => name.endsWith(".swift") && name !== "MathNotesMacApp.swift")
  .map(name => path.join(sourceRoot, name));
async function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)));
  });
}
try {
  // The bundle accessor is only used by UI rendering, which this test does not
  // exercise. Keep the actual implementation when compiling the shared sources.
  await run("swift", ["build", "--package-path", "apps/macos"]);
  const accessor = "apps/macos/.build/debug/MathNotesMac.build/DerivedSources/resource_bundle_accessor.swift";
  const executable = path.join(root, "SupervisorSmoke");
  await run("swiftc", ["-parse-as-library", "-target", "arm64-apple-macosx14.0", ...sources, accessor,
    process.argv[2] ?? "test_tool/macos_supervisor_smoke.swift", "-o", executable]);
  await run(executable, [], { ...process.env,
    MATHNOTES_TEST_NODE: process.execPath,
    MATHNOTES_TEST_SIDECAR: process.env.MATHNOTES_TEST_SIDECAR_OVERRIDE ?? path.resolve("output/macos-sidecar/core-server.mjs") });
} finally {
  await rm(root, { recursive: true, force: true });
}
