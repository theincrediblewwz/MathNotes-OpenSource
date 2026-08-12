import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { BlockStore } from "../apps/windows/src/core/blockStore";
import { buildCompanionSessionSnapshot, readCompanionAsset } from "../apps/windows/src/core/companionReadService";
import { IngestServer } from "../apps/windows/src/core/ingestServer";
import { MockRecognitionProvider } from "../apps/windows/src/core/mockRecognitionProvider";
import { PdfIngestPipeline } from "../apps/windows/src/core/pdfIngestPipeline";
import { PhotoIngestPipeline } from "../apps/windows/src/core/photoIngestPipeline";
import { PairingManager } from "../apps/windows/src/core/pairingManager";
import { DeviceIdentityService } from "@mathnotes/core-server";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const androidRoot = join(projectRoot, "apps", "android");
const serial = process.env.MATHNOTES_ANDROID_SERIAL ?? "emulator-5554";
const sdkRoot = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME;
assert.ok(sdkRoot, "ANDROID_SDK_ROOT or ANDROID_HOME is required");
const adb = join(sdkRoot, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
const gradle = join(androidRoot, process.platform === "win32" ? "gradlew.bat" : "gradlew");
const root = await mkdtemp(join(tmpdir(), "mathnotes-android-windows-e2e-"));
const notebookId = "android_e2e";
const sessionId = "emulator_acceptance";
const token = "android-e2e-token-20260713";
const emulatorHost = "10.0.2.2";
let server: IngestServer | undefined;
let deviceIdentities: DeviceIdentityService;
let port = 0;
let completed = false;

try {
  await runGradle(["-p", androidRoot, "assembleDebug", "assembleDebugAndroidTest", "--console=plain"]);
  await adbRun(["-s", serial, "install", "-r", join(androidRoot, "app", "build", "outputs", "apk", "debug", "app-debug.apk")]);
  await adbRun([
    "-s",
    serial,
    "install",
    "-r",
    join(androidRoot, "app", "build", "outputs", "apk", "androidTest", "debug", "app-debug-androidTest.apk")
  ]);
  await adbRun(["-s", serial, "shell", "pm", "clear", "com.mathnotes.capture"]);

  const store = new BlockStore(root);
  deviceIdentities = new DeviceIdentityService({ filePath: join(root, "device-identities.json") });
  await deviceIdentities.start();
  await store.createSession({
    notebookId,
    sessionId,
    title: "Android emulator acceptance",
    now: new Date().toISOString()
  });
  ({ server, port } = await startServer(store, 0));

  const challenge = await server.createDevicePairingChallenge();
  const devicePairingPayload = new PairingManager().createDevicePairingSession({
    host: emulatorHost,
    port,
    challengeId: challenge.challengeId,
    userCode: challenge.userCode,
    expiresAt: challenge.expiresAt,
    now: new Date().toISOString()
  }).payload;
  await runInstrumentation("exchangesOneTimeChallengeForDeviceCredential", {
    devicePairingPayloadB64: Buffer.from(devicePairingPayload, "utf8").toString("base64url")
  });
  const issuedDevice = (await deviceIdentities.listDevices()).find((device) => !device.revokedAt);
  assert.ok(issuedDevice, "Android did not exchange the one-time challenge for a device identity");
  assert.equal(await deviceIdentities.revokeDevice(issuedDevice.deviceId), true);
  await runInstrumentation("rejectsRevokedDeviceCredential");

  await runInstrumentation("verifiesPairingWithoutCreatingContent");
  await assertPairingProbeSideEffectFree();
  const companionProbe = await store.saveEmbeddedAsset({
    notebookId,
    sessionId,
    fileName: "companion-probe.png",
    bytes: Buffer.alloc(3 * 1024 * 1024, 0x5a)
  });
  await store.appendMarkdownBlock({
    notebookId,
    sessionId,
    source: "user",
    markdown: `## Android companion asset probe\n\n![probe](../${companionProbe.relativePath})`,
    now: new Date().toISOString()
  });
  await runInstrumentation("uploadsToWindowsAndReusesTheDurableReceipt");
  await runInstrumentation("uploadsPdfToWindowsWithoutStartingRecognition");
  await assertCompanionRoutesUseSamePairingIdentity();
  await runInstrumentation("syncsTheWindowsCompanionSnapshotAndAssetOnAndroid");

  await server.stop();
  server = undefined;
  await runInstrumentation("preservesThePhotoWhenTheWindowsEndpointIsInterrupted");

  ({ server, port } = await startServer(store, port));
  await runInstrumentation("uploadsAfterTheWindowsServerRestarts");
  await runInstrumentation("blocksAnInvalidPairingTokenWithoutDeletingThePhoto");
  await runInstrumentation("seedsDelayedUploadForDeviceReboot");
  await waitForScheduledUploadJob();
  process.stdout.write("ANDROID_REBOOT_E2E seeded delayed work; rebooting emulator\n");
  await adbRun(["-s", serial, "reboot"]);
  await waitForAndroidBoot();
  await waitForReceiptCount(3);
  await runInstrumentation("verifiesDelayedUploadCompletedAfterDeviceReboot");

  const sessionDir = join(root, "notebooks", notebookId, "sessions", sessionId);
  const uploads = JSON.parse(await readFile(join(sessionDir, "logs", "uploads.json"), "utf8")) as Array<Record<string, unknown>>;
  const pdfUploads = JSON.parse(await readFile(join(sessionDir, "logs", "pdf_uploads.json"), "utf8")) as Array<Record<string, unknown>>;
  const jobs = JSON.parse(await readFile(join(sessionDir, "logs", "recognition_jobs.json"), "utf8")) as Array<Record<string, unknown>>;
  const session = JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8")) as {
    blocks: Array<{ type: string }>;
  };
  const photos = await readdir(join(sessionDir, "assets", "photos"));

  assert.equal(uploads.length, 3, "Probe, duplicate retry or rejected uploads created unexpected Windows receipts");
  assert.equal(pdfUploads.length, 1, "Android PDF upload did not create exactly one durable PDF receipt");
  assert.equal(pdfUploads[0]?.pageCount, 1, "Windows did not inspect the uploaded PDF page count");
  assert.equal(await pathExists(String(pdfUploads[0]?.sourcePath)), true, "Windows did not retain the uploaded PDF inbox file");
  assert.equal(jobs.length, 3, "Accepted captures did not create exactly three recognition jobs");
  assert.ok(jobs.every((job) => job.status === "succeeded"), "Mock recognition did not finish cleanly");
  assert.equal(session.blocks.filter((block) => block.type === "image").length, 3);
  assert.equal(session.blocks.filter((block) => block.type === "markdown").length, 4);
  assert.equal(photos.length, 3, "Windows did not retain exactly the three accepted JPEG assets");
  for (const photo of photos) {
    const bytes = await readFile(join(sessionDir, "assets", "photos", photo));
    assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8], `${photo} is not a JPEG`);
    assert.deepEqual([...bytes.subarray(-2)], [0xff, 0xd9], `${photo} has a truncated JPEG footer`);
  }
  const persistedText = [
    await readFile(join(sessionDir, "logs", "uploads.json"), "utf8"),
    await readFile(join(sessionDir, "logs", "pdf_uploads.json"), "utf8"),
    await readFile(join(sessionDir, "logs", "recognition_jobs.json"), "utf8"),
    await readFile(join(sessionDir, "session.json"), "utf8")
  ].join("\n");
  assert.ok(!persistedText.includes(token), "Pairing token leaked into Windows persistence");

  process.stdout.write(
    `ANDROID_WINDOWS_E2E_OK serial=${serial} receipts=${uploads.length} pdfs=${pdfUploads.length} photos=${photos.length} jobs=${jobs.length} reboot=passed\n`
  );
  completed = true;
} finally {
  if (server) await server.stop();
  if (completed) {
    await adbRun(["-s", serial, "shell", "pm", "clear", "com.mathnotes.capture"], true);
    await rm(root, { recursive: true, force: true });
  } else {
    process.stderr.write(`ANDROID_WINDOWS_E2E preserved failure evidence at ${root}\n`);
  }
}

