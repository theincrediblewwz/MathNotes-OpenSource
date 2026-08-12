import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2"
};

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self' http: https:",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' blob: data:",
  "manifest-src 'self'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self'"
].join("; ");

export class PwaStaticHost {
  private readonly configuredRoot: string;
  private rootRealPath?: Promise<string>;

  constructor(rootDirectory: string) {
    if (!isAbsolute(rootDirectory)) throw new Error("PWA static root must be an absolute path");
    this.configuredRoot = resolve(rootDirectory);
  }

  async tryHandle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/local/")) return false;
    const resolved = await this.resolveRequestPath(url.pathname, response);
    if (resolved === "handled") return true;
    if (!resolved) return false;

    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD", ...securityHeaders() });
      response.end();
      return true;
    }

    const fileStat = await stat(resolved.absolutePath).catch(() => undefined);
    if (!fileStat?.isFile()) return false;
    const headers = {
      ...securityHeaders(),
      "cache-control": cacheControl(resolved.relativePath),
      "content-length": String(fileStat.size),
      "content-type": contentType(resolved.relativePath),
      ...(resolved.relativePath === "sw.js" ? { "service-worker-allowed": "/" } : {})
    };
    response.writeHead(200, headers);
    if (method === "HEAD") {
      response.end();
      return true;
    }
    await pipeline(createReadStream(resolved.absolutePath), response);
    return true;
  }

  private async resolveRequestPath(
    pathname: string,
    response: ServerResponse
  ): Promise<{ absolutePath: string; relativePath: string } | "handled" | undefined> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      writeStaticError(response, 400, "invalid_path_encoding");
      return "handled";
    }
    if (decoded.includes("\\") || decoded.includes("\0")) {
      writeStaticError(response, 400, "invalid_static_path");
      return "handled";
    }
    const segments = decoded.split("/").filter(Boolean);
    if (segments.some((segment) => segment === "." || segment === ".." || segment.startsWith("."))) {
      writeStaticError(response, 400, "invalid_static_path");
      return "handled";
    }
    const relativePath = segments.length === 0 ? "index.html" : segments.join("/");
    const rootRealPath = await this.resolveRoot().catch(() => undefined);
    if (!rootRealPath) return undefined;
    const candidate = resolve(rootRealPath, ...relativePath.split("/"));
    const candidateRealPath = await realpath(candidate).catch(() => undefined);
    if (!candidateRealPath) return undefined;
    const relation = relative(rootRealPath, candidateRealPath);
    if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
      writeStaticError(response, 403, "static_path_outside_root");
      return "handled";
    }
    return { absolutePath: candidateRealPath, relativePath };
  }

  private resolveRoot(): Promise<string> {
    this.rootRealPath ??= realpath(this.configuredRoot);
    return this.rootRealPath;
  }
}

function securityHeaders(): Record<string, string> {
  return {
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff"
  };
}

function contentType(relativePath: string): string {
  const extension = relativePath.includes(".") ? relativePath.slice(relativePath.lastIndexOf(".")) : "";
  return CONTENT_TYPES[extension.toLowerCase()] ?? "application/octet-stream";
}

function cacheControl(relativePath: string): string {
  if (relativePath === "index.html" || relativePath === "sw.js" || relativePath.endsWith(".webmanifest")) {
    return "no-cache";
  }
  if (relativePath.startsWith("assets/") && /[-.][A-Za-z0-9_]{8,}\./.test(relativePath)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

function writeStaticError(response: ServerResponse, statusCode: number, error: string): void {
  response.writeHead(statusCode, {
    ...securityHeaders(),
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(`${JSON.stringify({ error })}\n`);
}
