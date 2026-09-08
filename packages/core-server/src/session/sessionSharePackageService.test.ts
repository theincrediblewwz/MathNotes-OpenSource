import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionRecord, createBlockRef } from "@mathnotes/shared";
import { ZipFile } from "yazl";
import { SessionSharePackageService } from "./sessionSharePackageService";
import { SessionWriteCoordinator } from "./sessionWriteCoordinator";
import { exportSessionMarkdown } from "./sessionExportService";
import { encodeMarkdownAssetPath } from "../domain/sessionAssetPath";
import { extractShareZip, safeSharePath } from "./sharePackageArchive";
import { LocalShellServer } from "../api/localShellServer";
import { readReadonlySessionManifest } from "./sessionReadService";

let temp: string, root: string, service: SessionSharePackageService;
const photo = Buffer.from("89504e470d0a1a0a00010203", "hex");
const asset = "assets/embedded/原图 #10% (一).png";
async function folder(markdown = `# 分享笔记\n\n公式 $x^2$\n\n![原图](${encodeMarkdownAssetPath(asset)})\n`) {
  const dir = await mkdtemp(join(temp, "package-"));
  await mkdir(join(dir, "assets/embedded"), { recursive: true });
  await writeFile(join(dir, "课程.md"), markdown);
  await writeFile(join(dir, asset), photo);
  return dir;
}
async function zip(entries: [string, Buffer, Record<string, unknown>?][]) {
  const archive = new ZipFile(), chunks: Buffer[] = [];
  const bytes = new Promise<Buffer>((resolve, reject) => {
    archive.outputStream.on("data", data => chunks.push(data));
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    archive.outputStream.on("error", reject);
  });
  for (const [name, data, options] of entries) archive.addBuffer(data, name, options);
  archive.end();
  const path = join(temp, `share-${Math.random()}.zip`);
  await writeFile(path, await bytes);
  return path;
}
async function assertNoNotes() { expect(await readdir(root)).toEqual([]); }
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "mathnotes-share-test-")); root = join(temp, "notes"); await mkdir(root);
  service = new SessionSharePackageService(root, new SessionWriteCoordinator());
});
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

