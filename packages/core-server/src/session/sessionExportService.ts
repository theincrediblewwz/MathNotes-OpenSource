import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
import { normalizeMathForPortableMarkdown, type SessionRecord } from "@mathnotes/shared";
import { sessionManifestRevision } from "./sessionRevision";

export type ExportSessionMarkdownArgs = {
  rootDir: string;
  notebookId: string;
  sessionId: string;
  includeMetadataComments: boolean;
  defaultExportDir?: string;
  mathCompatibility?: "portable" | "internal";
  packageMode?: "markdown" | "share";
  includeAssistantRemarks?: boolean;
  baseRevision?: string;
};

export type ExportSessionMarkdownResult = {
  outPath: string;
  fileName: string;
  relativeExportPath: string;
  exportedBlocks: number;
  byteLength: number;
  sha256: string;
  packageDir?: string;
  copiedAssets?: string[];
  missingAssets?: string[];
};

export type SessionExportDownload = Readonly<{
  bytes: Buffer;
  fileName: string;
  mimeType: "text/markdown; charset=utf-8";
  sha256: string;
}>;

export class SessionExportError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code);
    this.name = "SessionExportError";
  }
}

export class SessionExportService {
  constructor(private readonly rootDir: string) {}

  exportMarkdown(args: Omit<ExportSessionMarkdownArgs, "rootDir">): Promise<ExportSessionMarkdownResult> {
    return exportSessionMarkdown({ rootDir: this.rootDir, ...args });
  }

  async readMarkdownExport(input: { notebookId: string; sessionId: string }): Promise<SessionExportDownload> {
    const { sessionDir } = await readSession(this.rootDir, input.notebookId, input.sessionId);
    const target = join(sessionDir, "exports", `${input.sessionId}.md`);
    try {
      const bytes = await readFile(target);
      return {
        bytes,
        fileName: basename(target),
        mimeType: "text/markdown; charset=utf-8",
        sha256: hash(bytes)
      };
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) throw new SessionExportError("export_not_found", 404);
      throw error;
    }
  }
}

export async function exportSessionMarkdown(args: ExportSessionMarkdownArgs): Promise<ExportSessionMarkdownResult> {
  const { session, sessionDir } = await readSession(args.rootDir, args.notebookId, args.sessionId);
  if (args.baseRevision && args.baseRevision !== sessionManifestRevision(session)) {
    throw new SessionExportError("revision_conflict", 409);
  }

  const chunks: string[] = [];
  let exportedBlocks = 0;
  for (const block of session.blocks) {
    if (block.type !== "markdown") continue;
    exportedBlocks += 1;
    if (args.includeMetadataComments) chunks.push(`<!-- block:id=${block.id} source=${block.source} -->`);
    const markdownPath = resolve(sessionDir, block.path);
    assertInside(sessionDir, markdownPath);
    const markdown = (await readFile(markdownPath, "utf8")).trimEnd();
    chunks.push(args.mathCompatibility === "internal" ? markdown : normalizeMathForPortableMarkdown(markdown));
  }

  if (args.includeAssistantRemarks) {
    const appendix = await readAssistantAppendix(sessionDir, args.mathCompatibility);
    if (appendix) chunks.push(appendix);
  }

  const combinedMarkdown = chunks.join("\n\n");
  const sharePackage = args.packageMode === "share";
  const packageDir = sharePackage
    ? args.defaultExportDir
      ? resolve(args.defaultExportDir, args.notebookId, `${args.sessionId}_share`)
      : join(sessionDir, "exports", `${args.sessionId}_share`)
    : undefined;
  const outPath = packageDir
    ? join(packageDir, `${args.sessionId}.md`)
    : args.defaultExportDir
      ? resolve(args.defaultExportDir, args.notebookId, `${args.sessionId}.md`)
      : join(sessionDir, "exports", `${args.sessionId}.md`);
  const packageMarkdown = sharePackage
    ? rewriteAssetReferencesForSharePackage(combinedMarkdown)
    : { markdown: combinedMarkdown, assetPaths: new Set<string>() };
  const bytes = Buffer.from(`${packageMarkdown.markdown}\n`, "utf8");

  let assetCopyResult = { copiedAssets: [] as string[], missingAssets: [] as string[] };
  if (packageDir) {
    assetCopyResult = await writeSharePackageAtomically({
      sessionDir,
      packageDir,
      fileName: `${args.sessionId}.md`,
      bytes,
      assetPaths: packageMarkdown.assetPaths
    });
  } else {
    await writeFileAtomically(outPath, bytes);
  }

  return {
    outPath,
    fileName: basename(outPath),
    relativeExportPath: packageDir
      ? posix.join("exports", `${args.sessionId}_share`, `${args.sessionId}.md`)
      : posix.join("exports", `${args.sessionId}.md`),
    exportedBlocks,
    byteLength: bytes.byteLength,
    sha256: hash(bytes),
    packageDir,
    copiedAssets: packageDir ? assetCopyResult.copiedAssets : undefined,
    missingAssets: packageDir ? assetCopyResult.missingAssets : undefined
  };
}

