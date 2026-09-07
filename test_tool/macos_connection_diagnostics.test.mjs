import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { probeSidecar, failureKinds } from "./diagnose_macos_connection.mjs";
import { macosBuildRevision } from "./macos_build_info.mjs";

async function fixture(t, source) {
  const root = await mkdtemp(path.join(tmpdir(), "mathnotes-diagnostic-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, "fixture.mjs");
  await writeFile(script, source);
  return { executable: process.execPath, script, companion: false, timeoutMs: 4_000 };
}

test("diagnostic reports pre-ready exit without leaking stderr, paths, or credentials", async (t) => {
  const options = await fixture(t, `console.error('EACCES /private/notes sk-do-not-share'); process.exit(7);`);
  const result = await probeSidecar(options);
  assert.equal(result.state, "exited_before_ready");
  assert.equal(result.exitCode, 7);
  assert.deepEqual(result.errors, ["EACCES"]);
  assert.doesNotMatch(JSON.stringify(result), /private|sk-do-not-share/);
});

test("diagnostic catches a child which exits by signal", async (t) => {
  const options = await fixture(t, `process.kill(process.pid, 'SIGKILL');`);
  const result = await probeSidecar(options);
  assert.equal(result.state, "exited_before_ready");
  assert.ok(result.exitCode !== 0 || result.signal !== null);
});

test("diagnostic bounds a hung process and removes only its own temporary root", async (t) => {
  const options = await fixture(t, `setInterval(() => {}, 1000);`);
  const result = await probeSidecar({ ...options, timeoutMs: 300 });
  assert.equal(result.state, "timeout");
});

test("diagnostic rejects malformed ready data", async (t) => {
  const options = await fixture(t, `console.log('not JSON'); setInterval(() => {}, 1000);`);
  assert.equal((await probeSidecar(options)).state, "invalid_ready");
});

test("ready requires a real authenticated loopback health response and isolated data paths", async (t) => {
  const options = await fixture(t, `
    import http from 'node:http';
    import path from 'node:path';
    const env = process.env;
    for (const key of ['MATHNOTES_USER_DATA_DIR', 'MATHNOTES_NOTES_ROOT_DIR', 'MATHNOTES_TEMP_DIR']) {
      if (path.dirname(env[key]) !== process.cwd()) process.exit(9);
    }
    if (env.MATHNOTES_COMPANION_ENABLED !== '0') process.exit(10);
    const server = http.createServer((req, res) => {
      res.writeHead(req.headers.authorization === 'Bearer ' + env.MATHNOTES_LOCAL_TOKEN ? 200 : 401);
      res.end('{}');
    }).listen(0, '127.0.0.1', () => console.log(JSON.stringify({
      type: 'mathnotes.ready', host: '127.0.0.1', port: server.address().port
    })));
    process.once('SIGTERM', () => server.close());
  `);
  assert.deepEqual(await probeSidecar(options), { state: "ready", errors: [] });
});

test("only allowlisted failure categories can leave the diagnostic", () => {
  assert.deepEqual(failureKinds("unknown private failure secret=abcdef"), []);
  assert.deepEqual(failureKinds("Error: EADDRINUSE; MODULE_NOT_FOUND"), ["EADDRINUSE", "MODULE_NOT_FOUND"]);
});

test("build identity distinguishes clean/modified source and does not inherit a parent repository", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "mathnotes-build-info-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "--quiet");
  await writeFile(path.join(root, "source.txt"), "source");
  git("add", "source.txt");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
  const clean = macosBuildRevision(root);
  assert.match(clean, /^[a-f0-9]{12,40}$/);
  await writeFile(path.join(root, "source.txt"), "modified");
  assert.equal(macosBuildRevision(root), `${clean}-modified`);
  const exported = path.join(root, "archive");
  await mkdir(exported);
  assert.equal(macosBuildRevision(exported, new Date("2026-09-07T10:11:12Z")), "local-20260907T101112Z");
});
