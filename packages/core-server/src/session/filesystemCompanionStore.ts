import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { SessionRecord } from "@mathnotes/shared";
import type { CompanionSessionStore } from "./companionReadService";
import { assertSafeWorkspaceIdentifier } from "./workspaceIdentifier";

export class FilesystemCompanionStore implements CompanionSessionStore {
  constructor(private readonly rootDir: string) {}

  async readSession(notebookId: string, sessionId: string): Promise<SessionRecord> {
    const sessionDir = this.getSessionDir(notebookId, sessionId);
    const session = JSON.parse(await readFile(resolve(sessionDir, "session.json"), "utf8")) as SessionRecord;
    if (session.id !== sessionId || !Array.isArray(session.blocks)) {
      throw new Error("invalid_session");
    }
    return session;
  }

  getSessionDir(notebookId: string, sessionId: string): string {
    assertSafeWorkspaceIdentifier(notebookId);
    assertSafeWorkspaceIdentifier(sessionId);
    const notebooksDir = resolve(this.rootDir, "notebooks");
    const sessionDir = resolve(notebooksDir, notebookId, "sessions", sessionId);
    if (!sessionDir.startsWith(`${notebooksDir}${sep}`)) throw new Error("path_outside_notes_root");
    return sessionDir;
  }
}
