#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const outputDir = path.join(root, "output", "macos-sidecar");
const outputPath = path.join(outputDir, "core-server.mjs");
await mkdir(outputDir, { recursive: true });
await build({
  entryPoints: [path.join(root, "packages", "core-server", "src", "sidecar", "main.ts")],
  alias: {
    "@mathnotes/shared": path.join(root, "packages", "shared", "src", "index.ts")
  },
  outfile: outputPath,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: "import { createRequire as __mathNotesCreateRequire } from \"node:module\"; const require = __mathNotesCreateRequire(import.meta.url);"
  },
  sourcemap: true
});
console.log(`MACOS_SIDECAR_BUNDLE=${outputPath}`);
