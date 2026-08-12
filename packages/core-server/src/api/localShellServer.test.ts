import { describe, expect, it } from "vitest";
import { request } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantProvider, RecognitionProvider, SessionRecord } from "@mathnotes/shared";
import { SessionRecognitionService } from "../session/sessionRecognitionService";
import { SessionAssistantService } from "../session/sessionAssistantService";
import { SessionEditError, SessionEditService } from "../session/sessionEditService";
import { SessionSelectionEditService } from "../session/sessionSelectionEditService";
import { LocalShellServer } from "./localShellServer";
import { RuntimeProviderRegistry } from "../provider/runtimeProviderRegistry";
import type { PromptTemplate } from "../provider/aiGuidanceSettingsService";

describe("LocalShellServer", () => {
  it("configures and clears an in-memory provider without exposing its API key", async () => {
    const token = "k".repeat(48);
    const apiKey = "never-return-this-key";
    const registry = new RuntimeProviderRegistry();
    const server = new LocalShellServer({ port: 0, token, providerRegistry: registry });
    const started = await server.start();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    try {
      expect((await fetch(`${started.url}/local/v1/provider`)).status).toBe(401);
      const configured = await fetch(`${started.url}/local/v1/provider`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          providerId: "mimo_2_5",
          model: "mimo-v2.5",
          baseUrl: "https://api.xiaomimimo.com/v1",
          apiKey
        })
      });
      expect(configured.status).toBe(200);
      const configuredText = await configured.text();
      expect(configuredText).toContain('"configured":true');
      expect(configuredText).not.toContain(apiKey);

      const status = await fetch(`${started.url}/local/v1/provider`, { headers });
      expect(await status.json()).toMatchObject({ configured: true, providerId: "mimo_2_5" });
      const inheritedAssistant = await fetch(`${started.url}/local/v1/provider?purpose=assistant`, { headers });
      await expect(inheritedAssistant.json()).resolves.toMatchObject({
        configured: true, purpose: "assistant", inherited: true, model: "mimo-v2.5"
      });
      const assistantConfigured = await fetch(`${started.url}/local/v1/provider?purpose=assistant`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          providerId: "glm_5_2",
          model: "glm-dialogue",
          baseUrl: "https://dialogue.example/v1",
          apiKey: "assistant-secret"
        })
      });
      const assistantText = await assistantConfigured.text();
      expect(assistantText).toContain('"inherited":false');
      expect(assistantText).not.toContain("assistant-secret");
      const clearedAssistant = await fetch(`${started.url}/local/v1/provider/clear?purpose=assistant`, { method: "POST", headers });
      await expect(clearedAssistant.json()).resolves.toMatchObject({ inherited: true, model: "mimo-v2.5" });
      const cleared = await fetch(`${started.url}/local/v1/provider/clear`, { method: "POST", headers });
      await expect(cleared.json()).resolves.toEqual({ version: 1, configured: false });
    } finally {
      await server.stop();
    }
  });

  it("uses a separate local token and never exposes companion routes", async () => {
    const token = "l".repeat(48);
    const server = new LocalShellServer({ port: 0, token });
    const started = await server.start();
    try {
      const missing = await fetch(`${started.url}/local/v1/health`);
      expect(missing.status).toBe(401);

      const companionToken = await fetch(`${started.url}/local/v1/health`, {
        headers: { Authorization: "Bearer companion-token" }
      });
      expect(companionToken.status).toBe(401);

      const ready = await fetch(`${started.url}/local/v1/health`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(ready.status).toBe(200);
      await expect(ready.json()).resolves.toEqual({ ok: true, apiVersion: 1 });

      const companionRoute = await fetch(`${started.url}/api/v1/companion/session`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(companionRoute.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it("survives 100 start-health-stop cycles without retaining a listener", async () => {
    const token = "c".repeat(48);
    const server = new LocalShellServer({ port: 0, token });
    for (let index = 0; index < 100; index += 1) {
      const started = await server.start();
      expect(await requestStatus(started.url, token)).toBe(200);
      await server.stop();
    }
  });

  it("rejects short host tokens before opening a listener", () => {
    expect(() => new LocalShellServer({ port: 0, token: "short" })).toThrow(
      "Local shell token must contain at least 32 bytes"
    );
  });

  it("rejects non-loopback hosts at runtime", () => {
    expect(() => new LocalShellServer({
      host: "0.0.0.0",
      port: 0,
      token: "l".repeat(48)
    } as unknown as ConstructorParameters<typeof LocalShellServer>[0])).toThrow(
      "Local shell server may only listen on loopback"
    );
  });

  it("returns a path-free catalog only to the trusted local token", async () => {
    const token = "p".repeat(48);
    const server = new LocalShellServer({
      port: 0,
      token,
      readCatalog: async () => ({
        notebooks: [{
          notebookId: "analysis",
          title: "泛函分析",
          sessionCount: 1,
          createdAt: "2026-07-23T00:00:00.000Z",
          updatedAt: "2026-07-23T01:00:00.000Z",
          sessions: [{
            notebookId: "analysis",
            sessionId: "lecture",
            title: "第三讲",
            status: "draft",
            createdAt: "2026-07-23T00:00:00.000Z",
            updatedAt: "2026-07-23T01:00:00.000Z"
          }]
        }]
      })
    });
    const started = await server.start();
    try {
      expect((await fetch(`${started.url}/local/v1/catalog`)).status).toBe(401);
      const response = await fetch(`${started.url}/local/v1/catalog`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("泛函分析");
      expect(body).not.toContain("notesRootDir");
      expect(body).not.toMatch(/(?:[A-Z]:\\|\/Users\/|\/home\/)/);
    } finally {
      await server.stop();
    }
  });

  it("serves prompt and notation settings only through the trusted local contract", async () => {
    const token = "g".repeat(48);
    let promptConfig = { activeTemplateId: "math_faithful_v1", templates: [] as PromptTemplate[] };
    const notationConfig = { schemaVersion: "nh1-v1" as const, revision: 1, profiles: [] };
    const server = new LocalShellServer({
      port: 0,
      token,
      readPromptTemplates: () => promptConfig,
      savePromptTemplates: async (input) => { promptConfig = input; return input; },
      readNotationProfiles: () => notationConfig,
      saveNotationProfiles: async (input) => input,
      previewNotation: (input) => ({
        selection: {
          schemaVersion: "nh1-v1", query: input.query, rules: [], conflicts: [], omittedByBudget: 0,
          characterCount: 0, selectionHash: "hash", promptFragment: ""
        },
        fullPrompt: `preview:${input.query}`
      })
    });
    const started = await server.start();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    try {
      expect((await fetch(`${started.url}/local/v1/ai/prompt-templates`)).status).toBe(401);
      const saved = await fetch(`${started.url}/local/v1/ai/prompt-templates`, {
        method: "POST", headers,
        body: JSON.stringify({ activeTemplateId: "course", templates: [{ id: "course", name: "课程", content: "忠实转写" }] })
      });
      expect(saved.status).toBe(200);
      await expect(saved.json()).resolves.toMatchObject({ activeTemplateId: "course" });
      const preview = await fetch(`${started.url}/local/v1/ai/notation-preview`, {
        method: "POST", headers, body: JSON.stringify({ query: "ξ" })
      });
      await expect(preview.json()).resolves.toMatchObject({ fullPrompt: "preview:ξ" });
    } finally {
      await server.stop();
    }
  });

  it("tests provider connectivity through the authenticated local route with a local fake endpoint", async () => {
    const token = "v".repeat(48);
    const apiKey = "route-probe-secret";
    const calls: Array<{ url: string; body: string }> = [];
    const registry = new RuntimeProviderRegistry(async (url, init) => {
      calls.push({ url, body: String(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    registry.configure({
      providerId: "glm_5_2",
      model: "glm-5.2v",
      baseUrl: "https://dialogue.example.test/v1",
      apiKey
    }, "assistant");
    const server = new LocalShellServer({ port: 0, token, providerRegistry: registry });
    const started = await server.start();
    const headers = { Authorization: `Bearer ${token}` };
    try {
      const unauthorized = await fetch(`${started.url}/local/v1/provider/test?purpose=assistant`, {
        method: "POST"
      });
      expect(unauthorized.status).toBe(401);

      const unconfigured = await fetch(`${started.url}/local/v1/provider/test`, {
        method: "POST",
        headers
      });
      expect(unconfigured.status).toBe(503);
      await expect(unconfigured.json()).resolves.toEqual({ error: "provider_unavailable" });

      const response = await fetch(`${started.url}/local/v1/provider/test?purpose=assistant`, {
        method: "POST",
        headers
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ version: 1, purpose: "assistant", ok: true });
      expect(JSON.stringify(body)).not.toContain(apiKey);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://dialogue.example.test/v1/chat/completions");
      expect(calls[0].body).not.toContain(apiKey);
    } finally {
      await server.stop();
    }
  });

  it("exposes recent companion upload activity only to the trusted local shell", async () => {
    const token = "u".repeat(48);
    const server = new LocalShellServer({
      port: 0,
      token,
      readSessionCompanionActivity: ({ notebookId, sessionId }) => ({
        version: 1,
        notebookId,
        sessionId,
        captureId: "capture-1",
        fileName: "board.jpg",
        receivedBytes: 512,
        totalBytes: 1024,
        status: "receiving",
        updatedAt: "2026-07-29T00:00:00.000Z"
      })
    });
    const started = await server.start();
    const query = "notebookId=analysis&sessionId=lecture";
    try {
      expect((await fetch(`${started.url}/local/v1/session/companion-activity?${query}`)).status).toBe(401);
      const response = await fetch(`${started.url}/local/v1/session/companion-activity?${query}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        version: 1,
        activity: {
          notebookId: "analysis",
          sessionId: "lecture",
          receivedBytes: 512,
          totalBytes: 1024,
          status: "receiving"
        }
      });
    } finally {
      await server.stop();
    }
  });

  it("creates a companion pairing challenge only through the trusted local route", async () => {
    const token = "q".repeat(48);
    const server = new LocalShellServer({
      port: 0,
      token,
      createCompanionPairingChallenge: async () => ({
        challengeId: "challenge-1",
        userCode: "ABCD-EFGH",
        expiresAt: "2026-07-26T12:10:00.000Z",
        remainingAttempts: 5
      })
    });
    const started = await server.start();
    try {
      expect((await fetch(`${started.url}/local/v1/companion/pairing-challenge`, {
        method: "POST"
      })).status).toBe(401);

      const response = await fetch(`${started.url}/local/v1/companion/pairing-challenge`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual({
        version: 1,
        challenge: {
          challengeId: "challenge-1",
          userCode: "ABCD-EFGH",
          expiresAt: "2026-07-26T12:10:00.000Z",
          remainingAttempts: 5
        }
      });
    } finally {
      await server.stop();
    }
  });

  it("creates notebooks and sessions through authenticated workspace routes", async () => {
    const token = "n".repeat(48);
    const calls: unknown[] = [];
    const server = new LocalShellServer({
      port: 0,
      token,
      createNotebook: async (input) => {
        calls.push(["notebook", input]);
        return {
          notebookId: "analysis",
          title: input.title,
          sessionCount: 0,
          createdAt: "2026-07-26T00:00:00.000Z",
          updatedAt: "2026-07-26T00:00:00.000Z",
          sessions: []
        };
      },
      createSession: async (input) => {
        calls.push(["session", input]);
        return {
          notebookId: input.notebookId,
          sessionId: "lecture",
          title: input.title,
          status: "draft",
          createdAt: "2026-07-26T00:01:00.000Z",
          updatedAt: "2026-07-26T00:01:00.000Z"
        };
      }
    });
    const started = await server.start();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    try {
      const unauthorized = await fetch(`${started.url}/local/v1/notebooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "泛函分析" })
      });
      expect(unauthorized.status).toBe(401);

      const notebook = await fetch(`${started.url}/local/v1/notebooks`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "泛函分析" })
      });
      expect(notebook.status).toBe(201);
      await expect(notebook.json()).resolves.toMatchObject({
        version: 1,
        notebook: { notebookId: "analysis", title: "泛函分析", sessionCount: 0 }
      });

      const session = await fetch(`${started.url}/local/v1/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ notebookId: "analysis", title: "第 1 讲" })
      });
      expect(session.status).toBe(201);
      await expect(session.json()).resolves.toMatchObject({
        version: 1,
        session: { notebookId: "analysis", sessionId: "lecture", title: "第 1 讲" }
      });
      expect(calls).toEqual([
        ["notebook", { title: "泛函分析" }],
        ["session", { notebookId: "analysis", title: "第 1 讲" }]
      ]);
    } finally {
      await server.stop();
    }
  });

  it("serves ordered session content and binary assets only through the local token", async () => {
    const token = "r".repeat(48);
    const server = new LocalShellServer({
      port: 0,
      token,
      readSessionManifest: async ({ notebookId, sessionId }) => ({
        version: 1,
        notebookId,
        sessionId,
        title: "第三讲",
        status: "draft",
        updatedAt: "2026-07-23T01:00:00.000Z",
        revision: "a".repeat(64),
        blocks: [{
          id: "0001", order: 0, type: "markdown", source: "user", status: "draft",
          sourceName: "0001.md", renderInNote: true, editable: true, updatedAt: "2026-07-23T01:00:00.000Z"
        }]
      }),
      readSessionBlock: async ({ notebookId, sessionId, blockId }) => ({
        version: 1,
        notebookId,
        sessionId,
        block: {
          id: blockId, order: 0, type: "markdown", source: "user", status: "draft",
          sourceName: "0001.md", renderInNote: true, editable: true, updatedAt: "2026-07-23T01:00:00.000Z"
        },
        content: {
          kind: "markdown", html: "<p>正文</p>", markdown: "正文", baseRevision: "b".repeat(64),
          blockLocked: false, protectedSpanCount: 0
        }
      }),
      readSessionAsset: async () => ({ bytes: Buffer.from("asset"), mimeType: "image/png" })
    });
    const started = await server.start();
    const headers = { Authorization: `Bearer ${token}` };
    try {
      const query = "notebookId=analysis&sessionId=lecture";
      expect((await fetch(`${started.url}/local/v1/session/manifest?${query}`)).status).toBe(401);
      const manifest = await fetch(`${started.url}/local/v1/session/manifest?${query}`, { headers });
      expect(manifest.status).toBe(200);
      await expect(manifest.json()).resolves.toMatchObject({ title: "第三讲", blocks: [{ id: "0001" }] });

      const block = await fetch(`${started.url}/local/v1/session/block?${query}&blockId=0001`, { headers });
      await expect(block.json()).resolves.toMatchObject({ content: { kind: "markdown", html: "<p>正文</p>" } });

      const asset = await fetch(`${started.url}/local/v1/session/asset?${query}&path=assets%2Fgraph.png`, { headers });
      expect(asset.headers.get("content-type")).toBe("image/png");
      expect(await asset.text()).toBe("asset");
      expect((await fetch(`${started.url}/local/v1/session/manifest`, { headers })).status).toBe(400);
    } finally {
      await server.stop();
    }
  });

  it("saves one Markdown block through an authenticated bounded POST", async () => {
    const token = "w".repeat(48);
    const revision = "b".repeat(64);
    const calls: unknown[] = [];
    const manifestBlock = {
      id: "0001", order: 0, type: "markdown" as const, source: "user" as const, status: "draft" as const,
      sourceName: "0001.md", renderInNote: true, editable: true, updatedAt: "2026-07-23T01:00:00.000Z"
    };
    const server = new LocalShellServer({
      port: 0,
      token,
      saveSessionBlock: async (input) => {
        calls.push(input);
        return {
          version: 1,
          saved: true,
          block: {
            version: 1, notebookId: input.notebookId, sessionId: input.sessionId, block: manifestBlock,
            content: {
              kind: "markdown", html: "<p>新正文</p>", markdown: input.markdown,
              baseRevision: "c".repeat(64), blockLocked: false, protectedSpanCount: 0
            }
          }
        };
      }
    });
    const started = await server.start();
    const url = `${started.url}/local/v1/session/block?notebookId=analysis&sessionId=lecture&blockId=0001`;
    try {
      const unauthorized = await fetch(url, {
        method: "POST", body: JSON.stringify({ markdown: "新正文", baseRevision: revision })
      });
      expect(unauthorized.status).toBe(401);
      const saved = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: "新正文", baseRevision: revision })
      });
      expect(saved.status).toBe(200);
      await expect(saved.json()).resolves.toMatchObject({ saved: true, block: { content: { markdown: "新正文" } } });
      expect(calls).toEqual([{
        notebookId: "analysis", sessionId: "lecture", blockId: "0001", markdown: "新正文", baseRevision: revision
      }]);
      const invalid = await fetch(url, {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}"
      });
      expect(invalid.status).toBe(400);
      const oversized = await fetch(url, {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ markdown: "x".repeat(2 * 1024 * 1024), baseRevision: revision })
      });
      expect(oversized.status).toBe(413);
      await expect(oversized.json()).resolves.toEqual({ error: "request_body_too_large" });
    } finally {
      await server.stop();
    }
  });

  it("lists, reads and resolves durable Markdown conflicts through authenticated routes", async () => {
    const token = "f".repeat(48);
    const revision = "c".repeat(64);
    const conflictId = "d".repeat(64);
    const summary = {
      version: 1 as const, id: conflictId, blockId: "0001", baseRevision: "a".repeat(64),
      currentRevision: revision, incomingWriterId: "mac", reason: "diverged_edit" as const,
      status: "unresolved" as const, createdAt: "2026-07-24T00:00:00.000Z"
    };
    const calls: unknown[] = [];
    const block = {
      version: 1 as const, notebookId: "analysis", sessionId: "lecture",
      block: {
        id: "0001", order: 0, type: "markdown" as const, source: "user" as const, status: "draft" as const,
        sourceName: "0001.md", renderInNote: true, editable: true, updatedAt: "2026-07-24T00:00:00.000Z"
      },
      content: {
        kind: "markdown" as const, html: "<p>合并</p>", markdown: "合并", baseRevision: "e".repeat(64),
        blockLocked: false, protectedSpanCount: 0
      }
    };
    const server = new LocalShellServer({
      port: 0,
      token,
      listSessionConflicts: async (input) => { calls.push(["list", input]); return [summary]; },
      readSessionConflict: async (input) => {
        calls.push(["read", input]);
        return { ...summary, currentMarkdown: "当前", incomingMarkdown: "来稿" };
      },
      resolveSessionConflict: async (input) => {
        calls.push(["resolve", input]);
        return { version: 1, resolved: true, conflict: { ...summary, status: "resolved_merged" }, block };
      }
    });
    const started = await server.start();
    const base = `${started.url}/local/v1/session`;
    const query = `notebookId=analysis&sessionId=lecture&conflictId=${conflictId}`;
    const headers = { Authorization: `Bearer ${token}` };
    try {
      const listed = await fetch(`${base}/conflicts?notebookId=analysis&sessionId=lecture&blockId=0001`, { headers });
      await expect(listed.json()).resolves.toMatchObject({ conflicts: [{ id: conflictId }] });
      const read = await fetch(`${base}/conflict?${query}`, { headers });
      await expect(read.json()).resolves.toMatchObject({ incomingMarkdown: "来稿" });
      const resolved = await fetch(`${base}/conflict/resolve?${query}`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ resolution: "merged", markdown: "合并", baseRevision: revision })
      });
      await expect(resolved.json()).resolves.toMatchObject({ resolved: true, conflict: { status: "resolved_merged" } });
      expect(calls).toHaveLength(3);
      expect(calls[2]).toEqual(["resolve", {
        notebookId: "analysis", sessionId: "lecture", conflictId,
        resolution: "merged", markdown: "合并", baseRevision: revision
      }]);
    } finally {
      await server.stop();
    }
  });

  it("imports one bounded image through an authenticated binary POST", async () => {
    const token = "i".repeat(48);
    const revision = "d".repeat(64);
    const calls: Array<{ fileName: string; bytes: Buffer; baseRevision: string }> = [];
    const server = new LocalShellServer({
      port: 0,
      token,
      importSessionImage: async (input) => {
        calls.push({ fileName: input.fileName, bytes: input.bytes, baseRevision: input.baseRevision });
        return {
          version: 1,
          imported: true,
          blockId: "0002",
          manifest: {
            version: 1,
            notebookId: input.notebookId,
            sessionId: input.sessionId,
            title: "第三讲",
            status: "draft",
            updatedAt: "2026-07-23T04:00:00.000Z",
            revision: "e".repeat(64),
            blocks: []
          }
        };
      }
    });
    const started = await server.start();
    const query = `notebookId=analysis&sessionId=lecture&fileName=board.png&baseRevision=${revision}`;
    const url = `${started.url}/local/v1/session/image?${query}`;
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]);
    try {
      expect((await fetch(url, { method: "POST", body: bytes })).status).toBe(401);
      const imported = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
        body: bytes
      });
      expect(imported.status).toBe(200);
      await expect(imported.json()).resolves.toMatchObject({ imported: true, blockId: "0002" });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ fileName: "board.png", baseRevision: revision });
      expect(calls[0]?.bytes).toEqual(bytes);

      const invalidRevision = await fetch(url.replace(revision, "bad"), {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, body: bytes
      });
      expect(invalidRevision.status).toBe(400);
      await expect(invalidRevision.json()).resolves.toEqual({ error: "invalid_baseRevision" });

      const oversized = await fetch(url, {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, body: Buffer.alloc(25 * 1024 * 1024 + 1)
      });
      expect(oversized.status).toBe(413);
      await expect(oversized.json()).resolves.toEqual({ error: "request_body_too_large" });
    } finally {
      await server.stop();
    }
  });

  it("imports one bounded PDF through an authenticated binary POST", async () => {
    const token = "p".repeat(48);
    const revision = "f".repeat(64);
    const calls: Array<{ fileName: string; bytes: Buffer; baseRevision: string }> = [];
    const server = new LocalShellServer({
      port: 0,
      token,
      importSessionPdf: async (input) => {
        calls.push({ fileName: input.fileName, bytes: input.bytes, baseRevision: input.baseRevision });
        return {
          version: 1,
          imported: true,
          blockId: "0002",
          assetPath: "assets/pdfs/lecture.pdf",
          pageCount: 1,
          manifest: {
            version: 1,
            notebookId: input.notebookId,
            sessionId: input.sessionId,
            title: "第三讲",
            status: "draft",
            updatedAt: "2026-07-28T04:00:00.000Z",
            revision: "a".repeat(64),
            blocks: []
          }
        };
      }
    });
    const started = await server.start();
    const query = `notebookId=analysis&sessionId=lecture&fileName=lecture.pdf&baseRevision=${revision}`;
    const url = `${started.url}/local/v1/session/pdf?${query}`;
    const bytes = Buffer.from("%PDF-1.7\n%%EOF", "latin1");
    try {
      const imported = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/pdf" },
        body: bytes
      });
      expect(imported.status).toBe(200);
      await expect(imported.json()).resolves.toMatchObject({
        imported: true,
        blockId: "0002",
        pageCount: 1
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ fileName: "lecture.pdf", baseRevision: revision });
      expect(calls[0]?.bytes).toEqual(bytes);
    } finally {
      await server.stop();
    }
  });

  it("creates recognition work and replays only events after the requested sequence", async () => {
    const fixture = await recognitionFixture(async () => ({
      name: "local-fixture",
      async transcribe() { return { markdown: "## 结果\n" }; },
      async transcribeWithEvents(input) {
        input.onEvent({ type: "stdout", text: "## " });
        input.onEvent({ type: "stdout", text: "结果\n" });
        return { markdown: "## 结果\n" };
      }
    }));
    const token = "e".repeat(48);
    const server = new LocalShellServer({ port: 0, token, sessionRecognition: fixture.service });
    const started = await server.start();
    const query = "notebookId=analysis&sessionId=lecture";
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    try {
      expect((await fetch(`${started.url}/local/v1/session/recognition?${query}`, {
        method: "POST", body: JSON.stringify({ imageBlockId: "0001" })
      })).status).toBe(401);
      const created = await fetch(`${started.url}/local/v1/session/recognition?${query}`, {
        method: "POST", headers, body: JSON.stringify({ imageBlockId: "0001" })
      });
      expect(created.status).toBe(202);
      const taskId = ((await created.json()) as { task: { id: string } }).task.id;
      const terminal = await waitForHttpTerminal(started.url, token, query, taskId);
      if (terminal.status !== "succeeded") throw new Error(`unexpected terminal task: ${JSON.stringify(terminal)}`);
      expect(terminal).toMatchObject({ status: "succeeded", providerName: "local-fixture" });
      const activity = await fetch(`${started.url}/local/v1/session/recognition?${query}`, { headers });
      expect(activity.status).toBe(200);
      await expect(activity.json()).resolves.toMatchObject({
        version: 1,
        tasks: [{ id: taskId, status: "succeeded", transcriptBlockId: expect.any(String) }]
      });
      const unknown = await fetch(
        `${started.url}/local/v1/session/recognition?${query}&taskId=unknown-task`, { headers }
      );
      expect(unknown.status).toBe(404);
      await expect(unknown.json()).resolves.toEqual({ error: "task_not_found" });
      const illegalCancel = await fetch(
        `${started.url}/local/v1/session/recognition/cancel?${query}&taskId=${taskId}`,
        { method: "POST", headers }
      );
      expect(illegalCancel.status).toBe(409);
      await expect(illegalCancel.json()).resolves.toEqual({ error: "task_not_cancellable" });

      const replay = await fetch(
        `${started.url}/local/v1/session/recognition/events?${query}&taskId=${taskId}`,
        { headers }
      );
      const events = ((await replay.json()) as { events: Array<{ sequence: number; type: string }> }).events;
      expect(events.some((event) => event.type === "stdout")).toBe(true);
      const after = events[Math.floor(events.length / 2)]?.sequence ?? 0;
      const tail = await fetch(
        `${started.url}/local/v1/session/recognition/events?${query}&taskId=${taskId}&afterSequence=${after}`,
        { headers }
      );
      const tailEvents = ((await tail.json()) as { events: Array<{ sequence: number }> }).events;
      expect(tailEvents.every((event) => event.sequence > after)).toBe(true);
      expect((await fetch(
        `${started.url}/local/v1/session/recognition/events?${query}&taskId=${taskId}&afterSequence=bad`,
        { headers }
      )).status).toBe(400);
    } finally {
      await server.stop();
      await fixture.cleanup();
    }
  });

  it("creates and downloads a path-free Markdown export only through the local token", async () => {
    const token = "o".repeat(48);
    const calls: unknown[] = [];
    const server = new LocalShellServer({
      port: 0,
      token,
      exportSessionMarkdown: async (input) => {
        calls.push(input);
        return {
          outPath: "C:\\private\\notes\\exports\\lecture.md",
          fileName: "lecture.md",
          relativeExportPath: "exports/lecture.md",
          exportedBlocks: 2,
          byteLength: 12,
          sha256: "f".repeat(64)
        };
      },
      readSessionMarkdownExport: async () => ({
        bytes: Buffer.from("# 第三讲\n"),
        fileName: "lecture.md",
        mimeType: "text/markdown; charset=utf-8",
        sha256: "f".repeat(64)
      })
    });
    const started = await server.start();
    const query = `notebookId=analysis&sessionId=lecture&baseRevision=${"a".repeat(64)}`;
    const headers = { Authorization: `Bearer ${token}` };
    try {
      expect((await fetch(`${started.url}/local/v1/session/export?${query}`, { method: "POST" })).status).toBe(401);
      const created = await fetch(`${started.url}/local/v1/session/export?${query}`, { method: "POST", headers });
      expect(created.status).toBe(200);
      const json = JSON.stringify(await created.json());
      expect(json).toContain("exports/lecture.md");
      expect(json).not.toContain("private");
      expect(calls).toEqual([{ notebookId: "analysis", sessionId: "lecture", baseRevision: "a".repeat(64) }]);
      const downloaded = await fetch(`${started.url}/local/v1/session/export?notebookId=analysis&sessionId=lecture`, { headers });
      expect(downloaded.headers.get("content-type")).toContain("text/markdown");
      expect(downloaded.headers.get("content-disposition")).toContain("lecture.md");
      expect(await downloaded.text()).toBe("# 第三讲\n");
    } finally {
      await server.stop();
    }
  });

  it("cancels and retries one task through authenticated local routes", async () => {
    let providerCall = 0;
    const fixture = await recognitionFixture(async () => {
      providerCall += 1;
      if (providerCall > 1) {
        return {
          name: "retry-fixture",
          async transcribe() { return { markdown: "## 重试成功\n" }; }
        };
      }
      const provider: RecognitionProvider = {
        name: "waiting-fixture",
        async transcribe(input) {
          return new Promise((_resolve, reject) => input.abortSignal?.addEventListener(
            "abort", () => reject(input.abortSignal?.reason), { once: true }
          ));
        }
      };
      return provider;
    });
    const token = "x".repeat(48);
    const server = new LocalShellServer({ port: 0, token, sessionRecognition: fixture.service });
    const started = await server.start();
    const query = "notebookId=analysis&sessionId=lecture";
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    try {
      const created = await fetch(`${started.url}/local/v1/session/recognition?${query}`, {
        method: "POST", headers, body: JSON.stringify({ imageBlockId: "0001" })
      });
      const taskId = ((await created.json()) as { task: { id: string } }).task.id;
      await waitForHttpStatus(started.url, token, query, taskId, "running");
      const cancelled = await fetch(
        `${started.url}/local/v1/session/recognition/cancel?${query}&taskId=${taskId}`,
        { method: "POST", headers }
      );
      await expect(cancelled.json()).resolves.toMatchObject({ task: { status: "cancelled" } });
      const retried = await fetch(
        `${started.url}/local/v1/session/recognition/retry?${query}&taskId=${taskId}`,
        { method: "POST", headers }
      );
      expect(retried.status).toBe(200);
      expect(await waitForHttpTerminal(started.url, token, query, taskId))
        .toMatchObject({ status: "succeeded", attempts: 2, providerName: "retry-fixture" });
    } finally {
      await server.stop();
      await fixture.cleanup();
    }
  });

  it("routes authenticated block reorder and transfer commands without accepting path-shaped ids", async () => {
    const token = "o".repeat(48);
    const calls: unknown[] = [];
    const manifest = {
      version: 1 as const,
      notebookId: "analysis",
      sessionId: "lecture",
      title: "Lecture",
      status: "draft" as const,
      updatedAt: "2026-07-28T12:00:00.000Z",
      revision: "a".repeat(64),
      blocks: []
    };
    const server = new LocalShellServer({
      port: 0,
      token,
      reorderSessionBlocks: async (input) => {
        calls.push(["reorder", input]);
        return manifest;
      },
      deleteSessionBlocks: async (input) => {
        calls.push(["delete", input]);
        return manifest;
      },
      previewSessionMarkdown: async (input) => {
        calls.push(["preview", input]);
        return { version: 1, html: `<p>${input.markdown}</p>` };
      },
      previewStandaloneMarkdown: async (input) => {
        calls.push(["standalone-preview", input]);
        return { version: 1, html: `<p>${input.markdown}</p>` };
      },
      appendSessionMarkdown: async (input) => {
        calls.push(["append", input]);
        return {
          version: 1, notebookId: input.notebookId, sessionId: input.sessionId,
          block: { id: "0004", order: 3, type: "markdown", source: "user", status: "draft", sourceName: input.sourceName ?? "0004.md", renderInNote: true, editable: true, updatedAt: "2026-08-12T00:00:00.000Z" },
          content: { kind: "markdown", html: "<p>imported</p>", markdown: input.markdown, baseRevision: "b".repeat(64), blockLocked: false, protectedSpanCount: 0 }
        };
      },
      transferSessionBlocks: async (input) => {
        calls.push(["transfer", input]);
        return { version: 1, mode: input.mode, copiedBlockIds: ["0010"], sourceCleanupPending: false };
      }
    });
    const started = await server.start();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const query = "notebookId=analysis&sessionId=lecture";
    try {
      const reordered = await fetch(`${started.url}/local/v1/session/blocks/reorder?${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ blockIds: ["0002", "0003"], direction: "up" })
      });
      await expect(reordered.json()).resolves.toEqual({ version: 1, reordered: true, manifest });

      const deleted = await fetch(`${started.url}/local/v1/session/blocks/delete?${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ blockIds: ["0002"] })
      });
      await expect(deleted.json()).resolves.toEqual({ version: 1, deleted: true, manifest });

      const previewed = await fetch(`${started.url}/local/v1/session/markdown/preview?${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ blockId: "0002", markdown: "draft" })
      });
      await expect(previewed.json()).resolves.toEqual({ version: 1, html: "<p>draft</p>" });

      const standalone = await fetch(`${started.url}/local/v1/markdown/preview`, {
        method: "POST", headers, body: JSON.stringify({ markdown: "temporary" })
      });
      await expect(standalone.json()).resolves.toEqual({ version: 1, html: "<p>temporary</p>" });

      const appended = await fetch(`${started.url}/local/v1/session/markdown?${query}`, {
        method: "POST", headers, body: JSON.stringify({ markdown: "imported", sourceName: "chapter.md" })
      });
      expect(appended.status).toBe(201);
      await expect(appended.json()).resolves.toMatchObject({ block: { id: "0004", sourceName: "chapter.md" } });

      const transferred = await fetch(`${started.url}/local/v1/session/blocks/transfer?${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          targetNotebookId: "analysis",
          targetSessionId: "lecture-2",
          blockIds: ["0002", "0003"],
          mode: "copy"
        })
      });
      await expect(transferred.json()).resolves.toMatchObject({
        version: 1, mode: "copy", copiedBlockIds: ["0010"], sourceCleanupPending: false
      });

      const unsafe = await fetch(`${started.url}/local/v1/session/blocks/reorder?${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ blockIds: ["../session.json"], direction: "down" })
      });
      expect(unsafe.status).toBe(400);
      expect(calls).toEqual([
        ["reorder", {
          notebookId: "analysis", sessionId: "lecture", blockIds: ["0002", "0003"], direction: "up"
        }],
        ["delete", {
          notebookId: "analysis", sessionId: "lecture", blockIds: ["0002"]
        }],
        ["preview", {
          notebookId: "analysis", sessionId: "lecture", blockId: "0002", markdown: "draft"
        }],
        ["standalone-preview", { markdown: "temporary" }],
        ["append", { notebookId: "analysis", sessionId: "lecture", markdown: "imported", sourceName: "chapter.md" }],
        ["transfer", {
          sourceNotebookId: "analysis", sourceSessionId: "lecture",
          targetNotebookId: "analysis", targetSessionId: "lecture-2",
          blockIds: ["0002", "0003"], mode: "copy"
        }]
      ]);
    } finally {
      await server.stop();
    }
  });

  it("previews, persists, promotes and deletes independent assistant remarks through local-only routes", async () => {
    const fixture = await assistantFixture();
    const token = "a".repeat(48);
    const server = new LocalShellServer({ port: 0, token, sessionAssistant: fixture.service });
    const started = await server.start();
    const query = "notebookId=analysis&sessionId=lecture";
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const assistantBody = {
      scope: "block",
      activeBlockId: "0001",
      question: "第 1 块讲了什么？",
      mode: "explain"
    };
    try {
      expect((await fetch(`${started.url}/local/v1/session/assistant?${query}`)).status).toBe(401);
      const preview = await fetch(`${started.url}/local/v1/session/assistant/preview?${query}`, {
        method: "POST", headers, body: JSON.stringify({ ...assistantBody, mode: undefined })
      });
      expect(preview.status).toBe(200);
      await expect(preview.json()).resolves.toMatchObject({
        version: 1,
        usage: {
          maximumTextCharacters: 104_000,
          maximumImageCount: 8,
          namedBlockOrdinals: [1]
        },
        sourceBlockIds: ["0001"]
      });

      const run = await fetch(`${started.url}/local/v1/session/assistant?${query}`, {
        method: "POST", headers, body: JSON.stringify(assistantBody)
      });
      expect(run.status).toBe(200);
      const runPayload = await run.json() as { remark: { id: string; markdown: string; usage: { textCharacters: number } } };
      expect(runPayload.remark.markdown).toBe("## 独立学习批注");
      expect(runPayload.remark.usage.textCharacters).toBe(fixture.contextCharacters());

      const listed = await fetch(`${started.url}/local/v1/session/assistant?${query}`, { headers });
      await expect(listed.json()).resolves.toMatchObject({
        version: 1,
        remarks: [{ id: runPayload.remark.id, markdown: "## 独立学习批注\n" }]
      });
      const promoted = await fetch(`${started.url}/local/v1/session/assistant/promote?${query}`, {
        method: "POST", headers, body: JSON.stringify({ remarkId: runPayload.remark.id })
      });
      await expect(promoted.json()).resolves.toMatchObject({ version: 1, promoted: true });

      const removed = await fetch(`${started.url}/local/v1/session/assistant/delete?${query}`, {
        method: "POST", headers, body: JSON.stringify({ remarkId: runPayload.remark.id })
      });
      await expect(removed.json()).resolves.toEqual({ version: 1, deleted: true });
    } finally {
      await server.stop();
      await fixture.cleanup();
    }
  });

  it("starts, polls, replays and cancels an assistant task through local-only routes", async () => {
    let providerCall = 0;
    const fixture = await assistantTaskFixture(async () => {
      providerCall += 1;
      if (providerCall === 1) return streamingAssistantProvider();
      return {
        name: "waiting-assistant",
        async assist(input) {
          return new Promise((_resolve, reject) => input.abortSignal?.addEventListener(
            "abort", () => reject(input.abortSignal?.reason), { once: true }
          ));
        }
      } satisfies AssistantProvider;
    });
    const token = "b".repeat(48);
    const server = new LocalShellServer({ port: 0, token, sessionAssistant: fixture.service });
    const started = await server.start();
    const query = "notebookId=analysis&sessionId=lecture";
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    try {
      expect((await fetch(`${started.url}/local/v1/session/assistant/start?${query}`, {
        method: "POST", body: JSON.stringify({ scope: "block", activeBlockId: "0001", mode: "explain" })
      })).status).toBe(401);

      const invalid = await fetch(`${started.url}/local/v1/session/assistant/start?${query}`, {
        method: "POST", headers,
        body: JSON.stringify({ scope: "block", activeBlockId: "0001", mode: "explain", firstByteTimeoutMs: 0 })
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toEqual({ error: "invalid_assistant_body" });

      const created = await fetch(`${started.url}/local/v1/session/assistant/start?${query}`, {
        method: "POST", headers,
        body: JSON.stringify({
          scope: "block",
          activeBlockId: "0001",
          question: "第 1 块讲了什么？",
          mode: "explain"
        })
      });
      expect(created.status).toBe(202);
      const taskId = ((await created.json()) as { task: { id: string } }).task.id;
      const terminal = await waitForHttpAssistantTerminal(started.url, token, query, taskId);
      expect(terminal).toMatchObject({ status: "succeeded", providerName: "assistant-stream", attempts: 1 });

      const events = await fetch(
        `${started.url}/local/v1/session/assistant/events?${query}&taskId=${taskId}`,
        { headers }
      );
      await expect(events.json()).resolves.toMatchObject({
        version: 1,
        events: expect.arrayContaining([
          expect.objectContaining({ taskId, type: "started" }),
          expect.objectContaining({ taskId, type: "stdout" }),
          expect.objectContaining({ taskId, type: "completed" })
        ])
      });

      const waitingCreated = await fetch(`${started.url}/local/v1/session/assistant/start?${query}`, {
        method: "POST", headers,
        body: JSON.stringify({ scope: "block", activeBlockId: "0001", mode: "summarize" })
      });
      const waitingTaskId = ((await waitingCreated.json()) as { task: { id: string } }).task.id;
      await waitForHttpAssistantStatus(started.url, token, query, waitingTaskId, "running");
      const cancelled = await fetch(
        `${started.url}/local/v1/session/assistant/cancel?${query}&taskId=${waitingTaskId}`,
        { method: "POST", headers }
      );
      await expect(cancelled.json()).resolves.toMatchObject({
        version: 1,
        task: { status: "cancelled", failureKind: "cancelled" }
      });

      const unknown = await fetch(
        `${started.url}/local/v1/session/assistant/status?${query}&taskId=unknown-task`,
        { headers }
      );
      expect(unknown.status).toBe(404);
      await expect(unknown.json()).resolves.toEqual({ error: "task_not_found" });
    } finally {
      await server.stop();
      await fixture.cleanup();
    }
  }, 15_000);

  it("forwards an explicit markdown insert anchor and surfaces stale anchor failures", async () => {
    const token = "i".repeat(48);
    const calls: Array<{
      notebookId: string;
      sessionId: string;
      markdown: string;
      insertAfterBlockId?: string;
    }> = [];
    const server = new LocalShellServer({
      port: 0,
      token,
      appendSessionMarkdown: async (input) => {
        calls.push(input);
        if (input.insertAfterBlockId === "gone") throw new SessionEditError("stale_anchor", 409);
        return {
          version: 1,
          notebookId: input.notebookId,
          sessionId: input.sessionId,
          block: {
            id: "0003", order: 2, type: "markdown", source: "user", status: "draft",
            sourceName: "middle.md", renderInNote: true, editable: true,
            updatedAt: "2026-08-13T04:00:00.000Z"
          },
          content: {
            kind: "markdown", html: "<p>middle</p>", markdown: input.markdown,
            baseRevision: "a".repeat(64), blockLocked: false, protectedSpanCount: 0
          }
        };
      }
    });
    const started = await server.start();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const query = "notebookId=analysis&sessionId=lecture";
    try {
      const anchored = await postJson(`${started.url}/local/v1/session/markdown?${query}`, headers, {
        markdown: "middle", insertAfterBlockId: "0001"
      });
      expect(anchored.status).toBe(201);
      expect(anchored.body).toMatchObject({ block: { id: "0003" } });

      const stale = await postJson(`${started.url}/local/v1/session/markdown?${query}`, headers, {
        markdown: "must-not-append", insertAfterBlockId: "gone"
      });
      expect(stale.status).toBe(409);
      expect(stale.body).toEqual({ error: "stale_anchor" });
      expect(calls).toEqual([
        { notebookId: "analysis", sessionId: "lecture", markdown: "middle", insertAfterBlockId: "0001" },
        { notebookId: "analysis", sessionId: "lecture", markdown: "must-not-append", insertAfterBlockId: "gone" }
      ]);
    } finally {
      await server.stop();
    }
  });

  it("routes selection-edit propose/apply/cancel with a mock provider and temporary session", async () => {
    const fixture = await selectionEditFixture();
    const token = "s".repeat(48);
    const server = new LocalShellServer({ port: 0, token, sessionSelectionEdit: fixture.service });
    const started = await server.start();
    const query = "notebookId=analysis&sessionId=lecture";
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const blockPath = join(fixture.sessionDir, "blocks", "0001.md");
    try {
      const markdown = await readFile(blockPath, "utf8");
      const from = markdown.lastIndexOf("原句重复");
      const proposed = await fetch(`${started.url}/local/v1/session/selection-edit?${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          blockId: "0001", from, to: from + 4, selectedText: "原句重复", instruction: "改得更简洁"
        })
      });
      expect(proposed.status).toBe(200);
      const proposal = (await proposed.json()) as { id: string; status: string; replacementMarkdown: string };
      expect(proposal).toMatchObject({ status: "proposed", replacementMarkdown: "精简句" });
      expect(await readFile(blockPath, "utf8")).toBe(markdown);

      const applied = await fetch(`${started.url}/local/v1/session/selection-edit/apply?${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ proposalId: proposal.id })
      });
      expect(applied.status).toBe(200);
      await expect(applied.json()).resolves.toMatchObject({
        applied: true,
        proposal: { id: proposal.id, status: "applied" }
      });
      expect(await readFile(blockPath, "utf8")).toBe("原句重复；精简句");

      const secondMarkdown = await readFile(blockPath, "utf8");
      const secondFrom = secondMarkdown.lastIndexOf("精简句");
      const second = await fetch(`${started.url}/local/v1/session/selection-edit?${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          blockId: "0001", from: secondFrom, to: secondFrom + 3, selectedText: "精简句", instruction: "再改"
        })
      });
      expect(second.status).toBe(200);
      const secondProposal = (await second.json()) as { id: string };
      const cancelled = await fetch(`${started.url}/local/v1/session/selection-edit/cancel?${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ proposalId: secondProposal.id })
      });
      expect(cancelled.status).toBe(200);
      await expect(cancelled.json()).resolves.toMatchObject({ id: secondProposal.id, status: "cancelled" });
      expect(await readFile(blockPath, "utf8")).toBe(secondMarkdown);

      const reapplied = await fetch(`${started.url}/local/v1/session/selection-edit/apply?${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ proposalId: secondProposal.id })
      });
      expect(reapplied.status).toBe(409);
      await expect(reapplied.json()).resolves.toEqual({ error: "proposal_not_pending" });
      expect(await readFile(blockPath, "utf8")).toBe(secondMarkdown);
    } finally {
      await server.stop();
      await fixture.cleanup();
    }
  });

  it("rejects malformed selection-edit bodies and forwards service errors instead of 500", async () => {
    const fixture = await selectionEditFixture();
    const token = "t".repeat(48);
    const server = new LocalShellServer({ port: 0, token, sessionSelectionEdit: fixture.service });
    const started = await server.start();
    const query = "notebookId=analysis&sessionId=lecture";
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    try {
      const invalidRange = await fetch(`${started.url}/local/v1/session/selection-edit?${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ blockId: "0001", from: 2, to: 2, selectedText: "原", instruction: "改" })
      });
      expect(invalidRange.status).toBe(400);
      await expect(invalidRange.json()).resolves.toEqual({ error: "invalid_selection_edit_body" });

      const invalidProposalId = await fetch(`${started.url}/local/v1/session/selection-edit/apply?${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ proposalId: "not-a-proposal" })
      });
      expect(invalidProposalId.status).toBe(400);
      await expect(invalidProposalId.json()).resolves.toEqual({ error: "invalid_selection_edit_body" });

      const stale = await fetch(`${started.url}/local/v1/session/selection-edit?${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ blockId: "0001", from: 0, to: 2, selectedText: "不存在", instruction: "改" })
      });
      expect(stale.status).toBe(409);
      await expect(stale.json()).resolves.toEqual({ error: "selection_stale" });

      const missing = await fetch(`${started.url}/local/v1/session/selection-edit/apply?${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ proposalId: "selection_00000000-0000-0000-0000-000000000000" })
      });
      expect(missing.status).toBe(404);
      await expect(missing.json()).resolves.toEqual({ error: "proposal_not_found" });
    } finally {
      await server.stop();
      await fixture.cleanup();
    }
  });

  it("returns 503 when no selection-edit service is wired", async () => {
    const token = "n".repeat(48);
    const server = new LocalShellServer({ port: 0, token });
    const started = await server.start();
    const query = "notebookId=analysis&sessionId=lecture";
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    try {
      for (const path of [
        "/local/v1/session/selection-edit",
        "/local/v1/session/selection-edit/apply",
        "/local/v1/session/selection-edit/cancel"
      ]) {
        const response = await fetch(`${started.url}${path}?${query}`, {
          method: "POST",
          headers,
          body: JSON.stringify({})
        });
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({ error: "assistant_unavailable" });
      }
    } finally {
      await server.stop();
    }
  });
});

async function recognitionFixture(createProvider: () => Promise<RecognitionProvider>) {
  const root = await mkdtemp(join(tmpdir(), "mathnotes-local-recognition-"));
  const sessionDir = join(root, "notebooks", "analysis", "sessions", "lecture");
  await mkdir(join(sessionDir, "assets", "photos"), { recursive: true });
  await writeFile(join(sessionDir, "assets", "photos", "board.png"), Buffer.from([1, 2, 3]));
  const session: SessionRecord = {
    id: "lecture", title: "第三讲", status: "draft",
    createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z",
    currentDraftPolicy: "append_only", exportPolicy: { includeMetadataComments: true, includeImageLinks: true },
    locks: [],
    blocks: [{
      id: "0001", type: "image", path: "assets/photos/board.png", source: "user", status: "draft",
      readonly: false, editableByAi: false, renderInNote: true,
      createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z"
    }]
  };
  await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
  return {
    service: new SessionRecognitionService(root, createProvider),
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

async function assistantFixture() {
  const root = await mkdtemp(join(tmpdir(), "mathnotes-local-assistant-"));
  const sessionDir = join(root, "notebooks", "analysis", "sessions", "lecture");
  await mkdir(join(sessionDir, "blocks"), { recursive: true });
  await writeFile(join(sessionDir, "blocks", "0001.md"), "## 第一块\n\n定义与证明。\n");
  const session: SessionRecord = {
    id: "lecture", title: "第三讲", status: "draft",
    createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z",
    currentDraftPolicy: "append_only", exportPolicy: { includeMetadataComments: true, includeImageLinks: true },
    locks: [],
    blocks: [{
      id: "0001", type: "markdown", path: "blocks/0001.md", source: "user", status: "draft",
      readonly: false, editableByAi: false,
      createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z"
    }]
  };
  await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
  let contextCharacters = 0;
  const provider: AssistantProvider = {
    name: "assistant-fixture",
    async assist(input) {
      contextCharacters = Array.from(input.markdownContext).length;
      return { markdown: "## 独立学习批注\n" };
    }
  };
  return {
    service: new SessionAssistantService(root, async () => provider),
    contextCharacters: () => contextCharacters,
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

async function assistantTaskFixture(createProvider: () => Promise<AssistantProvider>) {
  const root = await mkdtemp(join(tmpdir(), "mathnotes-local-assistant-task-"));
  const sessionDir = join(root, "notebooks", "analysis", "sessions", "lecture");
  await mkdir(join(sessionDir, "blocks"), { recursive: true });
  await writeFile(join(sessionDir, "blocks", "0001.md"), "## 第一块\n\n定义与证明。\n");
  const session: SessionRecord = {
    id: "lecture", title: "第三讲", status: "draft",
    createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z",
    currentDraftPolicy: "append_only", exportPolicy: { includeMetadataComments: true, includeImageLinks: true },
    locks: [],
    blocks: [{
      id: "0001", type: "markdown", path: "blocks/0001.md", source: "user", status: "draft",
      readonly: false, editableByAi: false,
      createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z"
    }]
  };
  await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
  return {
    service: new SessionAssistantService(root, createProvider),
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

async function selectionEditFixture() {
  const root = await mkdtemp(join(tmpdir(), "mathnotes-local-selection-edit-"));
  const sessionDir = join(root, "notebooks", "analysis", "sessions", "lecture");
  await mkdir(join(sessionDir, "blocks"), { recursive: true });
  await writeFile(join(sessionDir, "blocks", "0001.md"), "原句重复；原句重复");
  const session: SessionRecord = {
    id: "lecture", title: "第三讲", status: "draft",
    createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z",
    currentDraftPolicy: "append_only", exportPolicy: { includeMetadataComments: true, includeImageLinks: true },
    locks: [],
    blocks: [{
      id: "0001", type: "markdown", path: "blocks/0001.md", source: "user", status: "draft",
      readonly: false, editableByAi: false,
      createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z"
    }]
  };
  await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
  const provider: AssistantProvider = {
    name: "selection-edit-fixture",
    async assist() {
      return { markdown: "```markdown\n精简句\n```" };
    }
  };
  return {
    service: new SessionSelectionEditService(root, async () => provider, new SessionEditService(root)),
    sessionDir,
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

function streamingAssistantProvider(): AssistantProvider {
  return {
    name: "assistant-stream",
    async assist() { throw new Error("event path expected"); },
    async assistWithEvents(input) {
      input.onEvent({ type: "started", message: "assistant started" });
      input.onEvent({ type: "stdout", text: "## 回答\n\n" });
      input.onEvent({ type: "stdout", text: "这里是完整回答。" });
      input.onEvent({ type: "completed", message: "assistant completed" });
      return { markdown: "## 回答\n\n这里是完整回答。" };
    }
  };
}

async function waitForHttpTerminal(baseUrl: string, token: string, query: string, taskId: string) {
  for (let index = 0; index < 600; index += 1) {
    const task = await requestRecognitionTask(baseUrl, token, query, taskId);
    if (["succeeded", "failed", "cancelled"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`task ${taskId} did not finish`);
}

async function waitForHttpStatus(baseUrl: string, token: string, query: string, taskId: string, status: string) {
  let lastTask: { status: string } | undefined;
  for (let index = 0; index < 600; index += 1) {
    const task = await requestRecognitionTask(baseUrl, token, query, taskId);
    lastTask = task;
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`task ${taskId} did not reach ${status}: ${JSON.stringify(lastTask)}`);
}

async function requestRecognitionTask(baseUrl: string, token: string, query: string, taskId: string) {
  const response = await fetch(`${baseUrl}/local/v1/session/recognition?${query}&taskId=${taskId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return ((await response.json()) as { task: { status: string; [key: string]: unknown } }).task;
}

async function waitForHttpAssistantTerminal(baseUrl: string, token: string, query: string, taskId: string) {
  for (let index = 0; index < 600; index += 1) {
    const task = await requestAssistantTask(baseUrl, token, query, taskId);
    if (["succeeded", "failed", "cancelled"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`assistant task ${taskId} did not finish`);
}

async function waitForHttpAssistantStatus(
  baseUrl: string,
  token: string,
  query: string,
  taskId: string,
  status: string
) {
  let lastTask: { status: string } | undefined;
  for (let index = 0; index < 600; index += 1) {
    const task = await requestAssistantTask(baseUrl, token, query, taskId);
    lastTask = task;
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`assistant task ${taskId} did not reach ${status}: ${JSON.stringify(lastTask)}`);
}

async function requestAssistantTask(baseUrl: string, token: string, query: string, taskId: string) {
  const response = await fetch(`${baseUrl}/local/v1/session/assistant/status?${query}&taskId=${taskId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return ((await response.json()) as { task: { status: string; [key: string]: unknown } }).task;
}

function requestStatus(baseUrl: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request(`${baseUrl}/local/v1/health`, {
      headers: { Authorization: `Bearer ${token}` }
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const outgoing = request(url, {
      method: "POST",
      headers: { ...headers, "Content-Length": String(bytes.byteLength) }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        try {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    outgoing.once("error", reject);
    outgoing.end(bytes);
  });
}
