import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import MarkdownIt from "markdown-it";
import type { SessionRecord } from "@mathnotes/shared";
import { readNotesCatalog } from "../catalog/sessionCatalog";
import { isSafeWorkspaceIdentifier } from "../session/workspaceIdentifier";

export type ReplicaAsset = { path: string; sha256: string; byteLength: number };
export type ReplicaSnapshot = {
  version: 1; notebookId: string; session: SessionRecord;
  markdown: Record<string, string>; assets: ReplicaAsset[]; revision: string;
};
export type ReplicaPush = { operationId: string; baseRevision: string; snapshot: ReplicaSnapshot };
type SyncSession = SessionRecord & { remoteSyncOperations?: Record<string, string> };
export type SessionSyncCoordinator = <T>(notebookId: string, sessionId: string, operation: () => Promise<T>) => Promise<T>;
export type WorkspaceSyncOptions = { beforeCommit?: () => Promise<void> };
export class WorkspaceSyncError extends Error {
  constructor(readonly code: string, readonly statusCode: number) { super(code); }
}
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_ASSET_BYTES = 54 * 1024 * 1024;
const parser = new MarkdownIt({ html: false });
// Accept local image syntax for validation even when markdown-it's default URL
// policy would suppress it. Unsafe destinations must be rejected, never ignored.
parser.validateLink = () => true;

/** Uses the application's existing Session queue; constructing a second lock is unsafe. */
export class WorkspaceSyncService {
  private identityPending?: Promise<{ version: 1; hostId: string; name: string }>;
  constructor(private readonly rootDir: string, private readonly stateDir: string,
    private readonly coordinate: SessionSyncCoordinator, private readonly options: WorkspaceSyncOptions = {}) {
    if (typeof coordinate !== "function") throw new Error("workspace_sync_coordinator_required");
  }

