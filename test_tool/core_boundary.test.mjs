import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { extractImports, scanCoreBoundaries } from "./core_boundary_lib.mjs";

test("extractImports recognizes static, dynamic and require imports", () => {
  assert.deepEqual(
    extractImports(`
      import type { A } from "@mathnotes/shared";
      export { B } from './b';
      const c = await import("node:path");
      const d = require('electron');
    `),
    ["./b", "@mathnotes/shared", "electron", "node:path"]
  );
});

test("scanCoreBoundaries rejects Electron imports but reports Node capabilities", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mathnotes-core-boundary-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "portable.ts"), 'import path from "node:path";\nexport { path };\n');
    await writeFile(path.join(root, "src", "coupled.ts"), 'import { BrowserWindow } from "electron";\nexport { BrowserWindow };\n');
    const report = await scanCoreBoundaries({ projectRoot: root, roots: ["src"] });
    assert.equal(report.fileCount, 2);
    assert.equal(report.nodeImportCount, 1);
    assert.deepEqual(report.violations, [
      { file: "src/coupled.ts", kind: "electron-import", detail: "electron" },
      { file: "src/coupled.ts", kind: "electron-global", detail: "BrowserWindow" }
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("test files and fixtures do not define the production boundary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mathnotes-core-boundary-"));
  try {
    await mkdir(path.join(root, "src", "testHelpers"), { recursive: true });
    await writeFile(path.join(root, "src", "domain.ts"), "export const value = 1;\n");
    await writeFile(path.join(root, "src", "domain.test.ts"), 'import "electron";\n');
    await writeFile(path.join(root, "src", "testHelpers", "fake.ts"), 'import "electron";\n');
    const report = await scanCoreBoundaries({ projectRoot: root, roots: ["src"] });
    assert.equal(report.fileCount, 1);
    assert.deepEqual(report.violations, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
