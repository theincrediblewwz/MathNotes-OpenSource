import { createHash } from "node:crypto";
import type { SessionRecord } from "@mathnotes/shared";

/** Includes raw bytes-as-text, paths, order, metadata and every lock. No rendering normalization. */
export function sessionRevisionBaseline(session: SessionRecord, markdown: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify([
    session, Object.entries(markdown).sort(([a], [b]) => a.localeCompare(b))
  ])).digest("hex");
}
