import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type RevisionEventScope = "catalog" | "session";
export type RevisionEventKind = "created" | "renamed" | "deleted" | "changed";

export type RevisionEvent = Readonly<{
  version: 1;
  id: string;
  scope: RevisionEventScope;
  kind: RevisionEventKind;
  notebookId?: string;
  sessionId?: string;
  revision?: string;
  at: string;
}>;

export type RevisionEventInput = Omit<RevisionEvent, "version" | "id">;

type StoredRevisionEventState = {
  version: 1;
  nextId: number;
  events: RevisionEvent[];
};

export type RevisionEventFilter = Readonly<{
  scope: RevisionEventScope;
  notebookId?: string;
  sessionId?: string;
}>;

export type RevisionReplay =
  | Readonly<{ status: "ok"; events: readonly RevisionEvent[]; latestId: string }>
  | Readonly<{ status: "resync-required"; events: readonly []; latestId: string }>;

export type RevisionEventLogOptions = {
  filePath?: string;
  maxEvents?: number;
};

export class RevisionEventLog {
  private state: StoredRevisionEventState = emptyState();
  private loaded = false;
  private operation: Promise<unknown> = Promise.resolve();
  private readonly maxEvents: number;
  private readonly listeners = new Set<(event: RevisionEvent) => void>();

  constructor(private readonly options: RevisionEventLogOptions = {}) {
    this.maxEvents = options.maxEvents ?? 512;
    if (!Number.isInteger(this.maxEvents) || this.maxEvents <= 0) throw new Error("maxEvents must be positive");
  }

  async start(): Promise<void> {
    await this.serial(async () => {
      if (this.loaded) return;
      this.state = await readState(this.options.filePath);
      this.loaded = true;
    });
  }

  async append(input: RevisionEventInput): Promise<RevisionEvent> {
    return this.serial(async () => {
      this.assertLoaded();
      validateInput(input);
      const event: RevisionEvent = {
        version: 1,
        id: String(this.state.nextId),
        ...input
      };
      const nextEvents = [...this.state.events, event].slice(-this.maxEvents);
      const nextState: StoredRevisionEventState = {
        version: 1,
        nextId: this.state.nextId + 1,
        events: nextEvents
      };
      await persistState(this.options.filePath, nextState);
      this.state = nextState;
      for (const listener of this.listeners) listener(event);
      return event;
    });
  }

  async replay(afterId: string | undefined, filter: RevisionEventFilter): Promise<RevisionReplay> {
    return this.serial(async () => {
      this.assertLoaded();
      validateFilter(filter);
      const latestId = String(this.state.nextId - 1);
      if (afterId === undefined || afterId === "") {
        return { status: "ok", events: [], latestId };
      }
      const cursor = parseEventId(afterId);
      const earliestRetained = this.state.events.length > 0
        ? Number(this.state.events[0].id)
        : this.state.nextId;
      if (cursor > this.state.nextId - 1 || cursor < earliestRetained - 1) {
        return { status: "resync-required", events: [], latestId };
      }
      return {
        status: "ok",
        events: this.state.events.filter((event) => Number(event.id) > cursor && matches(event, filter)),
        latestId
      };
    });
  }

  subscribe(listener: (event: RevisionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    await this.operation;
    this.listeners.clear();
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("RevisionEventLog.start() must be called first");
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

async function readState(filePath?: string): Promise<StoredRevisionEventState> {
  if (!filePath) return emptyState();
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!isStoredState(parsed)) throw new Error("Invalid revision event log");
    return parsed;
  } catch (error) {
    if (isMissingFile(error)) return emptyState();
    throw error;
  }
}

async function persistState(filePath: string | undefined, state: StoredRevisionEventState): Promise<void> {
  if (!filePath) return;
  const temporary = `${filePath}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function emptyState(): StoredRevisionEventState {
  return { version: 1, nextId: 1, events: [] };
}

function isStoredState(value: unknown): value is StoredRevisionEventState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredRevisionEventState>;
  if (candidate.version !== 1 || !Number.isSafeInteger(candidate.nextId) || (candidate.nextId ?? 0) < 1) return false;
  if (!Array.isArray(candidate.events)) return false;
  return candidate.events.every((event) => isRevisionEvent(event));
}

function isRevisionEvent(value: unknown): value is RevisionEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<RevisionEvent>;
  return event.version === 1
    && typeof event.id === "string"
    && (event.scope === "catalog" || event.scope === "session")
    && ["created", "renamed", "deleted", "changed"].includes(event.kind ?? "")
    && typeof event.at === "string";
}

function validateInput(input: RevisionEventInput): void {
  validateFilter(input);
  if (!["created", "renamed", "deleted", "changed"].includes(input.kind)) throw new Error("Invalid event kind");
  if (!input.at.trim() || !Number.isFinite(Date.parse(input.at))) throw new Error("Invalid event timestamp");
  if (input.scope === "session" && (!input.notebookId?.trim() || !input.sessionId?.trim())) {
    throw new Error("Session events require notebookId and sessionId");
  }
}

function validateFilter(filter: RevisionEventFilter): void {
  if (filter.scope !== "catalog" && filter.scope !== "session") throw new Error("Invalid event scope");
  if (filter.scope === "session" && (!filter.notebookId?.trim() || !filter.sessionId?.trim())) {
    throw new Error("Session filter requires notebookId and sessionId");
  }
}

function parseEventId(value: string): number {
  if (!/^\d+$/.test(value)) return Number.MAX_SAFE_INTEGER;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function matches(event: RevisionEvent, filter: RevisionEventFilter): boolean {
  if (event.scope !== filter.scope) return false;
  if (filter.scope === "catalog") return true;
  return event.notebookId === filter.notebookId && event.sessionId === filter.sessionId;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
