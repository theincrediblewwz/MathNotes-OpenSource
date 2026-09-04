import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { BlockRef, SessionRecord } from "@mathnotes/shared";
import { readNotesCatalog } from "../catalog/sessionCatalog";
import { isSafeWorkspaceIdentifier } from "./workspaceIdentifier";

export const ASSISTANT_KNOWLEDGE_LIMITS = {
  sessionsScanned: 48,
  blocksScanned: 240,
  results: 6,
  searchableCharactersPerBlock: 20_000,
  contextCharactersPerResult: 4_000,
  excerptCharacters: 280
} as const;

export type AssistantKnowledgeReference = Readonly<{
  refId: string;
  notebookId: string;
  notebookTitle: string;
  sessionId: string;
  sessionTitle: string;
  blockId: string;
  markdown: string;
  excerpt: string;
  locked: boolean;
  protectedSpanCount: number;
  writePermission: "none";
  updatedAt: string;
}>;

export type AssistantKnowledgeSearchResult = Readonly<{
  version: 1;
  query: string;
  references: readonly AssistantKnowledgeReference[];
  scannedSessionCount: number;
  scannedBlockCount: number;
  truncated: boolean;
}>;

type ScoredReference = Omit<AssistantKnowledgeReference, "refId"> & { score: number };

export async function searchAssistantKnowledge(input: {
  rootDir: string;
  query: string;
  currentNotebookId: string;
  currentSessionId: string;
  maximumResults?: number;
}): Promise<AssistantKnowledgeSearchResult> {
  const query = normalizeWhitespace(input.query);
  const maximumResults = clampInteger(input.maximumResults ?? ASSISTANT_KNOWLEDGE_LIMITS.results, 1, ASSISTANT_KNOWLEDGE_LIMITS.results);
  if (!query) {
    return emptyResult(query);
  }

  const catalog = await readNotesCatalog({ rootDir: input.rootDir });
  const candidates = catalog.notebooks.flatMap((notebook) => notebook.sessions.map((session) => ({ notebook, session })))
    .filter(({ session }) => !(
      session.notebookId === input.currentNotebookId && session.sessionId === input.currentSessionId
    ))
    .slice(0, ASSISTANT_KNOWLEDGE_LIMITS.sessionsScanned);
  const tokens = searchTokens(query);
  const scored: ScoredReference[] = [];
  let scannedBlockCount = 0;
  let truncated = catalog.notebooks.reduce((total, notebook) => total + notebook.sessionCount, 0) > candidates.length + 1;

  for (const { notebook, session: summary } of candidates) {
    if (scannedBlockCount >= ASSISTANT_KNOWLEDGE_LIMITS.blocksScanned) {
      truncated = true;
      break;
    }
    if (!isSafeWorkspaceIdentifier(notebook.notebookId) || !isSafeWorkspaceIdentifier(summary.sessionId)) continue;
    const context = await readSession(input.rootDir, notebook.notebookId, summary.sessionId).catch(() => null);
    if (!context) continue;
    for (const block of context.session.blocks) {
      if (scannedBlockCount >= ASSISTANT_KNOWLEDGE_LIMITS.blocksScanned) {
        truncated = true;
        break;
      }
      if (block.type !== "markdown" || block.source === "ai_explanation" || block.renderInNote === false) continue;
      scannedBlockCount += 1;
      const markdown = await readMarkdown(context.sessionDir, block).catch(() => "");
      if (!markdown) continue;
      const searchable = takeCharacters(markdown, ASSISTANT_KNOWLEDGE_LIMITS.searchableCharactersPerBlock);
      const score = relevanceScore({
        query,
        tokens,
        notebookTitle: notebook.title,
        sessionTitle: context.session.title,
        markdown: searchable
      });
      if (score <= 0) continue;
      const blockLocks = context.session.locks.filter((lock) => lock.blockId === block.id);
      scored.push({
        notebookId: notebook.notebookId,
        notebookTitle: notebook.title,
        sessionId: summary.sessionId,
        sessionTitle: context.session.title,
        blockId: block.id,
        markdown: takeCharacters(markdown, ASSISTANT_KNOWLEDGE_LIMITS.contextCharactersPerResult),
        excerpt: excerptAroundMatch(searchable, query, tokens, ASSISTANT_KNOWLEDGE_LIMITS.excerptCharacters),
        locked: block.status === "locked" || blockLocks.some((lock) => lock.kind === "block"),
        protectedSpanCount: blockLocks.filter((lock) => lock.kind === "span").length,
        writePermission: "none",
        updatedAt: block.updatedAt || context.session.updatedAt,
        score
      });
    }
  }

  const references = scored
    .sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt) || stableTarget(left).localeCompare(stableTarget(right)))
    .slice(0, maximumResults)
    .map(({ score: _score, ...reference }, index): AssistantKnowledgeReference => ({
      refId: `R${index + 1}`,
      ...reference
    }));

  return {
    version: 1,
    query,
    references,
    scannedSessionCount: candidates.length,
    scannedBlockCount,
    truncated: truncated || scored.length > maximumResults
  };
}

