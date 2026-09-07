import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { windowsVendorChunkName } from "./src/buildChunking";

const sourceRevision = (() => {
  try { return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: __dirname, windowsHide: true, encoding: "utf8" }).trim(); }
  catch { return "source-archive"; }
})();

export default defineConfig({
  base: "./",
  define: { "import.meta.env.VITE_MATHNOTES_BUILD_REVISION": JSON.stringify(sourceRevision) },
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: "@mathnotes/core-server/domain/faithful-transcription-prompt",
        replacement: resolve(__dirname, "../../packages/core-server/src/domain/faithfulTranscriptionPrompt.ts")
      },
      {
        find: "@mathnotes/core-server/provider/open-ai-compatible",
        replacement: resolve(__dirname, "../../packages/core-server/src/provider/openAiCompatibleVisionProvider.ts")
      },
      {
        find: "@mathnotes/core-server/provider/image-data-url",
        replacement: resolve(__dirname, "../../packages/core-server/src/provider/imageDataUrl.ts")
      },
      { find: "@mathnotes/core-server", replacement: resolve(__dirname, "../../packages/core-server/src/index.ts") },
      { find: "@mathnotes/shared", replacement: resolve(__dirname, "../../packages/shared/src/index.ts") }
    ]
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: windowsVendorChunkName
      }
    }
  },
  test: {
    environment: "jsdom",
    globals: true,
    hookTimeout: 30_000,
    testTimeout: 30_000
  }
});