describe("Windows/Mac share packages", () => {
  it("imports the actual Windows export layout, preserves resource bytes and round-trips a ZIP", async () => {
    const windowsRoot = join(temp, "windows"), sessionDir = join(windowsRoot, "notebooks/n/sessions/s");
    await mkdir(join(sessionDir, "blocks"), { recursive: true }); await mkdir(join(sessionDir, "assets/embedded"), { recursive: true });
    await writeFile(join(sessionDir, asset), photo);
    await writeFile(join(sessionDir, "blocks/1.md"), `# Windows\n\n$E=mc^2$\n\n![照片](${encodeMarkdownAssetPath(asset)})`);
    const session = createSessionRecord({ id: "s", title: "Windows", createdAt: "2026-09-08T00:00:00Z" });
    session.blocks.push(createBlockRef({ id: "1", type: "markdown", path: "blocks/1.md", source: "user", createdAt: "2026-09-08T00:00:00Z" }));
    await writeFile(join(sessionDir, "session.json"), JSON.stringify(session));
    // This is the same shared exporter called by apps/windows/src/core/exporter.ts.
    const exported = await exportSessionMarkdown({ rootDir: windowsRoot, notebookId: "n", sessionId: "s", includeMetadataComments: false, packageMode: "share" });
    const imported = await service.importPackage({ packagePath: exported.packageDir! });
    expect(imported.assetCount).toBe(1);
    const importedDir = join(root, "notebooks", imported.session.notebookId, "sessions", imported.session.sessionId);
    expect(await readFile(join(importedDir, asset))).toEqual(photo);
    expect(await readFile(join(importedDir, "blocks/0001_imported.md"), "utf8")).toEqual(await readFile(exported.outPath, "utf8"));
    const manifest = await readReadonlySessionManifest({ rootDir: root, notebookId: imported.session.notebookId, sessionId: imported.session.sessionId });
    const packed = await service.exportZip({ ...imported.session, baseRevision: manifest.revision });
    const path = join(temp, packed.fileName); await writeFile(path, packed.bytes);
    const unpacked = join(temp, "unpacked"); await mkdir(unpacked); await extractShareZip(path, unpacked);
    expect(await readFile(join(unpacked, asset))).toEqual(photo);
    const again = await service.importPackage({ packagePath: path, notebookId: imported.session.notebookId });
    expect(again.session.sessionId).not.toBe(imported.session.sessionId);
    expect(await readdir(join(root, "notebooks", imported.session.notebookId, "sessions"))).toHaveLength(2);
    expect((await readdir(root)).filter(name => name.startsWith(".share-import"))).toEqual([]);
    await expect(service.exportZip({ ...imported.session, baseRevision: "0".repeat(64) })).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("accepts a wrapped ZIP and explicit Markdown with adjacent assets", async () => {
    const dir = await folder();
    const first = await service.importPackage({ packagePath: join(dir, "课程.md") });
    const path = await zip([["课程_share/课程.md", await readFile(join(dir, "课程.md"))], [`课程_share/${asset}`, photo]]);
    const second = await service.importPackage({ packagePath: path });
    expect(first.assetCount).toBe(1); expect(second.assetCount).toBe(1);
    expect(first.session.notebookId).not.toBe(second.session.notebookId);
  });

  it("rejects missing resources, invalid UTF-8 and ambiguous folders without creating notes", async () => {
    const dir = await folder("![missing](assets/missing.png)");
    await expect(service.importPackage({ packagePath: dir })).rejects.toMatchObject({ code: "missing_assets" }); await assertNoNotes();
    await writeFile(join(dir, "课程.md"), Buffer.from([0xff, 0xff]));
    await expect(service.importPackage({ packagePath: dir })).rejects.toMatchObject({ code: "invalid_markdown" }); await assertNoNotes();
    await writeFile(join(dir, "second.md"), "second");
    await expect(service.importPackage({ packagePath: dir })).rejects.toMatchObject({ code: "ambiguous_markdown" }); await assertNoNotes();
  });

  it("rejects local resource escapes and symlinks before catalog mutation", async () => {
    const dir = await folder("![outside](../../private.png)");
    await expect(service.importPackage({ packagePath: dir })).rejects.toMatchObject({ code: "unsafe_asset_reference" });
    await writeFile(join(dir, "课程.md"), "safe");
    await symlink(join(dir, "课程.md"), join(dir, "assets/link.md"));
    await expect(service.importPackage({ packagePath: dir })).rejects.toMatchObject({ code: "unsafe_package_path" }); await assertNoNotes();
  });

  it("rejects corrupted ZIP data with a failed CRC and no partial import", async () => {
    const path = await zip([["note.md", Buffer.from("UNIQUE-PLAINTEXT"), { compress: false }]]);
    const bytes = await readFile(path); const index = bytes.indexOf("UNIQUE-PLAINTEXT"); expect(index).toBeGreaterThan(0);
    bytes[index] ^= 1; await writeFile(path, bytes);
    await expect(service.importPackage({ packagePath: path })).rejects.toMatchObject({ code: "corrupt_package" }); await assertNoNotes();
  });

  it("rejects case collisions, symbolic-link ZIP entries and malformed archives", async () => {
    const collision = await zip([["note.md", Buffer.from("safe")], ["assets/a.png", photo], ["assets/A.png", photo]]);
    await expect(service.importPackage({ packagePath: collision })).rejects.toMatchObject({ code: "duplicate_package_path" });
    const link = await zip([["note.md", Buffer.from("safe")], ["assets/link", Buffer.from("../../outside"), { mode: 0o120777 }]]);
    await expect(service.importPackage({ packagePath: link })).rejects.toMatchObject({ code: "unsupported_zip_entry" });
    const broken = join(temp, "broken.zip"); await writeFile(broken, "broken");
    await expect(service.importPackage({ packagePath: broken })).rejects.toMatchObject({ code: "corrupt_package" }); await assertNoNotes();
  });

  it("serves authenticated import/export and rejects unauthenticated mutation", async () => {
    const token = "test-local-".repeat(5);
    const server = new LocalShellServer({ port: 0, token, sharePackages: service });
    const started = await server.start();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    try {
      const path = await folder();
      const url = `${started.url}/local/v1/workspace/share/import`;
      expect((await fetch(url, { method: "POST", body: JSON.stringify({ packagePath: path }) })).status).toBe(401);
      await assertNoNotes();
      const importedResponse = await fetch(url, { method: "POST", headers, body: JSON.stringify({ packagePath: path }) });
      expect(importedResponse.status).toBe(200);
      const imported = await importedResponse.json() as { session: { notebookId: string; sessionId: string } };
      const manifest = await readReadonlySessionManifest({ rootDir: root, ...imported.session });
      const query = new URLSearchParams({ ...imported.session, baseRevision: manifest.revision });
      const exported = await fetch(`${started.url}/local/v1/session/share/export?${query}`, { method: "POST", headers });
      expect(exported.status).toBe(200); expect(exported.headers.get("content-type")).toContain("application/zip");
      expect(Buffer.from(await exported.arrayBuffer()).subarray(0, 2).toString()).toBe("PK");
    } finally { await server.stop(); }
  });

  it("rejects traversal and deep paths on both platforms", () => {
    for (const path of ["../secret", "/etc/passwd", "a/../../b", "C:/file", "a\\b", "assets/CON.png", "a/".repeat(33) + "file"]) {
      expect(() => safeSharePath(path)).toThrow();
    }
  });
});
