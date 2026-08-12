import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssistantMode } from "@mathnotes/shared";
import type { BlockStore } from "./blockStore";

export type AssistantRemarkFocus = {
  kind: "selection" | "block" | "session";
  blockId?: string;
  label: string;
  excerpt?: string;
  from?: number;
  to?: number;
};

export type AssistantRemark = {
  id: string;
  mode: AssistantMode;
  focus: AssistantRemarkFocus;
  question?: string;
  markdown: string;
  providerName: string;
  sourceBlockIds: string[];
  createdAt: string;
  updatedAt: string;
};

type AssistantRemarkIndexEntry = Omit<AssistantRemark, "markdown"> & {
  file: string;
};

type AssistantRemarkIndex = {
  version: 1;
  remarks: AssistantRemarkIndexEntry[];
};

export class AssistantRemarkStore {
  constructor(private readonly blockStore: BlockStore) {}

  async list(notebookId: string, sessionId: string): Promise<AssistantRemark[]> {
    const index = await this.ensureIndex(notebookId, sessionId);
    const remarks = await Promise.all(index.remarks.map(async (entry): Promise<AssistantRemark | null> => {
      try {
        const { file: _file, ...metadata } = entry;
        return {
          ...metadata,
          markdown: await readFile(this.resolveRemarkFile(notebookId, sessionId, entry.file), "utf8")
        };
      } catch (error) {
        if (isMissingFile(error)) return null;
        throw error;
      }
    }));
    return remarks.filter((remark): remark is AssistantRemark => remark !== null);
  }

  async append(args: {
    notebookId: string;
    sessionId: string;
    remark: AssistantRemark;
  }): Promise<AssistantRemark> {
    const index = await this.ensureIndex(args.notebookId, args.sessionId);
    const entry = toIndexEntry(args.remark);
    await this.writeRemarkMarkdown(args.notebookId, args.sessionId, entry.file, args.remark.markdown);
    await this.writeIndex(args.notebookId, args.sessionId, {
      version: 1,
      remarks: [...index.remarks.filter((candidate) => candidate.id !== entry.id), entry]
    });
    return args.remark;
  }

  async remove(args: { notebookId: string; sessionId: string; remarkId: string }): Promise<boolean> {
    const index = await this.ensureIndex(args.notebookId, args.sessionId);
    const entry = index.remarks.find((candidate) => candidate.id === args.remarkId);
    if (!entry) return false;
    await this.writeIndex(args.notebookId, args.sessionId, {
      version: 1,
      remarks: index.remarks.filter((candidate) => candidate.id !== args.remarkId)
    });
    await this.archiveRemarkFile(args.notebookId, args.sessionId, entry);
    return true;
  }

  async get(args: { notebookId: string; sessionId: string; remarkId: string }): Promise<AssistantRemark | undefined> {
    return (await this.list(args.notebookId, args.sessionId)).find((remark) => remark.id === args.remarkId);
  }

  private assistantDir(notebookId: string, sessionId: string): string {
    return path.join(this.blockStore.getSessionDir(notebookId, sessionId), "assistant");
  }

  private indexPath(notebookId: string, sessionId: string): string {
    return path.join(this.assistantDir(notebookId, sessionId), "index.json");
  }

  private legacyPath(notebookId: string, sessionId: string): string {
    return path.join(this.assistantDir(notebookId, sessionId), "remarks.json");
  }

  private resolveRemarkFile(notebookId: string, sessionId: string, relative: string): string {
    const root = this.assistantDir(notebookId, sessionId);
    const absolute = path.resolve(root, relative);
    const inside = path.relative(root, absolute);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) {
      throw new Error(`学习旁注路径越界：${relative}`);
    }
    return absolute;
  }

  private async ensureIndex(notebookId: string, sessionId: string): Promise<AssistantRemarkIndex> {
    try {
      const parsed = JSON.parse(await readFile(this.indexPath(notebookId, sessionId), "utf8")) as unknown;
      if (isAssistantRemarkIndex(parsed)) return parsed;
    } catch (error) {
      if (!isMissingFile(error) && !(error instanceof SyntaxError)) throw error;
    }

    const legacy = await this.readLegacy(notebookId, sessionId);
    const migrated: AssistantRemarkIndex = { version: 1, remarks: legacy.map(toIndexEntry) };
    for (const remark of legacy) {
      const entry = toIndexEntry(remark);
      await this.writeRemarkMarkdown(notebookId, sessionId, entry.file, remark.markdown);
    }
    await this.writeIndex(notebookId, sessionId, migrated);
    return migrated;
  }

  private async readLegacy(notebookId: string, sessionId: string): Promise<AssistantRemark[]> {
    try {
      const parsed = JSON.parse(await readFile(this.legacyPath(notebookId, sessionId), "utf8")) as unknown;
      return Array.isArray(parsed) ? parsed.filter(isAssistantRemark) : [];
    } catch (error) {
      if (isMissingFile(error) || error instanceof SyntaxError) return [];
      throw error;
    }
  }

  private async writeRemarkMarkdown(notebookId: string, sessionId: string, relative: string, markdown: string): Promise<void> {
    await writeAtomic(this.resolveRemarkFile(notebookId, sessionId, relative), `${markdown.trim()}\n`);
  }

  private async writeIndex(notebookId: string, sessionId: string, index: AssistantRemarkIndex): Promise<void> {
    await writeAtomic(this.indexPath(notebookId, sessionId), `${JSON.stringify(index, null, 2)}\n`);
  }

  private async archiveRemarkFile(
    notebookId: string,
    sessionId: string,
    entry: AssistantRemarkIndexEntry
  ): Promise<void> {
    const source = this.resolveRemarkFile(notebookId, sessionId, entry.file);
    const archive = path.join(
      this.assistantDir(notebookId, sessionId),
      "archive",
      `${safeRemarkId(entry.id)}-${Date.now()}.md`
    );
    await mkdir(path.dirname(archive), { recursive: true });
    try {
      await rename(source, archive);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
}

function toIndexEntry(remark: AssistantRemark): AssistantRemarkIndexEntry {
  const { markdown: _markdown, ...metadata } = remark;
  return { ...metadata, file: `remarks/${safeRemarkId(remark.id)}.md` };
}

function safeRemarkId(id: string): string {
  const sanitized = id.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!sanitized) throw new Error("学习旁注标识无效。");
  return sanitized;
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const temporary = `${target}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
}

function isAssistantRemarkIndex(value: unknown): value is AssistantRemarkIndex {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AssistantRemarkIndex>;
  return candidate.version === 1 && Array.isArray(candidate.remarks) && candidate.remarks.every(isAssistantRemarkIndexEntry);
}

function isAssistantRemarkIndexEntry(value: unknown): value is AssistantRemarkIndexEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AssistantRemarkIndexEntry>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.file === "string" &&
    typeof candidate.providerName === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string" &&
    Array.isArray(candidate.sourceBlockIds) &&
    Boolean(candidate.focus && typeof candidate.focus.label === "string")
  );
}

function isAssistantRemark(value: unknown): value is AssistantRemark {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AssistantRemark>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.markdown === "string" &&
    typeof candidate.providerName === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string" &&
    Array.isArray(candidate.sourceBlockIds) &&
    Boolean(candidate.focus && typeof candidate.focus.label === "string")
  );
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
