export type GatewayRecognitionResult = Readonly<{ taskId: string; status: "succeeded"; markdown: string }>;

export async function recognizeViaGateway(input: Readonly<{
  gatewayUrl: string;
  token: string;
  sessionId: string;
  asset: Blob;
  fileName: string;
  fetchImpl?: typeof fetch;
}>): Promise<GatewayRecognitionResult> {
  const endpoint = normalizeGatewayUrl(input.gatewayUrl);
  if (!input.token.trim()) throw new Error("Gateway 临时令牌不能为空");
  const requestId = crypto.randomUUID();
  const response = await (input.fetchImpl ?? fetch)(`${endpoint}/v1/recognitions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token.trim()}`,
      "Content-Type": "application/json",
      "Idempotency-Key": requestId
    },
    cache: "no-store",
    body: JSON.stringify({
      version: 1,
      sessionId: input.sessionId,
      fileName: input.fileName,
      mimeType: input.asset.type || "application/octet-stream",
      imageDataUrl: await blobToDataUrl(input.asset)
    })
  });
  const payload = await response.json() as { taskId?: string; status?: string; markdown?: string; error?: string };
  if (!response.ok) throw new Error(payload.error || `Gateway HTTP ${response.status}`);
  if (payload.status !== "succeeded" || !payload.taskId || !payload.markdown) {
    throw new Error("Gateway 尚未返回可用草稿；异步轮询将在下一切片接入")
  }
  return { taskId: payload.taskId, status: "succeeded", markdown: payload.markdown };
}

export function normalizeGatewayUrl(value: string): string {
  const url = new URL(value.trim());
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Gateway 必须使用 HTTPS；HTTP 仅允许本机测试")
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("图片编码失败"));
    reader.readAsDataURL(blob);
  });
}
