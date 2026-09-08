import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import MarkdownIt from "markdown-it";
import { createBlockRef, createSessionRecord } from "@mathnotes/shared";
import type { NotebookSessionSummary } from "../catalog/sessionCatalog";
import { encodeMarkdownAssetPath, sessionAssetPathFromMarkdown } from "../domain/sessionAssetPath";
import { exportSessionMarkdown } from "./sessionExportService";
import { SessionWriteCoordinator } from "./sessionWriteCoordinator";
import { extractShareZip, safeSharePath, shareFiles, SHARE_LIMITS, SharePackageError, zipShareDirectory } from "./sharePackageArchive";

export type SharePackageImport = { packagePath: string; notebookId?: string; title?: string };
export type SharePackageImportResult = { session: NotebookSessionSummary; assetCount: number; byteLength: number };
export class SessionSharePackageService {
  constructor(private readonly rootDir: string, private readonly writes: SessionWriteCoordinator) {}

  async exportZip(input: { notebookId: string; sessionId: string; baseRevision?: string }): Promise<{ bytes: Buffer; fileName: string }> {
    return this.writes.run(input.notebookId, input.sessionId, async () => {
      const temporary = await mkdtemp(join(tmpdir(), "mathnotes-share-export-"));
      try {
        const result = await exportSessionMarkdown({ ...input, rootDir: this.rootDir, defaultExportDir: temporary,
          includeMetadataComments: false, mathCompatibility: "portable", packageMode: "share" });
        if (result.missingAssets?.length) throw new SharePackageError("missing_assets", `原笔记缺少 ${result.missingAssets.length} 个引用资源，未生成不完整分享包。`);
        const target = join(temporary, "share.zip");
        await zipShareDirectory(result.packageDir!, target);
        return { bytes: await readFile(target), fileName: `${input.sessionId}_share.zip` };
      } finally { await rm(temporary, { recursive: true, force: true }); }
    });
  }

