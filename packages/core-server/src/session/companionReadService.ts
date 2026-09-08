import { lstat, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { markdownContinuationGroups, type SessionRecord } from "@mathnotes/shared";
import { CompanionAssetError, type CompanionAsset, type CompanionSessionAsset, type CompanionSessionSnapshot } from "../api/networkApiContracts";
import { renderPortableMarkdown, originalImagePath } from "../render/portableMarkdown";
import { sessionAssetPathFromMarkdown } from "../domain/sessionAssetPath";
import { COMPANION_READER_STYLE } from "./companionReaderStyle";

export interface CompanionSessionStore {
  readSession(notebookId: string, sessionId: string): Promise<SessionRecord>;
  getSessionDir(notebookId: string, sessionId: string): string;
}

export async function buildCompanionSessionSnapshot(args: {
  store: CompanionSessionStore;
  notebookId: string;
  sessionId: string;
}): Promise<CompanionSessionSnapshot> {
  const session = await args.store.readSession(args.notebookId, args.sessionId);
  const sessionDir = args.store.getSessionDir(args.notebookId, args.sessionId);
  const sections: string[] = [];
  const markdownSections: string[] = [];
  const assets = new Map<string, CompanionSessionAsset>();

  const groups = new Map(markdownContinuationGroups(session.blocks).map(group => [group[0].id, group]));
  for (const block of session.blocks) {
    if (block.renderInNote === false) continue;
    if (block.type === "pdf") {
      const target = resolve(sessionDir, block.path);
      assertInside(resolve(sessionDir, "assets"), target);
      await stat(target);
      const assetPath = relative(sessionDir, target).replaceAll("\\", "/");
      const id = createHash("sha256").update(assetPath).digest("hex").slice(0, 24);
      assets.set(id, { id, path: assetPath, mimeType: "application/pdf" });
      const pageLabel = block.pageCount && block.pageCount > 0 ? `${block.pageCount} 页` : "页数待确认";
      sections.push(
        `<section class="note-block pdf-block" id="mathnotes-block-${escapeAttribute(block.id)}" data-block-id="${escapeAttribute(block.id)}">` +
        `<strong>${escapeHtml(block.sourceName || "PDF 文档")}</strong>` +
        `<span>PDF · ${pageLabel}</span></section>`
      );
      continue;
    }
    if (block.type !== "markdown" || !groups.has(block.id)) continue;
    const group = groups.get(block.id)!;
    const markdownPath = resolve(sessionDir, block.path);
    assertInside(sessionDir, markdownPath);
    const markdown = (await Promise.all(group.map(async member => {
      const path = resolve(sessionDir, member.path);
      assertInside(sessionDir, path);
      return readFile(path, "utf8");
    }))).join("");
    const rendered = await renderCompanionMarkdown({ markdown, markdownPath, sessionDir, assets, sourceImagePath: originalImagePath(block), blockId: block.id, continuationBlockIds: group.slice(1).map(member => member.id) });
    const aliases = group.slice(1).map(member => `<span id="mathnotes-block-${escapeAttribute(member.id)}" data-block-id="${escapeAttribute(member.id)}"></span>`).join("");
    sections.push(`<section class="note-block" id="mathnotes-block-${escapeAttribute(block.id)}" data-block-id="${escapeAttribute(block.id)}">${aliases}${rendered}</section>`);
    markdownSections.push(group.map(member => `<!-- block:${member.id} source:${member.source} -->`).join("\n") + "\n" + (block.continuationGroup ? markdown : markdown.trimEnd()));
  }

  const body = sections.join("\n");
  const revision = createHash("sha256")
    .update(session.updatedAt)
    .update("\0")
    .update(body)
    .digest("hex");
  return {
    version: 1,
    notebookId: args.notebookId,
    sessionId: args.sessionId,
    title: session.title,
    revision,
    updatedAt: session.updatedAt,
    blockCount: sections.length,
    markdown: markdownSections.join("\n\n"),
    html: companionHtmlDocument(session.title, body),
    assets: [...assets.values()]
  };
}

export async function readCompanionAsset(args: {
  store: CompanionSessionStore;
  notebookId: string;
  sessionId: string;
  assetPath: string;
}): Promise<CompanionAsset> {
  if (isAbsolute(args.assetPath) || !args.assetPath.replaceAll("\\", "/").startsWith("assets/")) {
    throw new CompanionAssetError("invalid_asset_path", 400);
  }
  const sessionDir = args.store.getSessionDir(args.notebookId, args.sessionId);
  const assetsDir = resolve(sessionDir, "assets");
  const target = resolve(sessionDir, args.assetPath);
  try {
    assertInside(assetsDir, target);
  } catch {
    throw new CompanionAssetError("invalid_asset_path", 400);
  }
  try {
    await assertAssetFile(sessionDir, target);
    return { bytes: await readFile(target), mimeType: assetMimeType(target) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CompanionAssetError("asset_not_found", 404);
    }
    throw error;
  }
}

async function renderCompanionMarkdown(args: {
  markdown: string;
  markdownPath: string;
  sessionDir: string;
  assets: Map<string, CompanionSessionAsset>;
  blockId: string;
  continuationBlockIds?: string[];
  sourceImagePath?: string;
}): Promise<string> {
  const rendered = await renderPortableMarkdown({
    markdown: args.markdown,
    sourceImagePath: args.sourceImagePath,
    rewriteImage: async (source) => {
      const assetPath = sessionAssetPathFromMarkdown(source);
      if (!assetPath) {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(source)) return { source: "", missing: true };
        throw new Error("Companion asset path escapes the session root");
      }
      const target = resolve(args.sessionDir, assetPath);
      try {
        await assertAssetFile(args.sessionDir, target);
        const id = createHash("sha256").update(assetPath).digest("hex").slice(0, 24);
        args.assets.set(id, { id, path: assetPath, mimeType: assetMimeType(target) });
        return { source: `mathnotes-companion-asset://${id}` };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof CompanionAssetError)) throw error;
        return { source: "", missing: true };
      }
    }
  });
  const anchored = new Set<string>();
  return rendered.replace(/<img\b[^>]*>/gi, image => {
    const assetId = image.match(/\bsrc="mathnotes-companion-asset:\/\/([a-f0-9]{24})"/)?.[1];
    if (!assetId) return image;
    const aliases = anchored.has(assetId) ? "" : (args.continuationBlockIds ?? []).map(blockId => `<span id="mathnotes-block-${escapeAttribute(blockId)}-asset-${assetId}"></span>`).join("");
    const anchor = anchored.has(assetId) ? "" : ` id="mathnotes-block-${escapeAttribute(args.blockId)}-asset-${assetId}"`;
    anchored.add(assetId);
    return aliases + image.replace(/^<img\b/i, `<img${anchor} data-companion-asset-id="${assetId}"`);
  });
}

async function assertAssetFile(sessionDir: string, target: string): Promise<void> {
  assertInside(resolve(sessionDir, "assets"), target);
  let current = sessionDir;
  for (const part of relative(sessionDir, target).split(sep)) {
    current = resolve(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || (current === target && !entry.isFile())) {
      throw new CompanionAssetError("invalid_asset_path", 400);
    }
  }
}

function companionHtmlDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><meta name="color-scheme" content="light dark">
<style>
${COMPANION_READER_STYLE}
</style></head><body><h1 class="session-title">${escapeHtml(title)}</h1>${body}</body></html>`;
}

function assertInside(root: string, target: string): void {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error("Companion asset path escapes the session root");
  }
}

function assetMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".pdf": return "application/pdf";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return "image/png";
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
