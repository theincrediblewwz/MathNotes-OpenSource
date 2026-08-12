import type { LockMeta } from "@mathnotes/shared";
import { parseProtectedSpans, sha256Text } from "./lockSpan";

export type LockValidationFailureReason =
  | "locked_block_changed"
  | "locked_span_missing"
  | "locked_span_changed";

export type LockValidationResult =
  | { ok: true }
  | {
      ok: false;
      reason: LockValidationFailureReason;
      lockId: string;
      blockId: string;
    };

export async function validateAiMarkdownUpdate(args: {
  blockId: string;
  beforeMarkdown: string;
  afterMarkdown: string;
  locks: LockMeta[];
}): Promise<LockValidationResult> {
  const locksForBlock = args.locks.filter((lock) => lock.blockId === args.blockId);

  for (const lock of locksForBlock.filter((candidate) => candidate.kind === "block")) {
    const beforeHash = await sha256Text(args.beforeMarkdown);
    const afterHash = await sha256Text(args.afterMarkdown);
    if (lock.contentHash !== beforeHash || afterHash !== lock.contentHash) {
      return {
        ok: false,
        reason: "locked_block_changed",
        lockId: lock.id,
        blockId: args.blockId
      };
    }
  }

  const afterSpans = new Map(parseProtectedSpans(args.afterMarkdown).map((span) => [span.id, span]));
  for (const lock of locksForBlock.filter((candidate) => candidate.kind === "span")) {
    const afterSpan = afterSpans.get(lock.id);
    if (!afterSpan) {
      return {
        ok: false,
        reason: "locked_span_missing",
        lockId: lock.id,
        blockId: args.blockId
      };
    }
    if (afterSpan.hash !== lock.contentHash) {
      return {
        ok: false,
        reason: "locked_span_changed",
        lockId: lock.id,
        blockId: args.blockId
      };
    }
  }

  return { ok: true };
}
