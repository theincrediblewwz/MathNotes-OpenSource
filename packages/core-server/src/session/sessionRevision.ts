import { createHash } from "node:crypto";
import type { BlockRef, LockMeta, SessionRecord } from "@mathnotes/shared";

export type MarkdownLockSummary = Readonly<{
  blockLocked: boolean;
  protectedSpanCount: number;
}>;

export function markdownBlockRevision(args: {
  block: BlockRef;
  markdown: string;
  locks: readonly LockMeta[];
}): string {
  const lockDigest = [...args.locks]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((lock) => `${lock.id}:${lock.kind}:${lock.contentHash}:${lock.aiEditable}`)
    .join("\0");
  return sha256([args.block.id, args.block.updatedAt, sha256(args.markdown), sha256(lockDigest)].join("\0"));
}

export function markdownLockSummary(locks: readonly LockMeta[]): MarkdownLockSummary {
  return {
    blockLocked: locks.some((lock) => lock.kind === "block"),
    protectedSpanCount: locks.filter((lock) => lock.kind === "span").length
  };
}

export function sessionManifestRevision(session: Pick<SessionRecord, "updatedAt" | "blocks">): string {
  return sha256([
    session.updatedAt,
    session.blocks.map((block) => `${block.id}:${block.updatedAt}:${block.type}`).join("\0")
  ].join("\0"));
}

export function sha256Text(content: string): string {
  return sha256(content);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
