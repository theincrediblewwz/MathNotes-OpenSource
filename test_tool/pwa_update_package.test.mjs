import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { assertSafeOutputPath, crc32, createZip } from "./package_pwa_update.mjs";
import { safeRelativePath, sha256, verifyPwaUpdate } from "./verify_pwa_update.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("output cleanup cannot target the checkout, output root, or a sibling", async () => {
  assert.equal(await assertSafeOutputPath(projectRoot, path.join(projectRoot, "output", "pwa-update")), path.join(projectRoot, "output", "pwa-update"));
  for (const target of [projectRoot, path.join(projectRoot, "output"), path.join(projectRoot, "apps"), path.resolve(projectRoot, "..", "pwa-update")]) {
    await assert.rejects(assertSafeOutputPath(projectRoot, target), /OUTPUT_BOUNDARY/);
  }
});

test("ZIP uses safe UTF-8 names, standard deflate/CRC, and stable ordering", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const entries = [{ path: "PWA/中文.md", bytes: Buffer.from("你好") }, { path: "PWA/index.html", bytes: Buffer.from("<html>hello</html>") }];
  const archive = createZip(entries);
  assert.deepEqual(archive, createZip([...entries].reverse()));
  let offset = 0; const decoded = [];
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(archive.readUInt16LE(offset + 6), 0x0800);
    const nameLength = archive.readUInt16LE(offset + 26), length = archive.readUInt32LE(offset + 18);
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const bytes = inflateRawSync(archive.subarray(offset + 30 + nameLength, offset + 30 + nameLength + length));
    assert.equal(crc32(bytes), archive.readUInt32LE(offset + 14));
    decoded.push({ path: name, bytes }); offset += 30 + nameLength + length;
  }
  assert.equal(archive.readUInt32LE(offset), 0x02014b50);
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
  assert.deepEqual(decoded, [...entries].sort((a, b) => a.path < b.path ? -1 : 1));
  assert.throws(() => createZip([{ path: "../escape", bytes: Buffer.from("") }]), /Unsafe/);
  assert.throws(() => createZip([entries[0], entries[0]]), /duplicate/);
});

test("manifest paths reject platform escapes and checksum injection", () => {
  for (const name of ["../a", "/a", "C:/a", "dir/../a", "dir\\a", "a\nfile", "a//b"]) assert.equal(safeRelativePath(name), false);
  assert.equal(safeRelativePath("source/apps/pwa/src/App.tsx"), true);
});

test("read-only verifier detects tampered and unexpected payload files", async () => {
  await mkdir(path.join(projectRoot, "output"), { recursive: true });
  const root = await mkdtemp(path.join(projectRoot, "output", "pwa-update-test-"));
  try {
    const data = Buffer.from("<html>test</html>"); await writeFile(path.join(root, "index.html"), data);
    const manifest = { schemaVersion: 1, product: "MathNotes PWA Update", packageVersion: "0.3.3", sourceCommit: "abc", files: [{ path: "index.html", bytes: data.length, sha256: sha256(data) }] };
    await writeFile(path.join(root, "artifact-manifest.json"), JSON.stringify(manifest));
    const sums = await Promise.all(["artifact-manifest.json", "index.html"].map(async name => `${sha256(await readFile(path.join(root, name)))}  ${name}`));
    await writeFile(path.join(root, "SHA256SUMS"), `${sums.join("\n")}\n`);
    assert.equal((await verifyPwaUpdate(root)).files, 1);
    await writeFile(path.join(root, "unexpected.txt"), "extra"); await assert.rejects(verifyPwaUpdate(root), /unexpected/);
    await rm(path.join(root, "unexpected.txt"));
    await writeFile(path.join(root, "index.html"), "tampered"); await assert.rejects(verifyPwaUpdate(root), /Hash mismatch/);
  } finally { await assertSafeOutputPath(projectRoot, root); await rm(root, { recursive: true, force: true }); }
});