function emptyResult(query: string): AssistantKnowledgeSearchResult {
  return {
    version: 1,
    query,
    references: [],
    scannedSessionCount: 0,
    scannedBlockCount: 0,
    truncated: false
  };
}

async function readSession(rootDir: string, notebookId: string, sessionId: string) {
  const notebooksRoot = resolve(rootDir, "notebooks");
  const sessionDir = resolve(notebooksRoot, notebookId, "sessions", sessionId);
  assertInside(notebooksRoot, sessionDir);
  const session = JSON.parse(await readFile(resolve(sessionDir, "session.json"), "utf8")) as SessionRecord;
  if (session.id !== sessionId || !Array.isArray(session.blocks) || !Array.isArray(session.locks)) {
    throw new Error("invalid_session");
  }
  return { session, sessionDir };
}

async function readMarkdown(sessionDir: string, block: BlockRef): Promise<string> {
  const target = resolve(sessionDir, block.path);
  assertInside(sessionDir, target);
  return readFile(target, "utf8");
}

function relevanceScore(input: {
  query: string;
  tokens: readonly string[];
  notebookTitle: string;
  sessionTitle: string;
  markdown: string;
}): number {
  const query = input.query.toLocaleLowerCase("zh-CN");
  const notebookTitle = input.notebookTitle.toLocaleLowerCase("zh-CN");
  const sessionTitle = input.sessionTitle.toLocaleLowerCase("zh-CN");
  const markdown = input.markdown.toLocaleLowerCase("zh-CN");
  let score = 0;
  if (sessionTitle.includes(query)) score += 90;
  if (notebookTitle.includes(query)) score += 50;
  if (markdown.includes(query)) score += 42;
  for (const token of input.tokens) {
    if (sessionTitle.includes(token)) score += 20;
    if (notebookTitle.includes(token)) score += 10;
    score += Math.min(8, countOccurrences(markdown, token)) * 3;
  }
  return score;
}

function searchTokens(query: string): string[] {
  const normalized = query.toLocaleLowerCase("zh-CN");
  const tokens: string[] = [];
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const phrase = match[0]
      .replace(/^(?:请问|请解释|请说明|告诉我)/, "")
      .replace(/(?:是什么|有什么|怎么理解|如何理解|为什么|怎么|如何|吗)+$/, "");
    if (phrase.length >= 2) tokens.push(phrase);
    if (phrase.length > 6) {
      for (let index = 0; index <= phrase.length - 4 && tokens.length < 10; index += 2) {
        tokens.push(phrase.slice(index, index + 4));
      }
    }
  }
  tokens.push(...(normalized.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []));
  return [...new Set(tokens)].slice(0, 12);
}

function excerptAroundMatch(markdown: string, query: string, tokens: readonly string[], maximum: number): string {
  const compact = normalizeWhitespace(markdown);
  const lower = compact.toLocaleLowerCase("zh-CN");
  const needles = [query.toLocaleLowerCase("zh-CN"), ...tokens].filter(Boolean);
  const match = needles.map((needle) => lower.indexOf(needle)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const characters = Array.from(compact);
  const before = Math.floor(maximum * 0.35);
  const start = Math.max(0, Array.from(compact.slice(0, match)).length - before);
  const excerpt = characters.slice(start, start + maximum).join("");
  return `${start > 0 ? "…" : ""}${excerpt}${start + maximum < characters.length ? "…" : ""}`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function takeCharacters(value: string, maximum: number): string {
  const characters = Array.from(value);
  return characters.length <= maximum ? value : characters.slice(0, maximum).join("");
}

function countOccurrences(value: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (count < 8) {
    const index = value.indexOf(needle, offset);
    if (index < 0) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function stableTarget(reference: Pick<AssistantKnowledgeReference, "notebookId" | "sessionId" | "blockId">): string {
  return `${reference.notebookId}\u0000${reference.sessionId}\u0000${reference.blockId}`;
}

function assertInside(root: string, target: string): void {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error("path_outside_notes_root");
  }
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}