async function startServer(store: BlockStore, requestedPort: number): Promise<{ server: IngestServer; port: number }> {
  const next = new IngestServer({
    host: "0.0.0.0",
    port: requestedPort,
    token,
    pairingTarget: { notebookId, sessionId },
    getPairingTargets: async () => [
      { notebookId, sessionId, title: "Android emulator acceptance" }
    ],
    getCompanionSession: (targetNotebookId, targetSessionId) => buildCompanionSessionSnapshot({
      store,
      notebookId: targetNotebookId,
      sessionId: targetSessionId
    }),
    getCompanionAsset: (targetNotebookId, targetSessionId, assetPath) => readCompanionAsset({
      store,
      notebookId: targetNotebookId,
      sessionId: targetSessionId,
      assetPath
    }),
    deviceIdentityService: deviceIdentities,
    pipeline: new PhotoIngestPipeline({ store, provider: new MockRecognitionProvider() }),
    acceptPdf: (input) => new PdfIngestPipeline({ store }).acceptPdf(input)
  });
  const started = await next.start();
  return { server: next, port: started.port };
}

async function assertCompanionRoutesUseSamePairingIdentity(): Promise<void> {
  const headers = { Authorization: `Bearer ${token}` };
  const verify = await fetch(`http://127.0.0.1:${port}/api/v1/pairing/verify`, { headers });
  assert.equal(verify.status, 200, "Upload identity could not read the companion catalog");
  const catalog = await verify.json() as {
    targets?: Array<{ notebookId: string; sessionId: string }>;
  };
  assert.ok(
    catalog.targets?.some((target) => target.notebookId === notebookId && target.sessionId === sessionId),
    "Companion catalog omitted the same target used by Android uploads"
  );

  const query = new URLSearchParams({ notebookId, sessionId });
  const snapshot = await fetch(`http://127.0.0.1:${port}/api/v1/companion/session?${query}`, { headers });
  assert.equal(snapshot.status, 200, "Upload identity could not read the companion Session snapshot");
  const body = await snapshot.json() as { notebookId?: string; sessionId?: string; html?: string };
  assert.equal(body.notebookId, notebookId);
  assert.equal(body.sessionId, sessionId);
  assert.match(body.html ?? "", /Mock 识别占位/u, "Uploaded transcript did not reach the companion snapshot");
}

