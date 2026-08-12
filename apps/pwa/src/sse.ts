export type SseMessage = Readonly<{
  event: string;
  data: string;
  id?: string;
  retry?: number;
}>;

export async function parseSseStream(
  stream: ReadableStream<Uint8Array>,
  onMessage: (message: SseMessage) => void,
  signal?: AbortSignal
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let id: string | undefined;
  let retry: number | undefined;
  let data: string[] = [];

  const dispatch = () => {
    if (data.length === 0) {
      event = "";
      retry = undefined;
      return;
    }
    onMessage({
      event: event || "message",
      data: data.join("\n"),
      id,
      retry
    });
    event = "";
    retry = undefined;
    data = [];
  };

  const processLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0
      ? ""
      : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id" && !value.includes("\u0000")) id = value;
    else if (field === "retry" && /^\d+$/.test(value)) retry = Number(value);
  };

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let lineEnd = buffer.indexOf("\n");
      while (lineEnd >= 0) {
        processLine(buffer.slice(0, lineEnd));
        buffer = buffer.slice(lineEnd + 1);
        lineEnd = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer) processLine(buffer);
    dispatch();
  } finally {
    reader.releaseLock();
  }
}
