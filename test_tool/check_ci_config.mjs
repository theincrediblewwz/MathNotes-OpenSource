import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowFiles = [
  ".github/workflows/ci.yml",
  ".github/workflows/dependency-review.yml",
  ".github/workflows/package-macos-native.yml"
];
const parsed = new Map();

for (const relativePath of workflowFiles) {
  const source = await readFile(path.join(projectRoot, relativePath), "utf8");
  if (source.includes("\t")) throw new Error(`${relativePath} contains a YAML tab`);
  const document = parseDocument(source);
  if (document.errors.length > 0) throw new Error(`${relativePath}: ${document.errors[0].message}`);
  const workflow = document.toJS();
  if (typeof workflow?.name !== "string" || !workflow.on || !workflow.jobs || Object.keys(workflow.jobs).length === 0) {
    throw new Error(`${relativePath} is missing name, on or jobs`);
  }
  if (workflow.pull_request_target || workflow.on?.pull_request_target) {
    throw new Error(`${relativePath} must not use pull_request_target`);
  }
  parsed.set(relativePath, workflow);
}

const ci = parsed.get(".github/workflows/ci.yml");
const windowsCommands = runCommands(ci.jobs.windows);
for (const required of [
  "npm ci",
  "npm run test:unit",
  "npm run build:windows",
  "npm run test:electron-smoke",
  "npm run package:windows:portable",
  "npm run test:windows:portable",
  "npm run release:metadata",
  "npm run test:public-source-gate"
]) {
  if (!windowsCommands.includes(required)) throw new Error(`CI Windows job is missing: ${required}`);
}

const androidCommands = runCommands(ci.jobs.android);
if (!androidCommands.some((command) => command.includes("testDebugUnitTest") && command.includes("assembleDebug"))) {
  throw new Error("CI Android job must run JVM tests and assembleDebug");
}
const e2e = ci.jobs["cross-platform-e2e-contract"];
if (!Array.isArray(e2e?.["runs-on"]) || !e2e["runs-on"].includes("self-hosted")) {
  throw new Error("Cross-platform E2E must remain an explicit self-hosted job");
}
if (!runCommands(e2e).includes("npm run test:android-windows-e2e")) {
  throw new Error("Cross-platform E2E command is missing");
}

const dependencyReview = parsed.get(".github/workflows/dependency-review.yml");
if (!JSON.stringify(dependencyReview.jobs).includes("actions/dependency-review-action@v4")) {
  throw new Error("Dependency Review action is missing");
}

const macosPackage = parsed.get(".github/workflows/package-macos-native.yml");
const macosCommands = runCommands(macosPackage.jobs.package);
if (macosPackage.jobs.package["runs-on"] !== "macos-26") {
  throw new Error("Native macOS package job must use the Apple silicon macos-26 runner");
}
if (!macosCommands.some((command) => command.includes("Xcode_26") && command.includes("DEVELOPER_DIR"))) {
  throw new Error("Native macOS package job must select an installed Xcode 26");
}
for (const required of [
  "npm ci",
  "npm run test:macos:native-package",
  "npm run test:macos:native",
  "npm run test:macos:ui",
  "npm run package:macos:native"
]) {
  if (!macosCommands.includes(required)) throw new Error(`macOS package job is missing: ${required}`);
}
const macosUploadStep = macosPackage.jobs.package.steps.find((step) => step.uses === "actions/upload-artifact@v4");
if (!macosUploadStep) {
  throw new Error("Native macOS package job must upload its release artifact");
}
if (macosUploadStep.if !== "github.event_name == 'push' || inputs.upload_artifact == true") {
  throw new Error("Native macOS package upload must require an explicit final-package request");
}
if (macosUploadStep.with?.["retention-days"] !== 1) {
  throw new Error("Native macOS package artifact must expire after one day");
}
const uploadInput = macosPackage.on?.workflow_dispatch?.inputs?.upload_artifact;
if (uploadInput?.type !== "boolean" || uploadInput.default !== false || uploadInput.required !== true) {
  throw new Error("Native macOS manual workflow must default to build/test without artifact storage");
}

const dependabotSource = await readFile(path.join(projectRoot, ".github/dependabot.yml"), "utf8");
const dependabotDocument = parseDocument(dependabotSource);
if (dependabotDocument.errors.length > 0) throw new Error(`.github/dependabot.yml: ${dependabotDocument.errors[0].message}`);
const dependabot = dependabotDocument.toJS();
const ecosystems = new Set((dependabot?.updates ?? []).map((entry) => entry["package-ecosystem"]));
for (const required of ["npm", "gradle", "github-actions"]) {
  if (!ecosystems.has(required)) throw new Error(`Dependabot is missing ecosystem: ${required}`);
}

console.log(`CI_CONFIG_OK workflows=${workflowFiles.length} dependabot=${[...ecosystems].join(",")}`);

function runCommands(job) {
  return (job?.steps ?? []).map((step) => step.run).filter((command) => typeof command === "string");
}