async function assertPairingProbeSideEffectFree(): Promise<void> {
  const sessionDir = join(root, "notebooks", notebookId, "sessions", sessionId);
  const session = JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8")) as {
    blocks: unknown[];
  };
  assert.equal(session.blocks.length, 0, "Pairing verification created a block");
  for (const relativePath of [join("logs", "uploads.json"), join("logs", "recognition_jobs.json")]) {
    assert.equal(await pathExists(join(sessionDir, relativePath)), false, `Pairing verification created ${relativePath}`);
  }
  assert.deepEqual(
    await readdir(join(sessionDir, "assets", "photos")),
    [],
    "Pairing verification created a photo asset"
  );
}

async function waitForAndroidBoot(): Promise<void> {
  await adbRun(["-s", serial, "wait-for-device"]);
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const result = await adbRun(["-s", serial, "shell", "getprop", "sys.boot_completed"], true);
    if (result.stdout.trim() === "1") return;
    await delay(2_000);
  }
  throw new Error(`Android emulator ${serial} did not finish booting`);
}

async function countScheduledUploadJobs(): Promise<number> {
  const jobs = await adbRun(["-s", serial, "shell", "dumpsys", "jobscheduler"], true);
  return jobs.stdout.match(
    /JOB #[^\r\n]*com\.mathnotes\.capture\/androidx\.work\.impl\.background\.systemjob\.SystemJobService/gu
  )?.length ?? 0;
}

async function waitForScheduledUploadJob(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await countScheduledUploadJobs()) >= 1) {
      await delay(1_000);
      return;
    }
    await delay(500);
  }
  throw new Error("WorkManager did not hand the delayed upload to JobScheduler before reboot");
}

async function waitForReceiptCount(expected: number): Promise<void> {
  const uploadsPath = join(
    root,
    "notebooks",
    notebookId,
    "sessions",
    sessionId,
    "logs",
    "uploads.json"
  );
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const count = await readFile(uploadsPath, "utf8")
      .then((text) => (JSON.parse(text) as unknown[]).length)
      .catch(() => 0);
    if (count >= expected) return;
    await delay(2_000);
  }
  const diagnostics = await collectRebootDiagnostics();
  throw new Error(`Windows did not receive ${expected} photos after Android reboot\n${diagnostics}`);
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

async function collectRebootDiagnostics(): Promise<string> {
  const packageState = await adbRun(
    ["-s", serial, "shell", "dumpsys", "package", "com.mathnotes.capture"],
    true
  );
  const jobs = await adbRun(["-s", serial, "shell", "dumpsys", "jobscheduler"], true);
  const relevantPackage = packageState.stdout
    .split(/\r?\n/u)
    .filter((line) => /stopped=|enabled=|granted=true|POST_NOTIFICATIONS/u.test(line))
    .slice(0, 20)
    .join("\n");
  const relevantJobs = jobs.stdout
    .split(/\r?\n/u)
    .filter((line) => /mathnotes|com\.mathnotes\.capture|JOB #/iu.test(line))
    .slice(-60)
    .join("\n");
  return `package:\n${relevantPackage}\njobs:\n${relevantJobs}`;
}

async function runInstrumentation(method: string, extraArgs: Record<string, string> = {}): Promise<void> {
  const instrumentArgs = Object.entries(extraArgs).flatMap(([name, value]) => ["-e", name, value]);
  const result = await adbRun([
    "-s",
    serial,
    "shell",
    "am",
    "instrument",
    "-w",
    "-r",
    "-e",
    "class",
    `com.mathnotes.capture.WindowsIngestEndToEndTest#${method}`,
    "-e",
    "ingestHost",
    emulatorHost,
    "-e",
    "ingestPort",
    String(port),
    "-e",
    "ingestToken",
    token,
    "-e",
    "notebookId",
    notebookId,
    "-e",
    "sessionId",
    sessionId,
    ...instrumentArgs,
    "com.mathnotes.capture.test/androidx.test.runner.AndroidJUnitRunner"
  ]);
  if (/FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed/i.test(result.stdout + result.stderr)) {
    throw new Error(`Android instrumentation failed for ${method}:\n${result.stdout}\n${result.stderr}`);
  }
}

async function runGradle(args: string[]): Promise<void> {
  if (process.platform === "win32") {
    await run(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", `${gradle} ${args.map(quote).join(" ")}`]);
    return;
  }
  await run(gradle, args);
}

async function adbRun(args: string[], ignoreFailure = false): Promise<{ stdout: string; stderr: string }> {
  return run(adb, args, ignoreFailure);
}

async function run(
  command: string,
  args: string[],
  ignoreFailure = false
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(command, args, {
      cwd: projectRoot,
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024
    });
  } catch (error) {
    if (ignoreFailure) return { stdout: "", stderr: String(error) };
    throw error;
  }
}

function quote(value: string): string {
  return /[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}
