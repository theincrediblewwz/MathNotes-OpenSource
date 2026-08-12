import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isTrustedRendererUrl } from "./electronSecurity";

describe("isTrustedRendererUrl", () => {
  const distRootDir = path.resolve("C:/MathNotes/resources/app.asar/dist");

  it("allows the configured development origin and packaged dist files", () => {
    expect(isTrustedRendererUrl({
      candidateUrl: "http://127.0.0.1:5173/session/lecture",
      devServerUrl: "http://127.0.0.1:5173",
      distRootDir
    })).toBe(true);
    expect(isTrustedRendererUrl({
      candidateUrl: pathToFileURL(path.join(distRootDir, "index.html")).toString(),
      devServerUrl: "http://127.0.0.1:5173",
      distRootDir
    })).toBe(true);
  });

  it("rejects sibling files, foreign origins and malformed URLs", () => {
    expect(isTrustedRendererUrl({
      candidateUrl: pathToFileURL(path.join(distRootDir, "../secrets.json")).toString(),
      distRootDir
    })).toBe(false);
    expect(isTrustedRendererUrl({
      candidateUrl: "https://example.com/",
      devServerUrl: "http://127.0.0.1:5173",
      distRootDir
    })).toBe(false);
    expect(isTrustedRendererUrl({ candidateUrl: "not a url", distRootDir })).toBe(false);
  });

  it("keeps the packaged entrypoint sandboxed with navigation and CSP guards", async () => {
    const mainSource = await readFile(path.resolve("electron/main.ts"), "utf8");
    const indexSource = await readFile(path.resolve("index.html"), "utf8");
    const appSource = await readFile(path.resolve("src/App.tsx"), "utf8");
    const assistantSource = await readFile(path.resolve("src/ui/components/AssistantWorkspace.tsx"), "utf8");
    const styleSource = await readFile(path.resolve("src/styles.css"), "utf8");

    expect(mainSource).toContain("sandbox: true");
    expect(mainSource).toContain("setWindowOpenHandler((details) => {");
    expect(mainSource).toContain('details.frameName === "mathnotes-assistant" && details.url === "about:blank"');
    expect(mainSource).not.toContain("mathnotes-recognition-hud");
    expect(mainSource).not.toContain("mathnotes-recognition-history");
    expect(mainSource.match(/frame: false/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(mainSource).toMatch(/frameName === "mathnotes-assistant"[\s\S]*?frame: false,[\s\S]*?resizable: true/);
    expect(assistantSource).toContain('className="assistant-workspace-header"');
    expect(styleSource).toMatch(/\.assistant-workspace-header\s*\{[\s\S]*?-webkit-app-region:\s*drag/);
    expect(appSource).toContain("TaskPopoverWithEvents");
    expect(appSource).not.toContain("DetachedRecognitionHud");
    expect(mainSource).toContain('return { action: "deny" };');
    expect(mainSource.match(/sandbox: true/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(mainSource).toContain('on("will-navigate"');
    expect(mainSource).toContain("assertTrustedRenderer(event)");
    expect(mainSource.match(/electronIpcMain\.handle/g)).toHaveLength(1);
    expect(mainSource).not.toContain('electronIpcMain.handle("mathnotes:');
    expect(indexSource).toContain("Content-Security-Policy");
    expect(indexSource).toContain("object-src 'none'");
    expect(indexSource).toContain("frame-src 'none'");
    expect(indexSource).not.toContain("'unsafe-eval'");
  });
});