  async importPackage(input: SharePackageImport): Promise<SharePackageImportResult> {
    if (!isAbsolute(input.packagePath)) throw new SharePackageError("invalid_package", "请选择分享包文件夹、ZIP 或其中的 Markdown。");
    const selected = await lstat(input.packagePath);
    if (selected.isSymbolicLink()) throw new SharePackageError("unsafe_package_path", "不能从符号链接导入分享包。");
    const temporary = await mkdtemp(join(tmpdir(), "mathnotes-share-import-"));
    try {
      let source: string, markdownName: string | undefined;
      if (selected.isDirectory()) source = await realpath(input.packagePath);
      else if (selected.isFile() && extname(input.packagePath).toLowerCase() === ".zip") {
        source = join(temporary, "unpacked"); await mkdir(source);
        try { await extractShareZip(input.packagePath, source); }
        catch (error) {
          if (error instanceof SharePackageError) throw error;
          throw new SharePackageError("corrupt_package", "无法读取 ZIP，分享包可能已损坏或格式不受支持。");
        }
      } else if (selected.isFile() && /\.(md|markdown)$/i.test(input.packagePath)) {
        source = await realpath(dirname(input.packagePath)); markdownName = basename(input.packagePath);
      } else throw new SharePackageError("invalid_package", "请选择分享包文件夹、ZIP 或其中的 Markdown。");
      // Windows exports a root Markdown plus assets/. ZIPs may wrap that folder.
      for (let depth = 0; depth < 4 && !markdownName; depth++) {
        const names = (await readdir(source, { withFileTypes: true })).filter(e => e.name !== "__MACOSX" && !e.name.startsWith("."));
        const candidates = names.filter(e => e.isFile() && /\.(md|markdown)$/i.test(e.name));
        if (candidates.length === 1) { markdownName = candidates[0].name; break; }
        if (candidates.length > 1) throw new SharePackageError("ambiguous_markdown", "文件夹含多份 Markdown，请直接选择要导入的正文文件。");
        if (names.length === 1 && names[0].isDirectory()) { source = join(source, names[0].name); continue; }
        throw new SharePackageError("missing_markdown", "分享包根目录中没有 Markdown 正文。");
      }
      if (!markdownName) throw new SharePackageError("missing_markdown", "未找到分享包正文。");
      safeSharePath(markdownName);
      const markdownFile = join(source, markdownName);
      const markdownStat = await lstat(markdownFile);
      if (!markdownStat.isFile() || markdownStat.size > SHARE_LIMITS.markdownBytes) throw new SharePackageError("invalid_markdown", "正文不是普通文件或超过 8 MB。");
      let markdown: string;
      try { markdown = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(markdownFile)); }
      catch { throw new SharePackageError("invalid_markdown", "正文必须是 UTF-8 文本。"); }
      const assetRoot = join(source, "assets");
      let assets: string[] = [];
      try {
        const assetStat = await lstat(assetRoot);
        if (!assetStat.isDirectory() || assetStat.isSymbolicLink()) throw new SharePackageError("unsafe_package_path", "assets 必须是普通文件夹。");
        assets = (await shareFiles(assetRoot)).map(p => `assets/${p}`);
      } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
      const available = new Set(assets);
      const parser = new MarkdownIt();
      for (const block of parser.parse(markdown, {})) for (const token of block.children ?? []) {
        const target = token.type === "image" ? token.attrGet("src") : token.type === "link_open" ? token.attrGet("href") : null;
        if (!target || /^(https?:|mailto:|#)/i.test(target)) continue;
        const asset = sessionAssetPathFromMarkdown(target);
        if (!asset) throw new SharePackageError("unsafe_asset_reference", "正文含不兼容的本地资源路径，应位于 assets 文件夹中。");
        if (!available.has(asset)) throw new SharePackageError("missing_assets", `分享包缺少资源：${asset}`);
      }
      const title = (input.title?.trim() || basename(markdownName, extname(markdownName))).slice(0, 120) || "导入的笔记";
      // Read everything into a private staging tree before any visible catalog mutation.
      const prepared = join(temporary, "prepared"); await mkdir(join(prepared, "blocks"), { recursive: true });
      let byteLength = Buffer.byteLength(markdown);
      await writeFile(join(prepared, "blocks/0001_imported.md"), markdown);
      for (const asset of assets) {
        if (sessionAssetPathFromMarkdown(encodeMarkdownAssetPath(asset)) !== asset) throw new SharePackageError("unsafe_package_path", "资源文件名不兼容 Windows/Mac。");
        const sourceAsset = join(source, asset), target = join(prepared, asset);
        const actual = await realpath(sourceAsset);
        const within = relative(await realpath(source), actual);
        if (within.startsWith("..") || isAbsolute(within) || !(await lstat(sourceAsset)).isFile()) throw new SharePackageError("unsafe_package_path", "资源路径已改变或超出分享包。");
        await mkdir(dirname(target), { recursive: true }); await copyFile(sourceAsset, target);
        byteLength += (await lstat(target)).size;
        if (byteLength > SHARE_LIMITS.totalBytes) throw new SharePackageError("package_too_large", "分享包超过 256 MB。");
      }
      return await this.writes.runWorkspace(async () => {
        const now = new Date().toISOString();
        const notebookId = input.notebookId || `import_${randomUUID()}`;
        if (notebookId !== basename(notebookId) || /[\\/\x00]/.test(notebookId) || notebookId === "." || notebookId === "..") throw new SharePackageError("invalid_notebook", "无效的 Notebook。");
        const notebooks = resolve(this.rootDir, "notebooks"); await mkdir(notebooks, { recursive: true });
        if ((await lstat(notebooks)).isSymbolicLink()) throw new SharePackageError("invalid_notebook", "笔记目录不能是符号链接。");
        const notebookDir = join(notebooks, notebookId);
        if (input.notebookId) {
          const metadata = await lstat(join(notebookDir, "notebook.json"));
          if (!metadata.isFile() || (await lstat(notebookDir)).isSymbolicLink()) throw new SharePackageError("invalid_notebook", "目标 Notebook 不可用。");
        }
        const sessionId = `import_${randomUUID()}`;
        const session = createSessionRecord({ id: sessionId, title, createdAt: now });
        session.blocks.push(createBlockRef({ id: "0001", type: "markdown", path: "blocks/0001_imported.md", source: "user", createdAt: now }));
        await writeFile(join(prepared, "session.json"), JSON.stringify(session, null, 2));
        // Same-volume staging makes the final rename atomic even when /tmp is on another volume.
        const staging = await mkdtemp(join(this.rootDir, ".share-import-"));
        try {
          const stageSession = input.notebookId ? staging : join(staging, "sessions", sessionId);
          const { cp } = await import("node:fs/promises");
          await cp(prepared, stageSession, { recursive: true, errorOnExist: true });
          if (input.notebookId) {
            const sessions = join(notebookDir, "sessions"); await mkdir(sessions, { recursive: true });
            if ((await lstat(sessions)).isSymbolicLink()) throw new SharePackageError("invalid_notebook", "目标 Session 目录不可用。");
            await rename(staging, join(sessions, sessionId));
          } else {
            await writeFile(join(staging, "notebook.json"), JSON.stringify({ id: notebookId, title, createdAt: now, updatedAt: now }, null, 2));
            await rename(staging, notebookDir);
          }
        } finally { await rm(staging, { recursive: true, force: true }); }
        return { session: { notebookId, sessionId, title, status: session.status, createdAt: now, updatedAt: now }, assetCount: assets.length, byteLength };
      });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}
function hasCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
