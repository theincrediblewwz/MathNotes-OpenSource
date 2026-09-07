import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
const diagnosticRoot = resolve(process.env.MATHNOTES_ANDROID_E2E_QA_DIR ?? join(projectRoot, "output", "android-windows-e2e", "reboot-diagnostics"));
await mkdir(diagnosticRoot, { recursive: true });
const notebookId = "android_e2e";
const sessionId = "emulator_acceptance";
const token = "android-e2e-token-20260713";
const emulatorHost = "10.0.2.2";
const networkCycles = process.env.MATHNOTES_ANDROID_E2E_NETWORK_CYCLES === "2" ? 2 : 0;
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
  await persistRebootReadiness();
  const beforeBootId = (await adbRun(["-s", serial, "shell", "cat", "/proc/sys/kernel/random/boot_id"])).stdout.trim();
  process.stdout.write("ANDROID_REBOOT_E2E seeded delayed work; performing normal runtime reboot\n");
  // Match the user's power-menu restart. A low-level `adb reboot` bypasses framework shutdown,
  // which can discard PackageManager's pending asynchronous receiver-setting writes.
  await adbRun(["-s", serial, "shell", "svc", "power", "reboot"], true);
  const afterBootId = await waitForAndroidBoot(beforeBootId);
  await writeFile(join(diagnosticRoot, "reboot-transition.json"), JSON.stringify({
    command: "shell svc power reboot", beforeBootId, afterBootId
  }, null, 2));
  await waitForReceiptCount(3);
  await runInstrumentation("verifiesDelayedUploadCompletedAfterDeviceReboot");
  const [afterUpload, afterPackage, afterJobs, afterLogcat] = await Promise.all([
    adbRun(["-s", serial, "shell", "run-as", "com.mathnotes.capture", "cat", "files/e2e-reboot-after.json"]),
    adbRun(["-s", serial, "shell", "dumpsys", "package", "com.mathnotes.capture"]),
    adbRun(["-s", serial, "shell", "dumpsys", "jobscheduler"]),
    adbRun(["-s", serial, "logcat", "-d", "-t", "12000"])
  ]);
  await Promise.all([
    writeFile(join(diagnosticRoot, "after-reboot-upload.json"), afterUpload.stdout),
    writeFile(join(diagnosticRoot, "after-reboot-package.txt"), afterPackage.stdout),
    writeFile(join(diagnosticRoot, "after-reboot-jobs.txt"), afterJobs.stdout),
    writeFile(join(diagnosticRoot, "after-reboot-logcat.txt"), afterLogcat.stdout)
  ]);
  if (networkCycles) await verifyNetworkRecoveryCycles();

  const sessionDir = join(root, "notebooks", notebookId, "sessions", sessionId);
  const uploads = JSON.parse(await readFile(join(sessionDir, "logs", "uploads.json"), "utf8")) as Array<Record<string, unknown>>;
  const pdfUploads = JSON.parse(await readFile(join(sessionDir, "logs", "pdf_uploads.json"), "utf8")) as Array<Record<string, unknown>>;
  const jobs = JSON.parse(await readFile(join(sessionDir, "logs", "recognition_jobs.json"), "utf8")) as Array<Record<string, unknown>>;
  const session = JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8")) as {
    blocks: Array<{ type: string }>;
  };
  const photos = await readdir(join(sessionDir, "assets", "photos"));

  assert.equal(uploads.length, 3 + networkCycles, "Probe, duplicate retry or rejected uploads created unexpected Windows receipts");
  assert.equal(pdfUploads.length, 1, "Android PDF upload did not create exactly one durable PDF receipt");
  assert.equal(pdfUploads[0]?.pageCount, 1, "Windows did not inspect the uploaded PDF page count");
  assert.equal(await pathExists(String(pdfUploads[0]?.sourcePath)), true, "Windows did not retain the uploaded PDF inbox file");
  assert.equal(jobs.length, 3 + networkCycles, "Accepted captures created an unexpected number of recognition jobs");
  assert.ok(jobs.every((job) => job.status === "succeeded"), "Mock recognition did not finish cleanly");
  assert.equal(session.blocks.filter((block) => block.type === "image").length, 3 + networkCycles);
  assert.equal(session.blocks.filter((block) => block.type === "markdown").length, 4 + networkCycles);
  assert.equal(photos.length, 3 + networkCycles, "Windows did not retain exactly the accepted JPEG assets");
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
    `ANDROID_WINDOWS_E2E_OK serial=${serial} receipts=${uploads.length} pdfs=${pdfUploads.length} photos=${photos.length} jobs=${jobs.length} reboot=passed networkCycles=${networkCycles}\n`
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

