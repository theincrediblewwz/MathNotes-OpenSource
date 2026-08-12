#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

if (process.platform !== "darwin") {
  throw new Error(`MACOS_NATIVE_CONTRACT_REQUIRES_DARWIN:${process.platform}`);
}

const root = process.cwd();
const outputDir = await mkdtemp(path.join(tmpdir(), "mathnotes-native-contract-"));
const executable = path.join(outputDir, "MathNotesMacContract");
try {
  await run("swiftc", [
    path.join(root, "apps", "macos", "Sources", "MathNotesMac", "SidecarProtocol.swift"),
    path.join(root, "apps", "macos", "Sources", "MathNotesMac", "ProviderPreferences.swift"),
    path.join(root, "apps", "macos", "Sources", "MathNotesMac", "ProviderRestoration.swift"),
    path.join(root, "apps", "macos", "Sources", "MathNotesMac", "AiGuidanceModels.swift"),
    path.join(root, "apps", "macos", "Sources", "MathNotesMac", "LocalShellClient.swift"),
    path.join(root, "apps", "macos", "Sources", "MathNotesMac", "CompanionHostAutomation.swift"),
    path.join(root, "apps", "macos", "Sources", "MathNotesMac", "CompanionLanPairing.swift"),
    path.join(root, "apps", "macos", "ContractTests", "main.swift"),
    "-o",
    executable
  ]);
  await run(executable, []);
} finally {
  await rm(outputDir, { recursive: true, force: true });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed with ${code ?? signal}`));
    });
  });
}
