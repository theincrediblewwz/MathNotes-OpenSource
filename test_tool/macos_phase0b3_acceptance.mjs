#!/usr/bin/env node
import { closeSync, openSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  appendPhase0b3Event,
  collectPhase0b3Evidence,
  createPhase0b3RunId,
  createPhase0b3Paths,
  initializePhase0b3Run
} from "./macos_phase0b3_acceptance_lib.mjs";

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

if (command === "start") {
  assertMacHost();
  const sourceCommit = required(args, "commit");
  const appPath = path.resolve(required(args, "app"));
  const runId = args.run ?? createPhase0b3RunId();
  const paths = createPhase0b3Paths({ homeDir: os.homedir(), runId });
  const { run, binaryPath } = await initializePhase0b3Run({ paths, appPath, sourceCommit });
  const logFd = openSync(paths.appLogPath, "a");
  let child;
  try {
    child = spawn(binaryPath, [`--user-data-dir=${paths.userDataRoot}`], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        MATHNOTES_ROOT: paths.notesRoot,
        MATHNOTES_PHASE0B3_RUN_ID: run.runId
      }
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  await writeFile(paths.runPath, `${JSON.stringify({ ...run, status: "launched", pid: child.pid }, null, 2)}\n`, "utf8");
  console.log(`PHASE0B3_RUN=${paths.runRoot}`);
  console.log(`PHASE0B3_PID=${child.pid}`);
  console.log(`PHASE0B3_NOTES_ROOT=${paths.notesRoot}`);
  console.log("PHASE0B3_MOCK_PROVIDER=false");
} else if (command === "mark") {
  const paths = await pathsFromRun(required(args, "run"));
  const record = await appendPhase0b3Event({ paths, event: required(args, "event"), note: args.note ?? "" });
  console.log(`PHASE0B3_EVENT=${record.event}`);
  console.log(`PHASE0B3_EVENT_AT=${record.at}`);
} else if (command === "collect") {
  const paths = await pathsFromRun(required(args, "run"));
  const summary = await collectPhase0b3Evidence({ paths });
  console.log(`PHASE0B3_SUMMARY=${paths.summaryPath}`);
  console.log(`PHASE0B3_PASSED=${summary.passed}`);
  for (const [name, passed] of Object.entries(summary.gates)) {
    console.log(`PHASE0B3_GATE_${name.toUpperCase()}=${passed}`);
  }
  if (!summary.passed) process.exitCode = 2;
} else {
  console.error("Usage: macos_phase0b3_acceptance.mjs start --app <MathNotes.app> --commit <sha> [--run <id>]");
  console.error("       macos_phase0b3_acceptance.mjs mark --run <run-dir> --event <event> [--note <text>]");
  console.error("       macos_phase0b3_acceptance.mjs collect --run <run-dir>");
  process.exitCode = 1;
}

function assertMacHost() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(`PHASE0B3_MAC_ARM64_REQUIRED:${process.platform}-${process.arch}`);
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`PHASE0B3_ARGUMENT_INVALID:${flag ?? ""}`);
    parsed[flag.slice(2)] = value;
  }
  return parsed;
}

function required(args, name) {
  const value = args[name];
  if (!value) throw new Error(`PHASE0B3_ARGUMENT_REQUIRED:${name}`);
  return value;
}

async function pathsFromRun(runRoot) {
  const run = JSON.parse(await readFile(path.join(path.resolve(runRoot), "evidence", "run.json"), "utf8"));
  const paths = createPhase0b3Paths({ homeDir: os.homedir(), runId: run.runId });
  if (path.resolve(runRoot) !== paths.runRoot) throw new Error(`PHASE0B3_RUN_ROOT_MISMATCH:${runRoot}`);
  return paths;
}
