import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, resolve, sep } from "node:path";
import type { BlockRef, SessionRecord } from "@mathnotes/shared";
import { renderPortableMarkdown } from "../render/portableMarkdown";
import { markdownBlockRevision, markdownLockSummary, sessionManifestRevision } from "./sessionRevision";

export type SessionBlockManifest = Readonly<{
  id: string;
  order: number;
  type: BlockRef["type"];
  source: BlockRef["source"];
  status: BlockRef["status"];
  sourceName: string;
  assetPath?: string;
  sourceAssetPaths?: readonly string[];
  pageCount?: number;
  sourcePageNumber?: number;
  sourcePageImagePath?: string;
  renderInNote: boolean;
  editable: boolean;
  updatedAt: string;
}>;

export type ReadonlySessionManifest = Readonly<{
  version: 1;
  notebookId: string;
  sessionId: string;
  title: string;
  status: SessionRecord["status"];
  updatedAt: string;
  revision: string;
  blocks: readonly SessionBlockManifest[];
}>;

export type ReadonlySessionBlock = Readonly<{
  version: 1;
  notebookId: string;
  sessionId: string;
  block: SessionBlockManifest;
  content: ReadonlySessionBlockContent;
}>;

export type ReadonlySessionBlockContent =
  | Readonly<{
      kind: "markdown";
      html: string;
      markdown: string;
      baseRevision: string;
      blockLocked: boolean;
      protectedSpanCount: number;
    }>
  | Readonly<{ kind: "image"; assetPath: string; mimeType: string }>
  | Readonly<{ kind: "pdf"; assetPath: string; mimeType: "application/pdf" }>;

export type ReadonlySessionAsset = Readonly<{ bytes: Buffer; mimeType: string }>;
export type ReadonlyMarkdownPreview = Readonly<{ version: 1; html: string }>;

export async function readReadonlySessionManifest(args: {
  rootDir: string;
  notebookId: string;
  sessionId: string;
}): Promise<ReadonlySessionManifest> {
  const { session } = await readSession(args);
  const blocks = session.blocks.map(toManifestBlock);
  const revision = sessionManifestRevision(session);
  return {
    version: 1,
    notebookId: args.notebookId,
    sessionId: args.sessionId,
    title: session.title,
    status: session.status,
    updatedAt: session.updatedAt,
    revision,
    blocks
  };
}

export async function readReadonlySessionBlock(args: {
  rootDir: string;
  notebookId: string;
  sessionId: string;
  blockId: string;
}): Promise<ReadonlySessionBlock> {
  const { session, sessionDir } = await readSession(args);
  const order = session.blocks.findIndex((candidate) => candidate.id === args.blockId);
  if (order < 0) throw new SessionReadError("block_not_found", 404);
  const block = session.blocks[order];
  const manifest = toManifestBlock(block, order);

  if (block.type === "markdown") {
    const markdownPath = resolve(sessionDir, block.path);
    assertInside(sessionDir, markdownPath);
    const markdown = await readFile(markdownPath, "utf8");
    const locks = session.locks.filter((lock) => lock.blockId === block.id);
    const lockSummary = markdownLockSummary(locks);
    const html = await renderPortableMarkdown({
      markdown,
      rewriteImage: async (source) => inlineLocalImage({ source, markdownPath, sessionDir })
    });
    return {
      version: 1,
      notebookId: args.notebookId,
      sessionId: args.sessionId,
      block: manifest,
      content: {
        kind: "markdown",
        html: markdownBlockDocument(html),
        markdown,
        baseRevision: markdownBlockRevision({ block, markdown, locks }),
        ...lockSummary
      }
    };
  }

  const assetPath = portableAssetPath(block.path);
  return {
    version: 1,
    notebookId: args.notebookId,
    sessionId: args.sessionId,
    block: manifest,
    content: block.type === "pdf"
      ? { kind: "pdf", assetPath, mimeType: "application/pdf" }
      : { kind: "image", assetPath, mimeType: assetMimeType(assetPath) }
  };
}

export async function renderReadonlyMarkdownPreview(args: {
  rootDir: string;
  notebookId: string;
  sessionId: string;
  blockId: string;
  markdown: string;
}): Promise<ReadonlyMarkdownPreview> {
  const { session, sessionDir } = await readSession(args);
  const block = session.blocks.find((candidate) => candidate.id === args.blockId);
  if (!block) throw new SessionReadError("block_not_found", 404);
  if (block.type !== "markdown") throw new SessionReadError("block_not_markdown", 422);
  const markdownPath = resolve(sessionDir, block.path);
  assertInside(sessionDir, markdownPath);
  const html = await renderPortableMarkdown({
    markdown: args.markdown,
    rewriteImage: async (source) => inlineLocalImage({ source, markdownPath, sessionDir })
  });
  return { version: 1, html: markdownBlockDocument(html) };
}

export async function renderStandaloneMarkdownPreview(markdown: string): Promise<ReadonlyMarkdownPreview> {
  const html = await renderPortableMarkdown({
    markdown,
    rewriteImage: async () => ({ source: "", missing: true })
  });
  return { version: 1, html: markdownBlockDocument(html) };
}

export async function readReadonlySessionAsset(args: {
  rootDir: string;
  notebookId: string;
  sessionId: string;
  assetPath: string;
}): Promise<ReadonlySessionAsset> {
  const { sessionDir } = await readSession(args);
  const portable = portableAssetPath(args.assetPath);
  const assetsDir = resolve(sessionDir, "assets");
  const target = resolve(sessionDir, portable);
  assertInside(assetsDir, target);
  try {
    return { bytes: await readFile(target), mimeType: assetMimeType(target) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SessionReadError("asset_not_found", 404);
    throw error;
  }
}

export class SessionReadError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "SessionReadError";
  }
}

