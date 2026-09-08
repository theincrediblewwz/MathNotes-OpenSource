import { AsyncLocalStorage } from "node:async_hooks";

export class SessionWriteCoordinator {
  private workspaceQueue: Promise<void> = Promise.resolve();
  private readonly workspaceOwner = new AsyncLocalStorage<{ active: boolean }>();
  private readonly queues = new Map<string, Promise<void>>();

  /** A root-wide barrier waits for earlier writes and blocks later Session writes.
   * Calls made by the barrier itself may reuse it; detached callbacks cannot keep
   * that privilege after the outer operation has finished. */
  runWorkspace<T>(operation: () => Promise<T>): Promise<T> {
    if (this.workspaceOwner.getStore()?.active) return operation();
    const previous = Promise.all([this.workspaceQueue, ...this.queues.values()]);
    const result = previous.then(async () => {
      const owner = { active: true };
      try { return await this.workspaceOwner.run(owner, operation); }
      finally { owner.active = false; }
    });
    this.workspaceQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  run<T>(notebookId: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.runMany([{ notebookId, sessionId }], operation);
  }

  runMany<T>(
    sessions: readonly Readonly<{ notebookId: string; sessionId: string }>[],
    operation: () => Promise<T>
  ): Promise<T> {
    if (this.workspaceOwner.getStore()?.active) return operation();
    const keys = [...new Set(sessions.map(({ notebookId, sessionId }) => `${notebookId}\0${sessionId}`))].sort();
    const previous = Promise.all([this.workspaceQueue, ...keys.map((key) => this.queues.get(key) ?? Promise.resolve())]);
    const result = previous.then(operation);
    const settled = result.then(() => undefined, () => undefined);
    keys.forEach((key) => this.queues.set(key, settled));
    void settled.finally(() => {
      keys.forEach((key) => {
        if (this.queues.get(key) === settled) this.queues.delete(key);
      });
    });
    return result;
  }
}