async function waitForAndroidBoot(beforeBootId: string): Promise<string> {
  await adbRun(["-s", serial, "wait-for-device"]);
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const result = await adbRun(["-s", serial, "shell", "getprop", "sys.boot_completed"], true);
    if (result.stdout.trim() === "1") {
      const bootId = (await adbRun(["-s", serial, "shell", "cat", "/proc/sys/kernel/random/boot_id"], true)).stdout.trim();
      if (/^[a-f0-9-]{36}$/u.test(bootId) && bootId !== beforeBootId) return bootId;
    }
    await delay(2_000);
  }
  throw new Error(`Android emulator ${serial} did not finish booting`);
}

async function persistRebootReadiness(): Promise<void> {
  const readiness = await adbRun(["-s", serial, "shell", "run-as", "com.mathnotes.capture", "cat", "files/e2e-reboot-before.json"]);
  const payload = JSON.parse(readiness.stdout) as { captureId?: string; workName?: string; workSpecId?: string; workState?: string; jobId?: number; receiverEnabled?: boolean; requiresNetwork?: boolean };
  const [packageState, jobs] = await Promise.all([
    adbRun(["-s", serial, "shell", "dumpsys", "package", "com.mathnotes.capture"]),
    adbRun(["-s", serial, "shell", "dumpsys", "jobscheduler"])
  ]);
  await Promise.all([
    writeFile(join(diagnosticRoot, "before-reboot-work.json"), readiness.stdout),
    writeFile(join(diagnosticRoot, "before-reboot-package.txt"), packageState.stdout),
    writeFile(join(diagnosticRoot, "before-reboot-jobs.txt"), jobs.stdout)
  ]);
  assert.equal(payload.workName, `mathnotes-upload-${payload.captureId}`);
  assert.equal(payload.workState, "ENQUEUED");
  assert.equal(payload.receiverEnabled, true, "WorkManager's reboot receiver was not enabled inside instrumentation");
  assert.equal(payload.requiresNetwork, false, "The upload job must not depend on public Internet validation");
  assert.ok(payload.workSpecId && Number.isInteger(payload.jobId), "The precise reboot capture has no scheduled JobId");
  // JobScheduler dumps on newer Android parcel the extras instead of printing the WorkSpec UUID.
  // The live instrumentation mapped this exact UUID to jobId; confirm that job remains registered.
  assert.match(jobs.stdout, new RegExp(`^  JOB #u\\d+a\\d+/${payload.jobId}:[^\\n]*com\\.mathnotes\\.capture/androidx\\.work\\.impl\\.background\\.systemjob\\.SystemJobService`, "m"),
    "The precise mapped upload JobId disappeared from JobScheduler before reboot");
  process.stdout.write(`ANDROID_REBOOT_WORK_READY capture=${payload.captureId} work=${payload.workSpecId} job=${payload.jobId} receiver=enabled diagnostics=${diagnosticRoot}\n`);
  await delay(1_000); // Preserve the original pre-reboot settling interval.
}

