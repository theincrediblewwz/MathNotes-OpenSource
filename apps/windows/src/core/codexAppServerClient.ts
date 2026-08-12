export type JsonRpcRequest = {
  id: number;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

export type WebSocketLike = {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
};

export type CodexAppServerClientArgs = {
  url: string;
  WebSocketImpl?: (url: string) => WebSocketLike;
  requestTimeoutMs?: number;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class CodexAppServerClient {
  private readonly createWebSocket: (url: string) => WebSocketLike;
  private readonly requestTimeoutMs: number;
  private socket: WebSocketLike | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationListeners = new Set<(message: JsonRpcNotification) => void>();

  constructor(private readonly args: CodexAppServerClientArgs) {
    this.createWebSocket = args.WebSocketImpl ?? ((url) => new WebSocket(url));
    this.requestTimeoutMs = args.requestTimeoutMs ?? 30_000;
  }

  connect(): Promise<void> {
    if (this.socket) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const socket = this.createWebSocket(this.args.url);
      this.socket = socket;
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("message", (event) => this.handleMessage(event.data));
      socket.addEventListener("error", () => reject(new Error(`Codex app-server WebSocket error: ${this.args.url}`)));
      socket.addEventListener("close", () => this.rejectPending("Codex app-server WebSocket closed"));
    });
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.socket) {
      throw new Error("Codex app-server client is not connected");
    }

    const id = this.nextRequestId++;
    const payload: JsonRpcRequest = { id, method, params };
    const response = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout
      });
    });
    this.socket.send(JSON.stringify(payload));
    return response;
  }

  onNotification(listener: (message: JsonRpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.rejectPending("Codex app-server client closed");
  }

  private handleMessage(data: unknown): void {
    const message = JSON.parse(String(data)) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: unknown;
    };

    if (typeof message.id === "number") {
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        request.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        return;
      }
      request.resolve(message.result);
      return;
    }

    if (message.method) {
      for (const listener of this.notificationListeners) {
        listener({ method: message.method, params: message.params });
      }
    }
  }

  private rejectPending(message: string): void {
    for (const [id, request] of this.pending) {
      clearTimeout(request.timeout);
      request.reject(new Error(message));
      this.pending.delete(id);
    }
  }
}
