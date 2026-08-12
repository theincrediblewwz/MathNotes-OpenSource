export class SessionWriteCoordinator {
  private readonly queues = new Map<string, Promise<void>>();

  run<T>(notebookId: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.runMany([{ notebookId, sessionId }], operation);
  }

  runMany<T>(
    sessions: readonly Readonly<{ notebookId: string; sessionId: string }>[],
    operation: () => Promise<T>
  ): Promise<T> {
    const keys = [...new Set(sessions.map(({ notebookId, sessionId }) => `${notebookId}\0${sessionId}`))].sort();
    const previous = Promise.all(keys.map((key) => this.queues.get(key) ?? Promise.resolve()));
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