async function verifyNetworkRecoveryCycles(): Promise<void> {
  assert.equal(serial, "emulator-5580", "Network changes are authorized only on this task emulator");
  const avd = await adbRun(["-s", serial, "emu", "avd", "name"]);
  assert.ok(avd.stdout.split(/[\r\n]+/u).includes("MathNotesPolish20260907"));
  const wifi = (await adbRun(["-s", serial, "shell", "settings", "get", "global", "wifi_on"])).stdout.trim();
  const data = (await adbRun(["-s", serial, "shell", "settings", "get", "global", "mobile_data"])).stdout.trim();
  assert.match(wifi, /^[01]$/u);
  assert.match(data, /^[01]$/u);
  await writeFile(join(diagnosticRoot, "network-original-state.json"), JSON.stringify({ serial, wifi, data }, null, 2));
  let previousGeneration = "";
  let previousSha256 = "";
  try {
    for (let cycle = 1; cycle <= networkCycles; cycle++) {
      await adbRun(["-s", serial, "shell", "svc", "wifi", "disable"]);
      await adbRun(["-s", serial, "shell", "svc", "data", "disable"]);
      await runInstrumentation("seedsOfflineUploadWithRealLongWorkManagerBackoff", { networkCycle: String(cycle) });
      const before = await adbRun(["-s", serial, "shell", "run-as", "com.mathnotes.capture", "cat", `files/e2e-network-before-${cycle}.json`]);
      await writeFile(join(diagnosticRoot, `network-before-${cycle}.json`), before.stdout);
      const snapshot = JSON.parse(before.stdout) as { generation: string; sha256: string; connected: boolean; workAttempts: number; captureAttempts: number; nextScheduledAt: number; observedAt: number };
      assert.equal(snapshot.connected, false);
      assert.equal(snapshot.workAttempts, 1);
      assert.equal(snapshot.captureAttempts, 0);
      assert.ok(snapshot.nextScheduledAt > snapshot.observedAt + 30 * 60_000);
      assert.ok(snapshot.generation && snapshot.generation !== previousGeneration, "Each offline registration must use a new PI identity");
      previousGeneration = snapshot.generation;
      assert.match(snapshot.sha256, /^[a-f0-9]{64}$/u);
      assert.notEqual(snapshot.sha256, previousSha256, "Each network cycle needs different JPEG bytes, otherwise Windows correctly deduplicates it");
      previousSha256 = snapshot.sha256;
      let pid = "";
      for (let attempt = 0; attempt < 40; attempt++) {
        pid = (await adbRun(["-s", serial, "shell", "pidof", "com.mathnotes.capture"], true)).stdout.trim();
        if (!pid) break;
        await delay(100);
      }
      assert.equal(pid, "", "Instrumentation must have exited; do not force-stop or wake the process for this test");
      const packageState = (await adbRun(["-s", serial, "shell", "dumpsys", "package", "com.mathnotes.capture"])).stdout;
      assert.match(packageState, /stopped=false/u, "The app must remain eligible for OS delivery, not force-stopped");
      await writeFile(join(diagnosticRoot, `network-process-exited-${cycle}.json`), JSON.stringify({ pid, forceStopped: false, at: Date.now() }, null, 2));
      await writeFile(join(diagnosticRoot, `network-package-before-${cycle}.txt`), packageState);
      process.stdout.write(`ANDROID_NETWORK_E2E cycle=${cycle} offline retry=1 backoff=1h process=exited; restoring emulator Wi-Fi\n`);
      const restoredAt = Date.now();
      await adbRun(["-s", serial, "shell", "svc", "wifi", "enable"]);
      await waitForReceiptCount(3 + cycle); // No app launch, manual wake broadcast, or forced job.
      const receiptAt = Date.now();
      await runInstrumentation("verifiesUploadWokenByTheRealNetworkAfterProcessExit", { networkCycle: String(cycle) });
      const after = await adbRun(["-s", serial, "shell", "run-as", "com.mathnotes.capture", "cat", `files/e2e-network-after-${cycle}.json`]);
      const logcat = await adbRun(["-s", serial, "logcat", "-d", "-t", "12000"]);
      await Promise.all([
        writeFile(join(diagnosticRoot, `network-after-${cycle}.json`), after.stdout),
        writeFile(join(diagnosticRoot, `network-timing-${cycle}.json`), JSON.stringify({ restoredAt, receiptAt, elapsedMs: receiptAt - restoredAt }, null, 2)),
        writeFile(join(diagnosticRoot, `network-logcat-${cycle}.txt`), logcat.stdout)
      ]);
      process.stdout.write(`ANDROID_NETWORK_E2E cycle=${cycle} passed receiptAfterRestoreMs=${receiptAt - restoredAt}\n`);
    }
  } finally {
    await adbRun(["-s", serial, "shell", "svc", "wifi", wifi === "1" ? "enable" : "disable"]);
    await adbRun(["-s", serial, "shell", "svc", "data", data === "1" ? "enable" : "disable"]);
    const afterWifi = (await adbRun(["-s", serial, "shell", "settings", "get", "global", "wifi_on"])).stdout.trim();
    const afterData = (await adbRun(["-s", serial, "shell", "settings", "get", "global", "mobile_data"])).stdout.trim();
    await writeFile(join(diagnosticRoot, "network-restored-state.json"), JSON.stringify({ wifi: afterWifi, data: afterData }, null, 2));
    assert.equal(afterWifi, wifi);
    assert.equal(afterData, data);
  }
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
  const scheduling = await adbRun(["-s", serial, "shell", "run-as", "com.mathnotes.capture", "cat", "files/e2e-upload-scheduling.jsonl"], true);
  if (scheduling.stdout.trim().startsWith("{")) {
    await writeFile(join(diagnosticRoot, `${method}-scheduling.jsonl`), scheduling.stdout);
  }
  if (/FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed/i.test(result.stdout + result.stderr)) {
    const logcat = await adbRun(["-s", serial, "logcat", "-d", "-t", "12000"], true);
    await writeFile(join(diagnosticRoot, `${method}-logcat.txt`), logcat.stdout);
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