async function writeFileAtomically(target: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const backup = `${target}.mathnotes-backup`;
  await recoverFileSwap(target, backup);
  await cleanupNamedTemps(dirname(target), `${basename(target)}.mathnotes-tmp-`);
  const temporary = `${target}.mathnotes-tmp-${randomUUID()}`;
  await writeFile(temporary, bytes);
  try {
    if (await exists(target)) await renameWithRetry(target, backup);
    await renameWithRetry(temporary, target);
    await rm(backup, { force: true });
  } catch (error) {
    await rm(temporary, { force: true });
    if (!(await exists(target)) && await exists(backup)) await renameWithRetry(backup, target);
    throw error;
  }
}

async function writeSharePackageAtomically(args: {
  sessionDir: string;
  packageDir: string;
  fileName: string;
  bytes: Buffer;
  assetPaths: Set<string>;
}): Promise<{ copiedAssets: string[]; missingAssets: string[] }> {
  await mkdir(dirname(args.packageDir), { recursive: true });
  const backup = `${args.packageDir}.mathnotes-backup`;
  await recoverDirectorySwap(args.packageDir, backup);
  await cleanupNamedTemps(dirname(args.packageDir), `${basename(args.packageDir)}.mathnotes-tmp-`);
  const staging = `${args.packageDir}.mathnotes-tmp-${randomUUID()}`;
  await mkdir(staging, { recursive: true });
  try {
    await writeFile(join(staging, args.fileName), args.bytes);
    const copied = await copyReferencedAssets({
      sessionDir: args.sessionDir,
      packageDir: staging,
      assetPaths: args.assetPaths
    });
    if (await exists(args.packageDir)) await renameWithRetry(args.packageDir, backup);
    await renameWithRetry(staging, args.packageDir);
    await rm(backup, { recursive: true, force: true });
    return copied;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (!(await exists(args.packageDir)) && await exists(backup)) await renameWithRetry(backup, args.packageDir);
    throw error;
  }
}

async function recoverFileSwap(target: string, backup: string): Promise<void> {
  if (!(await exists(backup))) return;
  if (await exists(target)) await rm(backup, { force: true });
  else await renameWithRetry(backup, target);
}

async function recoverDirectorySwap(target: string, backup: string): Promise<void> {
  if (!(await exists(backup))) return;
  if (await exists(target)) await rm(backup, { recursive: true, force: true });
  else await renameWithRetry(backup, target);
}

async function cleanupNamedTemps(parent: string, prefix: string): Promise<void> {
  let entries: string[];
  try { entries = await readdir(parent); } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return;
    throw error;
  }
  await Promise.all(entries.filter((entry) => entry.startsWith(prefix)).map((entry) =>
    rm(join(parent, entry), { recursive: true, force: true })
  ));
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!["EPERM", "EBUSY", "EACCES"].some((code) => isNodeErrorCode(error, code))) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function readSession(rootDir: string, notebookId: string, sessionId: string) {
  const notebooksDir = resolve(rootDir, "notebooks");
  const sessionDir = resolve(notebooksDir, notebookId, "sessions", sessionId);
  assertInside(notebooksDir, sessionDir);
  try {
    const session = JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8")) as SessionRecord;
    if (session.id !== sessionId || !Array.isArray(session.blocks)) throw new SessionExportError("invalid_session", 422);
    return { session, sessionDir };
  } catch (error) {
    if (error instanceof SessionExportError) throw error;
    if (isNodeErrorCode(error, "ENOENT")) throw new SessionExportError("session_not_found", 404);
    if (error instanceof SyntaxError) throw new SessionExportError("invalid_session", 422);
    throw error;
  }
}

