#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const outputDir = path.join(root, "output", "macos-phase1-closeout");
const outputPath = path.join(outputDir, "report.json");
const startedAt = new Date().toISOString();
const fullXcodeDeveloperDir = "/Applications/Development/Xcode.app/Contents/Developer";
const checks = [
  check("sidecar-bundle", process.execPath, ["test_tool/build_macos_sidecar.mjs"]),
  check("sidecar-lifecycle", process.execPath, ["test_tool/macos_sidecar_smoke.mjs"]),
  check("native-ui-contract", process.execPath, ["test_tool/macos_ui_contract.mjs"]),
  check("readonly-session-content", process.execPath, ["test_tool/macos_phase1d_content_smoke.mjs"]),
  check("controlled-markdown-edit", process.execPath, ["test_tool/macos_phase1e1_edit_smoke.mjs"]),
  check("safe-image-import", process.execPath, ["test_tool/macos_phase1e2_image_import_smoke.mjs"]),
  check("single-image-recognition", process.execPath, ["test_tool/macos_phase1e3_recognition_smoke.mjs"]),
  check("recoverable-export", process.execPath, ["test_tool/macos_phase1e4_export_smoke.mjs"]),
  check("secure-provider-settings", process.execPath, ["test_tool/macos_phase1e5_provider_smoke.mjs"]),
  check("durable-conflicts", process.execPath, ["test_tool/macos_phase1e6_conflict_smoke.mjs"])
  ,check("shared-block-organization", process.execPath, ["test_tool/macos_phase1e7_block_organize_smoke.mjs"])
];

if (process.platform === "darwin") {
  checks.push(
    check("swift-protocol-contract", process.execPath, ["test_tool/macos_native_contract.mjs"], {
      DEVELOPER_DIR: fullXcodeDeveloperDir
    }),
    check("swift-native-build", "swift", ["build", "--package-path", "apps/macos"], {
      DEVELOPER_DIR: fullXcodeDeveloperDir
    })
  );
}

const results = [];
let failed = false;
for (const entry of checks) {
  const result = await run(entry);
  results.push(result);
  if (result.status !== "passed") {
    failed = true;
    break;
  }
}

const report = {
  version: 1,
  task: "20260724-macos-phase1-consolidation",
  platform: process.platform,
  architecture: process.arch,
  startedAt,
  completedAt: new Date().toISOString(),
  status: failed ? "FAILED" : process.platform === "darwin" ? "AUTO_PASSED" : "DARWIN_PENDING",
  providerCalls: 0,
  realNotebookAccess: false,
  checks: results,
  pending: process.platform === "darwin"
    ? ["MANUAL_PENDING: real window, Keychain, file panels, visual and interaction acceptance"]
    : [
        "DARWIN_PENDING: Swift protocol contract and native build",
        "MANUAL_PENDING: real window, Keychain, file panels, visual and interaction acceptance"
      ]
};

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`MACOS_PHASE1_REPORT=${outputPath}`);
console.log(`MACOS_PHASE1_CLOSEOUT_${report.status} checks=${results.length}`);
if (failed) process.exitCode = 1;

function check(id, command, args, environment = {}) {
  return { id, command, args, environment };
}

function run(entry) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(entry.command, entry.args, {
      cwd: root,
      env: { ...process.env, ...entry.environment },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.once("error", (error) => {
      resolve(result("failed", null, error.message));
    });
    child.once("exit", (code, signal) => {
      resolve(result(code === 0 ? "passed" : "failed", code, signal ? `signal:${signal}` : undefined));
    });

    function result(status, exitCode, launchError) {
      return {
        id: entry.id,
        command: [entry.command, ...entry.args].join(" "),
        status,
        exitCode,
        durationMs: Math.round((performance.now() - started) * 10) / 10,
        evidence: tail(stdout, 8),
        diagnostic: status === "passed" ? tail(stderr, 12) || undefined : undefined,
        error: status === "failed" ? launchError ?? (tail(stderr, 12) || undefined) : undefined
      };
    }
  });
}

function tail(value, lines) {
  return value.trim().split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
}