  identity(): Promise<{ version: 1; hostId: string; name: string }> {
    return this.identityPending ??= this.readIdentity().catch(error => { this.identityPending = undefined; throw error; });
  }
  private async readIdentity(): Promise<{ version: 1; hostId: string; name: string }> {
    await mkdir(this.stateDir, { recursive: true });
    const target = await safeReplicaPath(this.stateDir, "workspace-host-id", true);
    // Publishing a complete temporary file with an exclusive hard link prevents
    // concurrent instances from reading a just-created, still-empty identity.
    const temporary = `${target}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(randomUUID(), "utf8");
      await handle.sync();
      await handle.close(); handle = undefined;
      await link(temporary, target);
    } catch (error) { if (errno(error) !== "EEXIST") throw error; }
    finally { await handle?.close(); await rm(temporary, { force: true }); }
    const hostId = (await readFile(await safeReplicaPath(this.stateDir, "workspace-host-id"), "utf8")).trim();
    if (!UUID.test(hostId)) throw new WorkspaceSyncError("invalid_host_identity", 500);
    return { version: 1, hostId, name: "MathNotes" };
  }
  catalog() { return readNotesCatalog({ rootDir: this.rootDir }); }
  async snapshot(notebookId: string, sessionId: string): Promise<ReplicaSnapshot> {
    validateReplicaId(notebookId); validateReplicaId(sessionId);
    return this.coordinate(notebookId, sessionId, () => this.readSnapshot(notebookId, sessionId));
  }
  async asset(notebookId: string, sessionId: string, path: string, expectedHash: string): Promise<Buffer> {
    validateReplicaId(notebookId); validateReplicaId(sessionId); validateReplicaPath(path);
    return this.coordinate(notebookId, sessionId, async () => {
      const snapshot = await this.readSnapshot(notebookId, sessionId);
      if (!snapshot.assets.some(asset => asset.path === path && asset.sha256 === expectedHash)) fail("asset_changed", 409);
      const bytes = await this.readAsset(await this.sessionDir(notebookId, sessionId), path);
      if (hash(bytes) !== expectedHash) fail("asset_changed", 409);
      return bytes;
    });
  }
  async stageAsset(input: { operationId: string; sha256: string; base64: string }): Promise<void> {
    if (!isRecord(input)) fail("invalid_request", 400);
    validateOperationId(input.operationId);
    if (typeof input.sha256 !== "string" || !HASH.test(input.sha256) || typeof input.base64 !== "string" ||
      input.base64.length > 72 * 1024 * 1024 || input.base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)) fail("invalid_asset", 400);
    const bytes = Buffer.from(input.base64, "base64");
    if (bytes.toString("base64") !== input.base64) fail("invalid_asset", 400);
    if (bytes.length > MAX_ASSET_BYTES) fail("asset_too_large", 413);
    if (hash(bytes) !== input.sha256) fail("asset_hash_mismatch", 400);
    await mkdir(this.stateDir, { recursive: true });
    const relative = `incoming/${input.operationId}/${input.sha256}`;
    await ensureParents(this.stateDir, relative);
    const target = await safeReplicaPath(this.stateDir, relative, true);
    // Concurrent stages have identical verified bytes. Atomic rename means readers
    // see either the previous complete file or the next complete file.
    await atomicWrite(target, bytes);
  }
  async push(input: ReplicaPush): Promise<ReplicaSnapshot> {
    if (!isRecord(input)) fail("invalid_request", 400);
    validateOperationId(input.operationId);
    validateReplicaSnapshot(input.snapshot);
    if (typeof input.baseRevision !== "string" || !HASH.test(input.baseRevision)) fail("invalid_revision", 400);
    const { notebookId, session } = input.snapshot;
    const sessionId = session.id;
    // Capture the exact JSON request before waiting, so a caller cannot mutate it
    // while queued and change either the ledger fingerprint or validated content.
    const requestHash = hash(JSON.stringify(input));
    const request = structuredClone(input);
    return this.coordinate(notebookId, sessionId, async () => {
      const current = await this.readSnapshot(notebookId, sessionId);
      const operations = (current.session as SyncSession).remoteSyncOperations ?? {};
      if (Object.hasOwn(operations, request.operationId)) {
        if (operations[request.operationId] !== requestHash) fail("operation_reused", 409);
        return current;
      }
      if (request.baseRevision !== current.revision) fail("revision_conflict", 409);
      validatePreviousLocks(current, request.snapshot);
      const directory = await this.sessionDir(notebookId, sessionId);
      const next: SyncSession = structuredClone(request.snapshot.session);
      next.createdAt = current.session.createdAt;
      next.updatedAt = new Date().toISOString();
      next.remoteSyncOperations = Object.fromEntries([...Object.entries(operations).slice(-1023), [request.operationId, requestHash]]);
      // Verify every asset before publishing even unreferenced content. In particular,
      // embedded Markdown destinations cannot first fail after session.json commits.
      const staged: Array<{ asset: ReplicaAsset; source: string }> = [];
      for (const asset of request.snapshot.assets) {
        const present = current.assets.find(candidate => canonicalPath(candidate.path) === canonicalPath(asset.path));
        if (present) {
          if (present.path !== asset.path || present.sha256 !== asset.sha256 || present.byteLength !== asset.byteLength) fail("immutable_asset_conflict", 409);
          continue;
        }
        const existing = await safeReplicaPath(directory, asset.path, true);
        try {
          const bytes = await boundedRead(existing);
          if (hash(bytes) !== asset.sha256 || bytes.length !== asset.byteLength) fail("immutable_asset_conflict", 409);
          continue;
        } catch (error) { if (errno(error) !== "ENOENT") throw error; }
        let bytes: Buffer; let source: string;
        try { source = await safeReplicaPath(this.stateDir, `incoming/${request.operationId}/${asset.sha256}`); bytes = await boundedRead(source); }
        catch (error) { if (errno(error) === "ENOENT" || error instanceof WorkspaceSyncError && error.code === "item_not_found") fail("asset_not_staged", 409); throw error; }
        if (hash(bytes) !== asset.sha256 || bytes.length !== asset.byteLength) fail("asset_hash_mismatch", 400);
        staged.push({ asset, source: source! });
      }
      // Retain paths, not every image buffer: a many-photo Session must not allocate
      // the sum of its full-resolution assets at once.
      for (const { asset, source } of staged) {
        const bytes = await boundedRead(source);
        if (hash(bytes) !== asset.sha256 || bytes.length !== asset.byteLength) fail("asset_hash_mismatch", 400);
        await publishImmutable(directory, asset.path, bytes);
      }
      const currentBlocks = new Map(current.session.blocks.map(block => [block.id, block]));
      for (const block of next.blocks) {
        const previous = currentBlocks.get(block.id);
        if (previous) block.createdAt = previous.createdAt;
        if (block.type !== "markdown") continue;
        const text = request.snapshot.markdown[block.path];
        if (previous?.type === "markdown" && current.markdown[previous.path] === text) { block.path = previous.path; continue; }
        block.path = `blocks/sync_${request.operationId}_${hash(block.id).slice(0, 16)}.md`;
        await publishImmutable(directory, block.path, Buffer.from(text, "utf8"));
        block.updatedAt = next.updatedAt;
      }
      // All referenced data is prepared. A failure here leaves only harmless orphans.
      await this.options.beforeCommit?.();
      await atomicWrite(await safeReplicaPath(directory, "session.json"), Buffer.from(JSON.stringify(next, null, 2) + "\n"));
      return this.readSnapshot(notebookId, sessionId);
    });
  }
  private async sessionDir(notebookId: string, sessionId: string): Promise<string> {
    validateReplicaId(notebookId); validateReplicaId(sessionId);
    const directory = await safeReplicaPath(this.rootDir, `notebooks/${notebookId}/sessions/${sessionId}`);
    if (process.platform === "win32") {
      // NTFS resolves case aliases to the same files. Only catalog IDs are valid
      // protocol addresses, so an alias cannot get a different Session queue key.
      const notebookNames = await readdir(await safeReplicaPath(this.rootDir, "notebooks"));
      const sessionNames = await readdir(await safeReplicaPath(this.rootDir, `notebooks/${notebookId}/sessions`));
      if (!notebookNames.includes(notebookId) || !sessionNames.includes(sessionId)) fail("noncanonical_id", 400);
    }
    return directory;
  }
  private async readAsset(directory: string, path: string): Promise<Buffer> {
    return boundedRead(await safeReplicaPath(directory, path));
  }
  private async readSnapshot(notebookId: string, sessionId: string): Promise<ReplicaSnapshot> {
    const directory = await this.sessionDir(notebookId, sessionId);
    let session: SessionRecord;
    try { session = JSON.parse(await readFile(await safeReplicaPath(directory, "session.json"), "utf8")); }
    catch (error) { if (error instanceof SyntaxError) fail("invalid_session", 422); throw error; }
    if (!isRecord(session) || session.id !== sessionId || !Array.isArray(session.blocks)) fail("invalid_session", 422);
    const markdown: Record<string, string> = Object.create(null);
    for (const block of session.blocks) {
      if (!isRecord(block)) fail("invalid_block", 422);
      validateReplicaPath(block.path);
      if (block.type === "markdown") {
        if (!/^blocks\/[^/]+\.md$/.test(block.path)) fail("invalid_markdown", 422);
        markdown[block.path] = await readFile(await safeReplicaPath(directory, block.path), "utf8");
      }
    }
    const paths = collectReplicaAssets(session, markdown);
    const assets: ReplicaAsset[] = [];
    for (const path of [...paths].sort()) {
      const bytes = await this.readAsset(directory, path);
      assets.push({ path, sha256: hash(bytes), byteLength: bytes.length });
    }
    const snapshot: ReplicaSnapshot = { version: 1, notebookId, session, markdown, assets, revision: "" };
    validateReplicaSnapshot(snapshot);
    snapshot.revision = replicaRevision(snapshot);
    return snapshot;
  }
}

export function replicaRevision(snapshot: ReplicaSnapshot): string {
  return hash(JSON.stringify([snapshot.session, Object.entries(snapshot.markdown).sort(([a], [b]) => a.localeCompare(b)), snapshot.assets]));
}
export function validateReplicaId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !isSafeWorkspaceIdentifier(value) || !validSegment(value)) fail("invalid_id", 400);
}
export function validateReplicaPath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 4096 || !value.split("/").every(validSegment)) fail("unsafe_path", 400);
}
function validSegment(value: string): boolean {
  return Boolean(value) && value !== "." && value !== ".." && !/[\\/\x00-\x1f\x7f<>:"|?*]/.test(value) &&
    !/[. ]$/.test(value) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}
function validateOperationId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) fail("invalid_operation", 400);
}
export function validateReplicaSnapshot(snapshot: ReplicaSnapshot): void {
  if (!isRecord(snapshot) || snapshot.version !== 1 || !isRecord(snapshot.session) || !isRecord(snapshot.markdown) ||
    !Array.isArray(snapshot.session.blocks) || !Array.isArray(snapshot.session.locks) || !Array.isArray(snapshot.assets) ||
    snapshot.session.blocks.length > 10000 || snapshot.assets.length > 10000 || snapshot.session.locks.length > 10000 ||
    typeof snapshot.session.title !== "string" || !["draft", "reviewed", "archived"].includes(snapshot.session.status) ||
    typeof snapshot.session.createdAt !== "string" || typeof snapshot.session.updatedAt !== "string" ||
    !isRecord(snapshot.session.exportPolicy) || typeof snapshot.session.exportPolicy.includeMetadataComments !== "boolean" ||
    typeof snapshot.session.exportPolicy.includeImageLinks !== "boolean" || snapshot.session.currentDraftPolicy !== "append_only") fail("invalid_snapshot", 400);
  validateReplicaId(snapshot.notebookId); validateReplicaId(snapshot.session.id);
  const ids = new Set<string>(); const markdownPaths = new Set<string>(); const assetPaths = new Set<string>();
  for (const asset of snapshot.assets) {
    if (!isRecord(asset)) fail("invalid_asset", 400);
    validateReplicaPath(asset.path);
    if (!asset.path.startsWith("assets/") || typeof asset.sha256 !== "string" || !HASH.test(asset.sha256) ||
      !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 0 || asset.byteLength > MAX_ASSET_BYTES) fail("invalid_asset", 400);
    if (assetPaths.has(canonicalPath(asset.path))) fail("duplicate_asset", 400);
    assetPaths.add(canonicalPath(asset.path));
  }
  for (const block of snapshot.session.blocks) {
    if (!isRecord(block)) fail("invalid_block", 400);
    validateReplicaId(block.id); validateReplicaPath(block.path);
    if (ids.has(block.id)) fail("duplicate_block", 400); ids.add(block.id);
    if (typeof block.readonly !== "boolean" || typeof block.editableByAi !== "boolean" ||
      typeof block.createdAt !== "string" || typeof block.updatedAt !== "string" || typeof block.source !== "string" ||
      !["draft", "reviewed", "locked", "error"].includes(block.status) ||
      (block.fromAssets !== undefined && !Array.isArray(block.fromAssets))) fail("invalid_block", 400);
    if (block.type === "markdown") {
      if (!/^blocks\/[^/]+\.md$/.test(block.path) || typeof snapshot.markdown[block.path] !== "string") fail("invalid_markdown", 400);
      if (markdownPaths.has(canonicalPath(block.path))) fail("duplicate_markdown_path", 400);
      markdownPaths.add(canonicalPath(block.path));
    } else if (!["image", "pdf"].includes(block.type) || !block.path.startsWith("assets/")) fail("invalid_block", 400);
  }
  const required = collectReplicaAssets(snapshot.session, snapshot.markdown);
  for (const path of required) if (!snapshot.assets.some(asset => asset.path === path)) fail("missing_asset", 400);
  const lockIds = new Set<string>();
  for (const lock of snapshot.session.locks) {
    if (!isRecord(lock) || typeof lock.id !== "string" || lockIds.has(lock.id) || !ids.has(lock.blockId) ||
      !["block", "span"].includes(lock.kind) || typeof lock.contentHash !== "string" || !HASH.test(lock.contentHash)) fail("invalid_lock", 400);
    lockIds.add(lock.id);
  }
}

/** Parse actual image tokens (including references), excluding code/examples. */
export function collectReplicaAssets(session: SessionRecord, markdown: Record<string, string>): Set<string> {
  const result = new Set<string>();
  const groups: Array<SessionRecord["blocks"]> = [];
  let previous: SessionRecord["blocks"][number] | undefined;
  const add = (path: unknown) => {
    validateReplicaPath(path);
    if (!path.startsWith("assets/")) fail("unsafe_path", 400);
    result.add(path);
  };
  for (const block of session.blocks) {
    if (block.type === "image" || block.type === "pdf") add(block.path);
    if (block.fromAssets !== undefined && !Array.isArray(block.fromAssets)) fail("invalid_block", 400);
    block.fromAssets?.forEach(add);
    if (block.sourcePageImagePath !== undefined) add(block.sourcePageImagePath);
    if (block.type !== "markdown") { previous = undefined; continue; }
    if (typeof markdown[block.path] !== "string") fail("invalid_markdown", 400);
    const group = (block as typeof block & { continuationGroup?: string }).continuationGroup;
    const previousGroup = (previous as (typeof block & { continuationGroup?: string }) | undefined)?.continuationGroup;
    if (group && group === previousGroup && block.renderInNote !== false && previous?.renderInNote !== false) groups[groups.length - 1].push(block);
    else groups.push([block]);
    previous = block;
  }
  // A fixed selection can split even an image destination or a code fence. Parse
  // adjacent continuation fragments as their exact concatenation, once.
  for (const group of groups) {
    const text = group.map(part => markdown[part.path]).join("");
    const visit = (tokens: ReturnType<MarkdownIt["parse"]>) => {
      for (const token of tokens) {
        if (token.type === "image") {
          const source = token.attrGet("src") ?? "";
          if (/^https?:\/\//i.test(source)) continue;
          let decoded: string;
          try { decoded = decodeURIComponent(source); } catch { fail("unsafe_path", 400); }
          if (/^[a-z][a-z0-9+.-]*:|^\/|\\|[\0?#]/i.test(decoded!)) fail("unsafe_path", 400);
          // The regular block-relative form is ../assets/. Historical export
          // content also uses Session-relative assets/; preserve both verbatim.
          const assetPath = decoded!.startsWith("../assets/") ? decoded!.slice(3) : decoded!;
          if (!assetPath.startsWith("assets/")) fail("unsafe_path", 400);
          add(assetPath);
        }
        if (token.children) visit(token.children);
      }
    };
    visit(parser.parse(text, {}));
  }
  return result;
}

function validatePreviousLocks(before: ReplicaSnapshot, after: ReplicaSnapshot): void {
  for (const old of before.session.blocks) {
    const next = after.session.blocks.find(block => block.id === old.id);
    const locks = before.session.locks.filter(lock => lock.blockId === old.id);
    const locked = old.status === "locked" || old.readonly || locks.some(lock => lock.kind === "block");
    if (locked && (!next || next.type !== old.type || (old.type === "markdown"
      ? before.markdown[old.path] !== after.markdown[next.path] : old.path !== next.path))) fail("block_locked", 423);
    if (old.type !== "markdown") continue;
    const text = next?.type === "markdown" ? after.markdown[next.path] : "";
    const beforeText = before.markdown[old.path];
    const previousRanges = protectedSpanRanges(beforeText);
    const previousSpans = new Map(previousRanges.map(span => [span.id, span.hash]));
    const nextSpans = protectedSpans(text);
    const removedSpans = previousRanges.filter(span => !nextSpans.has(span.id));
    const unlocked = new Set<string>();
    if (removedSpans.length) {
      // An explicit unlock may strip wrappers and their metadata, but the whole
      // Markdown block must otherwise be byte-for-byte identical. This also gives
      // legacy wrappers without metadata a safe, narrowly defined unlock route.
      if (next?.type !== "markdown" || removedSpans.some(span => after.session.locks.some(lock => lock.id === span.id))) fail("protected_span_changed", 423);
      let unwrapped = beforeText;
      for (const span of [...removedSpans].sort((left, right) => right.from - left.from)) {
        unwrapped = unwrapped.slice(0, span.from) + span.content + unwrapped.slice(span.to);
      }
      if (text !== unwrapped) fail("protected_span_changed", 423);
      removedSpans.forEach(span => unlocked.add(span.id));
      for (const lock of locks.filter(lock => !unlocked.has(lock.id))) {
        if (!after.session.locks.some(candidate => candidate.id === lock.id && candidate.blockId === lock.blockId &&
          candidate.kind === lock.kind && candidate.contentHash === lock.contentHash)) fail("protected_span_changed", 423);
      }
    }
    // Legacy notes sometimes retained wrapper markers but lost their sidecar
    // metadata. The visible protected text remains protected in that case too.
    for (const [id, digest] of previousSpans) if (!unlocked.has(id) && nextSpans.get(id) !== digest) fail("protected_span_changed", 423);
    for (const lock of locks.filter(lock => lock.kind === "span")) {
      if (previousSpans.get(lock.id) !== lock.contentHash || !unlocked.has(lock.id) && nextSpans.get(lock.id) !== lock.contentHash) fail("protected_span_changed", 423);
    }
  }
  // Lock hashes supplied for new locks must describe actual content. Preserve the
  // explicit-unlock protocol: old content is checked even if its lock is removed.
  for (const lock of after.session.locks) {
    const block = after.session.blocks.find(block => block.id === lock.blockId)!;
    if (block.type !== "markdown") continue;
    const text = after.markdown[block.path];
    if (lock.kind === "span" && protectedSpans(text).get(lock.id) !== lock.contentHash ||
      lock.kind === "block" && hash(text) !== lock.contentHash) fail("invalid_lock", 400);
  }
}
function protectedSpans(markdown: string): Map<string, string> {
  return new Map(protectedSpanRanges(markdown).map(span => [span.id, span.hash]));
}
type ProtectedSpanRange = { id: string; hash: string; content: string; from: number; to: number };
function protectedSpanRanges(markdown: string): ProtectedSpanRange[] {
  const result: ProtectedSpanRange[] = [];
  const ids = new Set<string>();
  const pattern = /<!-- lock:start id="(?<id>[^"]+)" hash="(?<hash>[a-f0-9]{64})" -->\r?\n?(?<content>[\s\S]*?)\r?\n?<!-- lock:end id="\k<id>" -->/g;
  for (const match of markdown.matchAll(pattern)) {
    const { id, hash: declared, content } = match.groups!;
    const unwrapped = content.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    const actual = hash(unwrapped);
    if (ids.has(id) || actual !== declared) fail("protected_span_changed", 423);
    ids.add(id);
    result.push({ id, hash: actual, content: unwrapped, from: match.index!, to: match.index! + match[0].length });
  }
  return result;
}
export async function safeReplicaPath(root: string, relative: string, allowMissing = false): Promise<string> {
  validateReplicaPath(relative);
  let path = root;
  if ((await lstat(root)).isSymbolicLink()) fail("unsafe_path", 400);
  for (const part of relative.split("/")) {
    path = join(path, part);
    try { if ((await lstat(path)).isSymbolicLink()) fail("unsafe_path", 400); }
    catch (error) { if (errno(error) !== "ENOENT") throw error; if (!allowMissing) fail("item_not_found", 404); }
  }
  return path;
}
async function ensureParents(root: string, relative: string): Promise<void> {
  let current = "";
  for (const part of relative.split("/").slice(0, -1)) {
    current = current ? `${current}/${part}` : part;
    const target = await safeReplicaPath(root, current, true);
    try { await mkdir(target); } catch (error) { if (errno(error) !== "EEXIST") throw error; }
    await safeReplicaPath(root, current);
  }
}
async function publishImmutable(root: string, path: string, bytes: Buffer): Promise<void> {
  await ensureParents(root, path);
  const target = await safeReplicaPath(root, path, true);
  try {
    if (!(await readFile(target)).equals(bytes)) fail("immutable_asset_conflict", 409);
    return;
  } catch (error) { if (errno(error) !== "ENOENT") throw error; }
  await atomicWrite(target, bytes);
}
async function atomicWrite(target: string, bytes: Buffer): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, target); break; }
      catch (error) {
        if (attempt >= 7 || !["EPERM", "EACCES", "EBUSY"].includes(errno(error) ?? "")) throw error;
        await new Promise(resolve => setTimeout(resolve, 35 * (attempt + 1)));
      }
    }
  } finally { await handle?.close(); await rm(temporary, { force: true }); }
}
async function boundedRead(path: string): Promise<Buffer> {
  const info = await stat(path);
  if (!info.isFile()) fail("unsafe_path", 400);
  if (info.size > MAX_ASSET_BYTES) fail("asset_too_large", 413);
  const handle = await open(path, "r");
  try {
    // A bounded handle read also guards growth between stat and read.
    const bytes = Buffer.alloc(Math.min(info.size + 1, MAX_ASSET_BYTES + 1));
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, null);
      if (read.bytesRead === 0) break;
      count += read.bytesRead;
    }
    if (count > info.size) fail("asset_changed", 409);
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}
function canonicalPath(path: string): string { return path.toLowerCase(); }
function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function errno(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
function fail(code: string, statusCode: number): never { throw new WorkspaceSyncError(code, statusCode); }
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
