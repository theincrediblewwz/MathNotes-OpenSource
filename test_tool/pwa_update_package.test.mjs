import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { assertSafeOutputPath, crc32, createZip } from "./package_pwa_update.mjs";
import { safeRelativePath, sha256, verifyPwaUpdate } from "./verify_pwa_update.mjs";
import { assertPublicMaterial, isInternalPublicationPath } from "./public_material_policy.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("public export and archive policy separates internal handoffs from product documentation", () => {
  for (const name of ["apps/macos/CODEX_HANDOFF.md", "deploy/pwa/MAC_CODEX_UPDATE.md", "PWA/MAC_CODEX_HANDOFF.md", "reference/后续交接包.zip", "apps/pwa/AGENTS.md", "NOW.md"]) {
    assert.equal(isInternalPublicationPath(name), true, name);
    assert.throws(() => createZip([{ path: name, bytes: Buffer.from("internal") }]), /Internal collaboration/);
  }
  for (const name of ["README.md", "INTEGRATION.md", "contracts/workspace-sync.md", "deploy/releases/v0.3.4-acceptance.md", "apps/pwa/src/codexProvider.ts"]) {
    assert.equal(isInternalPublicationPath(name), false, name);
    assert.doesNotThrow(() => assertPublicMaterial(name, "# API 与验收\n使用 Codex CLI 作为 Provider。"));
  }
  assert.throws(() => createZip([{path:"PWA/README.md",bytes:Buffer.from("# Mac Codex 接手：用户任务\n内部过程")}]), /Internal collaboration instructions/);
});

test("valid checksums cannot authorize internal documents in a PWA package", async () => {
  await mkdir(path.join(projectRoot, "output"), { recursive: true });
  const root = await mkdtemp(path.join(projectRoot, "output", "pwa-policy-test-"));
  try {
    for (const [name, text] of [["MAC_CODEX_HANDOFF.md", "private notes"], ["README.md", "# 给 Mac Codex 的独立更新包\n用户任务"]]) {
      const bytes=Buffer.from(text);
      await writeFile(path.join(root,name),bytes);
      const manifest={schemaVersion:1,product:"MathNotes PWA Update",files:[{path:name,bytes:bytes.length,sha256:sha256(bytes)}]};
      await writeFile(path.join(root,"artifact-manifest.json"),JSON.stringify(manifest));
      const sums=await Promise.all(["artifact-manifest.json",name].sort().map(async file=>`${sha256(await readFile(path.join(root,file)))}  ${file}`));
      await writeFile(path.join(root,"SHA256SUMS"),`${sums.join("\n")}\n`);
      await assert.rejects(verifyPwaUpdate(root), /Internal collaboration/);
      await rm(path.join(root,name));
    }
  } finally { await assertSafeOutputPath(projectRoot,root); await rm(root,{recursive:true,force:true}); }
});

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