async function readAssistantAppendix(sessionDir: string, mathCompatibility: "portable" | "internal" | undefined) {
  try {
    const index = JSON.parse(await readFile(join(sessionDir, "assistant", "index.json"), "utf8")) as {
      remarks?: Array<{ file?: string; mode?: string; focus?: { label?: string }; providerName?: string }>;
    };
    const remarks: string[] = [];
    for (const entry of Array.isArray(index.remarks) ? index.remarks : []) {
      if (!entry.file || !isSafeAssistantRemarkPath(entry.file)) continue;
      try {
        const markdown = (await readFile(join(sessionDir, "assistant", ...entry.file.split("/")), "utf8")).trim();
        if (!markdown) continue;
        const body = mathCompatibility === "internal" ? markdown : normalizeMathForPortableMarkdown(markdown);
        const label = entry.focus?.label?.trim() || "当前 Session";
        const provider = entry.providerName?.trim() ? ` · ${entry.providerName.trim()}` : "";
        remarks.push(`### ${assistantModeLabel(entry.mode)}：${label}\n\n> AI 旁注${provider}\n\n${body}`);
      } catch (error) {
        if (!isNodeErrorCode(error, "ENOENT")) throw error;
      }
    }
    return remarks.length ? `## AI 学习旁注\n\n${remarks.join("\n\n---\n\n")}` : undefined;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT") || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isSafeAssistantRemarkPath(relative: string): boolean {
  const normalized = posix.normalize(relative.replace(/\\/g, "/"));
  return normalized.startsWith("remarks/") && !normalized.includes("../") && normalized.endsWith(".md");
}

function assistantModeLabel(mode: string | undefined): string {
  if (mode === "teach") return "教学";
  if (mode === "summarize") return "总结";
  return "解读";
}

function rewriteAssetReferencesForSharePackage(markdown: string) {
  const assetPaths = new Set<string>();
  const rewritten = markdown.replace(/(!?\[[^\]]*]\()([^) \t\n]+)(\))/g, (match, prefix: string, rawTarget: string, suffix: string) => {
    const assetPath = normalizeSessionAssetPath(rawTarget);
    if (!assetPath) return match;
    assetPaths.add(assetPath);
    return `${prefix}${assetPath}${suffix}`;
  });
  return { markdown: rewritten, assetPaths };
}

function normalizeSessionAssetPath(target: string): string | undefined {
  const withoutAnchor = target.split("#", 1)[0]?.split("?", 1)[0] ?? target;
  const normalized = posix.normalize(withoutAnchor.replace(/\\/g, "/")).replace(/^\.\//, "");
  const assetPath = normalized.startsWith("../assets/") ? normalized.slice(3) : normalized;
  return assetPath.startsWith("assets/") && !assetPath.includes("../") ? assetPath : undefined;
}

async function copyReferencedAssets(args: { sessionDir: string; packageDir: string; assetPaths: Set<string> }) {
  const copiedAssets: string[] = [];
  const missingAssets: string[] = [];
  const assetsDir = resolve(args.sessionDir, "assets");
  for (const assetPath of args.assetPaths) {
    const sourcePath = resolve(args.sessionDir, ...assetPath.split("/"));
    assertInside(assetsDir, sourcePath);
    const targetPath = resolve(args.packageDir, ...assetPath.split("/"));
    assertInside(args.packageDir, targetPath);
    await mkdir(dirname(targetPath), { recursive: true });
    try {
      await copyFile(sourcePath, targetPath);
      copiedAssets.push(assetPath);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) missingAssets.push(assetPath);
      else throw error;
    }
  }
  return { copiedAssets: copiedAssets.sort(), missingAssets: missingAssets.sort() };
}

function assertInside(parent: string, child: string): void {
  const root = resolve(parent);
  const target = resolve(child);
  if (target !== root && !target.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new SessionExportError("path_outside_session", 400);
  }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}