async function readSession(args: { rootDir: string; notebookId: string; sessionId: string }) {
  const notebooksDir = resolve(args.rootDir, "notebooks");
  const sessionDir = resolve(notebooksDir, args.notebookId, "sessions", args.sessionId);
  assertInside(notebooksDir, sessionDir);
  try {
    const session = JSON.parse(await readFile(resolve(sessionDir, "session.json"), "utf8")) as SessionRecord;
    if (session.id !== args.sessionId || !Array.isArray(session.blocks)) throw new SessionReadError("invalid_session", 422);
    return { session, sessionDir };
  } catch (error) {
    if (error instanceof SessionReadError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SessionReadError("session_not_found", 404);
    if (error instanceof SyntaxError) throw new SessionReadError("invalid_session", 422);
    throw error;
  }
}

function toManifestBlock(block: BlockRef, order = 0): SessionBlockManifest {
  return {
    id: block.id,
    order,
    type: block.type,
    source: block.source,
    status: block.status,
    sourceName: block.sourceName || basename(block.path),
    ...(block.type !== "markdown" ? { assetPath: portableAssetPath(block.path) } : {}),
    ...(block.fromAssets?.length
      ? { sourceAssetPaths: block.fromAssets.map((assetPath) => portableAssetPath(assetPath)) }
      : {}),
    pageCount: block.pageCount,
    sourcePageNumber: block.sourcePageNumber,
    sourcePageImagePath: block.sourcePageImagePath,
    renderInNote: block.type === "image" ? block.renderInNote === true : block.renderInNote !== false,
    editable: block.type === "markdown" && block.readonly !== true &&
      ["user", "user_revision", "mixed", "ai_transcription"].includes(block.source) && block.status !== "locked",
    updatedAt: block.updatedAt
  };
}

async function inlineLocalImage(args: { source: string; markdownPath: string; sessionDir: string }) {
  if (/^(?:data:|https?:|\/\/|#)/i.test(args.source) || isAbsolute(args.source)) {
    return { source: "", missing: true };
  }
  const target = resolve(dirname(args.markdownPath), args.source);
  try {
    assertInside(resolve(args.sessionDir, "assets"), target);
    const info = await stat(target);
    if (info.size > 12 * 1024 * 1024) return { source: "", missing: true };
    const bytes = await readFile(target);
    return { source: `data:${assetMimeType(target)};base64,${bytes.toString("base64")}` };
  } catch (error) {
    if (error instanceof SessionReadError || (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { source: "", missing: true };
    }
    throw error;
  }
}

function portableAssetPath(path: string): string {
  const portable = path.replaceAll("\\", "/");
  if (isAbsolute(path) || !portable.startsWith("assets/") || portable.includes("../")) {
    throw new SessionReadError("invalid_asset_path", 400);
  }
  return portable;
}

function assertInside(root: string, target: string): void {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) {
    throw new SessionReadError("path_outside_session", 400);
  }
}

function assetMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".pdf": return "application/pdf";
    default: return "image/png";
  }
}

export function markdownBlockDocument(body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><style>
:root{color-scheme:light dark;--ink:#242520;--muted:#66675f;--line:#e4e5df;--code:#f1f2ee;--quote:#6f9c87;--error:#ad5147}*{box-sizing:border-box}html,body{width:100%;max-width:100%;overflow-x:hidden}body{margin:0;padding:18px 20px 22px;background:transparent;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"Noto Sans SC",sans-serif;font-size:16px;line-height:1.68;letter-spacing:0}h1,h2,h3,h4,p,li,blockquote{min-width:0;max-width:100%;overflow-wrap:anywhere;white-space:normal}h1,h2,h3,h4{line-height:1.32;margin:8px 0 12px}p{margin:8px 0}ul,ol{padding-left:1.45em}blockquote{margin:12px 0;padding-left:12px;border-left:3px solid var(--quote);color:var(--muted)}pre{max-width:100%;overflow-x:auto;padding:12px;background:var(--code);border-radius:6px;white-space:pre-wrap}code{font-family:"SFMono-Regular",Menlo,monospace}.math-inline{display:inline-block;max-width:100%;vertical-align:-.12em}.math-display{width:100%;max-width:100%;margin:14px 0;overflow-x:auto;overflow-y:hidden;text-align:center}.katex>.katex-html{display:none!important}.katex>.katex-mathml{display:inline}.math-display .katex>.katex-mathml{display:block}.math-display math[display="block"]{display:block;width:max-content;min-width:100%;margin:0}table{display:block;width:100%;max-width:100%;overflow-x:auto;border-collapse:collapse}img,svg{display:block;max-width:100%;height:auto;margin:12px auto;border-radius:6px}.math-error{color:var(--error);white-space:pre-wrap}@media(prefers-color-scheme:dark){:root{--ink:#eeeeea;--muted:#aaa99f;--line:#3d403a;--code:#282b27;--quote:#75b99a;--error:#e49a91}}
</style></head><body>${body}<script>const send=()=>window.webkit?.messageHandlers?.height?.postMessage(Math.ceil(document.documentElement.scrollHeight));new ResizeObserver(send).observe(document.body);window.addEventListener('load',send);send();</script></body></html>`;
}
