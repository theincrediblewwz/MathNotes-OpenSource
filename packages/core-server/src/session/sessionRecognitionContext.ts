import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { SessionRecord } from "@mathnotes/shared";

export const SESSION_RECOGNITION_CONTEXT_VERSION = 1;
export const MAX_SESSION_RECOGNITION_CONTEXT_BLOCKS = 8;
export const MAX_SESSION_RECOGNITION_CONTEXT_CHARS = 800;
const MAX_CONTEXT_EXCERPT_CHARS = 88;

export type SessionRecognitionContextSnapshot = Readonly<{
  version: 1;
  sessionId: string;
  beforeBlockId: string;
  sourceBlockIds: readonly string[];
  summary: string;
  fingerprint: string;
  generatedAt: string;
}>;

export async function buildSessionRecognitionContext(input: {
  sessionDir: string;
  session: SessionRecord;
  beforeBlockId: string;
  now?: string;
  persist?: boolean;
}): Promise<SessionRecognitionContextSnapshot> {
  const targetIndex = input.session.blocks.findIndex((block) => block.id === input.beforeBlockId);
  const candidates = (targetIndex < 0 ? [] : input.session.blocks.slice(0, targetIndex))
    .filter((block) => block.type === "markdown" && block.renderInNote !== false)
    .slice(-MAX_SESSION_RECOGNITION_CONTEXT_BLOCKS);
  const excerpts: Array<{ id: string; text: string }> = [];

  for (const block of candidates) {
    const blockPath = assertInside(input.sessionDir, resolve(input.sessionDir, block.path));
    try {
      const normalized = compactMarkdown(await readFile(blockPath, "utf8"));
      if (normalized && !isTransientRecognitionDraft(normalized)) {
        excerpts.push({ id: block.id, text: Array.from(normalized).slice(0, MAX_CONTEXT_EXCERPT_CHARS).join("") });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const summary = boundContext(excerpts.map((item, index) => `前文${index + 1}：${item.text}`).join("\n"));
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ beforeBlockId: input.beforeBlockId, excerpts }))
    .digest("hex");
  const snapshot: SessionRecognitionContextSnapshot = {
    version: SESSION_RECOGNITION_CONTEXT_VERSION,
    sessionId: input.session.id,
    beforeBlockId: input.beforeBlockId,
    sourceBlockIds: excerpts.map((item) => item.id),
    summary,
    fingerprint,
    generatedAt: input.now ?? new Date().toISOString()
  };
  if (input.persist !== false) await writeSnapshot(input.sessionDir, snapshot);
  return snapshot;
}

function compactMarkdown(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^---\s+source:.*?---$/gim, " ")
    .replace(/^[>#*-]\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isTransientRecognitionDraft(markdown: string): boolean {
  return /识别任务已创建|正在准备识别|识别已中断|识别失败|异常输出已停止/.test(markdown);
}

function boundContext(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= MAX_SESSION_RECOGNITION_CONTEXT_CHARS) return value;
  return `${characters.slice(0, MAX_SESSION_RECOGNITION_CONTEXT_CHARS - 1).join("")}…`;
}

async function writeSnapshot(sessionDir: string, snapshot: SessionRecognitionContextSnapshot): Promise<void> {
  const path = assertInside(sessionDir, resolve(sessionDir, ".mathnotes", "recognition-context-v1.json"));
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function assertInside(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error("path_outside_session");
  }
  return resolvedCandidate;
}
