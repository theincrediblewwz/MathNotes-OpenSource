import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const phase0b3Events = new Set([
  "window_visible",
  "notebook_created",
  "session_created",
  "android_upload_started",
  "android_upload_landed",
  "provider_first_token",
  "draft_written",
  "block_edited",
  "block_locked",
  "markdown_exported",
  "app_restarted",
  "state_restored",
  "failure"
]);

export function createPhase0b3RunId(now = new Date(), randomValue = Math.random()) {
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const suffix = randomValue.toString(16).slice(2, 8).padEnd(6, "0");
  return `phase0b3-${timestamp}-${suffix}`;
}

export function createPhase0b3Paths({ homeDir, runId }) {
  if (!/^phase0b3-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{6}$/.test(runId)) {
    throw new Error(`PHASE0B3_RUN_ID_INVALID:${runId}`);
  }
  const acceptanceRoot = path.resolve(homeDir, "data", "MathNotes-dev", "acceptance", "phase0b3");
  const runRoot = resolveWithin(acceptanceRoot, runId);
  return {
    acceptanceRoot,
    runRoot,
    notesRoot: path.join(runRoot, "notes"),
    userDataRoot: path.join(runRoot, "user-data"),
    evidenceRoot: path.join(runRoot, "evidence"),
    runPath: path.join(runRoot, "evidence", "run.json"),
    eventsPath: path.join(runRoot, "evidence", "events.ndjson"),
    appLogPath: path.join(runRoot, "evidence", "app.log"),
    summaryPath: path.join(runRoot, "evidence", "summary.json")
  };
}

export async function initializePhase0b3Run({ paths, appPath, sourceCommit, now = new Date() }) {
  const binaryPath = path.join(appPath, "Contents", "MacOS", "MathNotes");
  const binaryStat = await stat(binaryPath);
  if (!binaryStat.isFile()) throw new Error(`PHASE0B3_APP_BINARY_MISSING:${binaryPath}`);

  await Promise.all([
    mkdir(paths.notesRoot, { recursive: true }),
    mkdir(paths.userDataRoot, { recursive: true }),
    mkdir(paths.evidenceRoot, { recursive: true })
  ]);
  const run = {
    schemaVersion: 1,
    runId: path.basename(paths.runRoot),
    status: "prepared",
    startedAt: now.toISOString(),
    sourceCommit,
    appPath: path.resolve(appPath),
    appBinarySha256: await hashFile(binaryPath),
    notesRoot: paths.notesRoot,
    userDataRoot: paths.userDataRoot,
    evidenceRoot: paths.evidenceRoot,
    mockProviderAllowed: false,
    realNotebookRootsRead: false
  };
  await writeJson(paths.runPath, run);
  await writeFile(path.join(paths.runRoot, "README.md"), checklist(run), "utf8");
  return { run, binaryPath };
}

