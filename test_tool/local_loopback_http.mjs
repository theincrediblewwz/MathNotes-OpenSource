import { request } from "node:http";

export function requestLocal(url, init = {}) {
  return new Promise((resolve, reject) => {
    const requestBody = normalizeBody(init.body);
    const clientRequest = request(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      signal: init.signal
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          async text() {
            return body.toString("utf8");
          }
        });
      });
    });
    clientRequest.once("error", reject);
    if (requestBody) clientRequest.write(requestBody);
    clientRequest.end();
  });
}

function normalizeBody(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array) return body;
  throw new TypeError(`Unsupported local HTTP body: ${typeof body}`);
}
