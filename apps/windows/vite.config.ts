import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { windowsVendorChunkName } from "./src/buildChunking";

export default defineConfig({
  base: "./",
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
    globals: true
  }
});
