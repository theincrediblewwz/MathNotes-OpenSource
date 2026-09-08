import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const app = path.resolve(process.argv[2] ?? "output/macos-native/bundle/MathNotes.app");
const root = await mkdtemp(path.join(tmpdir(), "mathnotes-ats-test-"));
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  return result.stdout;
}
const info = JSON.parse(run("plutil", ["-convert", "json", "-o", "-", path.join(app, "Contents/Info.plist")]));
const token = randomBytes(32).toString("hex");
const tokenFile = path.join(root, "fixture-token");
await writeFile(tokenFile, token, { mode: 0o600 });
let requests = 0;
const server = http.createServer((req, res) => {
  requests++;
  const valid = req.url === "/api/v1/pairing/verify" && req.headers.authorization === `Bearer ${token}`;
  res.writeHead(valid ? 200 : 401, { "Content-Type": "application/json" });
  res.end(JSON.stringify(valid ? { ok: true, version: 1, targets: [] } : { ok: false }));
});
try {
  const binary = path.join(root, "Probe");
  run("swiftc", ["-parse-as-library", "-target", "arm64-apple-macosx14.0",
    "apps/macos/Sources/MathNotesMac/CompanionConnection.swift",
    "test_tool/macos_transport_probe.swift", "-o", binary]);
  const probes = {};
  for (const variant of ["baseline", "fixed"]) {
    const contents = path.join(root, `${variant}.app`, "Contents");
    await mkdir(path.join(contents, "MacOS"), { recursive: true });
    const plist = { CFBundleIdentifier: `com.mathnotes.ats-test.${variant}`,
      CFBundleExecutable: "Probe", CFBundlePackageType: "APPL", LSMinimumSystemVersion: "14.0",
      NSLocalNetworkUsageDescription: "验证 MathNotes 私有网络连接。",
      NSAppTransportSecurity: variant === "baseline"
        ? { NSAllowsLocalNetworking: true } : info.NSAppTransportSecurity };
    const plistPath = path.join(contents, "Info.plist");
    await writeFile(plistPath, JSON.stringify(plist));
    run("plutil", ["-convert", "xml1", plistPath]);
    probes[variant] = path.join(contents, "MacOS/Probe");
    await copyFile(binary, probes[variant]);
    run("codesign", ["--force", "--sign", "-", path.dirname(contents)]);
  }
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "0.0.0.0", resolve); });
  const port = server.address().port;
  async function probe(variant, origin, credential = tokenFile) {
    return new Promise((resolve, reject) => {
      const child = spawn(probes[variant], [origin, credential], { stdio: ["ignore", "pipe", "ignore"] });
      let stdout = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
      child.stdout.on("data", data => { stdout += data; });
      child.once("error", reject);
      child.once("close", code => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`probe failed (${code})`));
        try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); }
      });
    });
  }
  const ownAddresses = Object.values(networkInterfaces()).flat().filter(item => item.family === "IPv4"
    && /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(item.address));
  for (const address of ["127.0.0.1", ...ownAddresses.map(item => item.address)]) {
    const origin = `http://${address}:${port}`;
    const result = await probe("fixed", origin);
    assert.deepEqual(result, { status: "ready", targets: 0 });
    // ATS may exempt the host's own addresses even without IP exceptions.
    // The external-host comparison below is needed to reproduce that failure.
  }
  const beforeNegative = requests;
  assert.deepEqual(await probe("fixed", `http://203.0.113.1:${port}`), { status: "error", code: -1022 });
  assert.equal(requests, beforeNegative);
  const wrongToken = path.join(root, "wrong-token");
  await writeFile(wrongToken, "invalid-test-token", { mode: 0o600 });
  assert.deepEqual(await probe("fixed", `http://127.0.0.1:${port}`, wrongToken), { status: "rejected", httpStatus: 401 });
  console.log(`ATS_PRIVATE_HTTP_READY_PUBLIC_HTTP_BLOCKED_AUTH_REJECTION_PRESERVED addresses=${ownAddresses.length + 1}`);
  // Optional real host check: credentials are read from an existing protected
  // file, never command-line token values or output. Does not fetch note bodies.
  if (process.argv[3] && process.argv[4]) {
    const baseline = await probe("baseline", process.argv[3], process.argv[4]);
    console.log(`ATS_REMOTE_BASELINE=${JSON.stringify(baseline)}`);
    assert.deepEqual(baseline, { status: "error", code: -1022 });
    const remote = await probe("fixed", process.argv[3], process.argv[4]);
    console.log(`ATS_REMOTE_FIXED=${JSON.stringify(remote)}`);
    assert.equal(remote.status, "ready");
  }
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