export async function appendPhase0b3Event({ paths, event, note = "", now = new Date() }) {
  if (!phase0b3Events.has(event)) throw new Error(`PHASE0B3_EVENT_INVALID:${event}`);
  if (note.length > 500) throw new Error("PHASE0B3_EVENT_NOTE_TOO_LONG");
  await mkdir(paths.evidenceRoot, { recursive: true });
  const record = { at: now.toISOString(), event, note };
  await appendFile(paths.eventsPath, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export async function collectPhase0b3Evidence({ paths, now = new Date() }) {
  const run = JSON.parse(await readFile(paths.runPath, "utf8"));
  const files = await walkFiles(paths.notesRoot, 2_000);
  const relativeFiles = files.map((file) => path.relative(paths.notesRoot, file).replaceAll("\\", "/")).sort();
  const sessionPaths = relativeFiles.filter((file) => file.endsWith("/session.json"));
  const markdownPaths = relativeFiles.filter((file) => file.endsWith(".md"));
  const exportPaths = relativeFiles.filter((file) => /(^|\/)exports\/.+\.md$/i.test(file));
  const assetPaths = relativeFiles.filter((file) => /(^|\/)assets\/(photos|pdfs|embedded)\//i.test(file));
  const sessions = [];
  for (const relativePath of sessionPaths) {
    try {
      const session = JSON.parse(await readFile(path.join(paths.notesRoot, relativePath), "utf8"));
      const blocks = Array.isArray(session.blocks) ? session.blocks : [];
      sessions.push({
        relativePath,
        id: typeof session.id === "string" ? session.id : null,
        blockCount: blocks.length,
        aiDraftCount: blocks.filter((block) => block?.source === "ai_transcription").length,
        lockedBlockCount: blocks.filter((block) => block?.editable_by_ai === false || block?.locked === true).length,
        protectedSpanCount: blocks.reduce((count, block) => count + (Array.isArray(block?.locks) ? block.locks.length : 0), 0)
      });
    } catch (error) {
      sessions.push({ relativePath, parseError: error instanceof Error ? error.message : String(error) });
    }
  }
  const events = await readEvents(paths.eventsPath);
  const eventNames = new Set(events.map((entry) => entry.event));
  const gates = {
    notebookAndSession: sessions.length > 0,
    androidUpload: assetPaths.some((file) => /assets\/photos\//i.test(file)) && eventNames.has("android_upload_landed"),
    providerDraft: sessions.some((session) => session.aiDraftCount > 0) && eventNames.has("provider_first_token"),
    editAndLock: eventNames.has("block_edited") && eventNames.has("block_locked"),
    markdownExport: exportPaths.length > 0 && eventNames.has("markdown_exported"),
    restartRecovery: eventNames.has("app_restarted") && eventNames.has("state_restored")
  };
  const summary = {
    schemaVersion: 1,
    runId: run.runId,
    collectedAt: now.toISOString(),
    sourceCommit: run.sourceCommit,
    appBinarySha256: run.appBinarySha256,
    notesRoot: paths.notesRoot,
    counts: {
      files: relativeFiles.length,
      sessions: sessions.length,
      markdown: markdownPaths.length,
      exports: exportPaths.length,
      assets: assetPaths.length,
      events: events.length
    },
    gates,
    passed: Object.values(gates).every(Boolean),
    sessions,
    relativeFiles,
    events
  };
  await writeJson(paths.summaryPath, summary);
  return summary;
}

export function resolveWithin(rootDir, relativePath) {
  if (path.isAbsolute(relativePath)) throw new Error(`PHASE0B3_PATH_OUTSIDE_ROOT:${relativePath}`);
  const root = path.resolve(rootDir);
  const target = path.resolve(root, relativePath);
  const relation = path.relative(root, target);
  if (!relation || (!relation.startsWith(`..${path.sep}`) && relation !== ".." && !path.isAbsolute(relation))) {
    return target;
  }
  throw new Error(`PHASE0B3_PATH_OUTSIDE_ROOT:${relativePath}`);
}

async function readEvents(eventsPath) {
  try {
    return (await readFile(eventsPath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function walkFiles(rootDir, limit) {
  const result = [];
  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`PHASE0B3_SYMLINK_REJECTED:${absolutePath}`);
      if (entry.isDirectory()) pending.push(absolutePath);
      if (entry.isFile()) result.push(absolutePath);
      if (result.length > limit) throw new Error(`PHASE0B3_FILE_LIMIT_EXCEEDED:${limit}`);
    }
  }
  return result;
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function checklist(run) {
  return `# MathNotes macOS Phase 0B-3\n\n` +
    `- Run: \`${run.runId}\`\n` +
    `- Source: \`${run.sourceCommit}\`\n` +
    `- Notes root: \`${run.notesRoot}\`\n` +
    `- User data: \`${run.userDataRoot}\`\n\n` +
    `本目录只用于真机验收，不读取现有 Notebook。不要在事件备注中写 API key、配对 token 或私人素材内容。\n\n` +
    `## 闭环\n\n` +
    `1. 窗口可见。\n2. 创建 Notebook 与 Session。\n3. Android 上传测试图片。\n4. 在线 Provider 写入忠实转写草稿。\n` +
    `5. 编辑并锁定 block。\n6. 导出 Markdown。\n7. 关闭并重启，确认数据和任务状态恢复。\n`;
}
