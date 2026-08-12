export type ProviderHttpTiming = {
  fetchCalledAt?: number;
  responseHeadersAt?: number;
  firstBodyChunkAt?: number;
  requestBodyBytes?: number;
  responseStatus?: number;
  responseContentType?: string;
};

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function createProviderHttpTimingFetch(args: {
  timing: ProviderHttpTiming;
  fetchImpl?: FetchLike;
  now?: () => number;
}): FetchLike {
  const fetchImpl = args.fetchImpl ?? fetch;
  const now = args.now ?? (() => performance.now());

  return async (url, init) => {
    args.timing.fetchCalledAt ??= now();
    args.timing.requestBodyBytes ??= requestBodyBytes(init.body);

    const response = await fetchImpl(url, init);
    args.timing.responseHeadersAt ??= now();
    args.timing.responseStatus = response.status;
    args.timing.responseContentType = response.headers.get("content-type") ?? undefined;

    if (!response.body) return response;

    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        if (chunk.value.byteLength > 0) {
          args.timing.firstBodyChunkAt ??= now();
        }
        controller.enqueue(chunk.value);
      },
      async cancel(reason) {
        await reader.cancel(reason);
      }
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  };
}

function requestBodyBytes(body: BodyInit | null | undefined): number | undefined {
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  return undefined;
}
