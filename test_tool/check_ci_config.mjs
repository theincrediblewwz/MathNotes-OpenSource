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
const pinnedActions = {
  "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/setup-node": "820762786026740c76f36085b0efc47a31fe5020",
  "actions/setup-java": "b6effb05e454b25005698d916606bdc6ffcbf961",
  "actions/upload-artifact": "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "actions/dependency-review-action": "a1d282b36b6f3519aa1f3fc636f609c47dddb294"
};

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
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    for (const step of job?.steps ?? []) {
      if (step.with && Object.prototype.hasOwnProperty.call(step.with, "cache")) {
        throw new Error(`${relativePath} job ${jobName} must not enable Actions dependency caches`);
      }
      if (typeof step.uses !== "string" || !step.uses.startsWith("actions/")) continue;
      const [action, revision] = step.uses.split("@");
      if (pinnedActions[action] !== revision) {
        throw new Error(`${relativePath} job ${jobName} must pin ${action} to the approved full commit SHA`);
      }
    }
  }
  parsed.set(relativePath, workflow);
}

const ci = parsed.get(".github/workflows/ci.yml");
const windowsCommands = runCommands(ci.jobs.windows);
for (const required of [
  "npm ci",
  "npm audit --audit-level=high",
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
if (!JSON.stringify(dependencyReview.jobs).includes(`actions/dependency-review-action@${pinnedActions["actions/dependency-review-action"]}`)) {
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
  "npm run package:macos:native",
  "npm run test:macos:app-launch"
]) {
  if (!macosCommands.includes(required)) throw new Error(`macOS package job is missing: ${required}`);
}
const macosUploadStep = macosPackage.jobs.package.steps.find(
  (step) => step.uses === `actions/upload-artifact@${pinnedActions["actions/upload-artifact"]}` &&
    step.with?.name === "MathNotes-macOS-native-arm64"
);
if (!macosUploadStep) {
  throw new Error("Native macOS package job must upload its release artifact");
}
if (macosUploadStep.if !== "github.event_name == 'push' || inputs.upload_artifact == true") {
  throw new Error("Native macOS package upload must require an explicit final-package request");
}
if (macosUploadStep.with?.["retention-days"] !== 1) {
  throw new Error("Native macOS package artifact must expire after one day");
}
const macosScreenshotUploadStep = macosPackage.jobs.package.steps.find(
  (step) => step.uses === `actions/upload-artifact@${pinnedActions["actions/upload-artifact"]}` &&
    step.with?.name === "MathNotes-macOS-native-ui-acceptance"
);
if (!macosScreenshotUploadStep) {
  throw new Error("Native macOS package job must retain its final UI acceptance screenshot");
}
if (macosScreenshotUploadStep.if !== "github.event_name == 'push' || inputs.upload_artifact == true") {
  throw new Error("Native macOS UI screenshot upload must require an explicit final-package request");
}
if (macosScreenshotUploadStep.with?.["retention-days"] !== 1) {
  throw new Error("Native macOS UI screenshot artifact must expire after one day");
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
