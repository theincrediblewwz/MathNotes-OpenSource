#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const rootPackage = JSON.parse(await readFile("package.json", "utf8"));
const configuration = await readFile(
  "apps/macos/Sources/MathNotesMac/SidecarConfiguration.swift",
  "utf8"
);
const packager = await readFile("test_tool/package_macos_native.mjs", "utf8");

assert.equal(
  rootPackage.scripts["package:macos:native"],
  "node test_tool/package_macos_native.mjs"
);
assert.match(configuration, /Bundle\.main\.resourceURL/);
assert.match(configuration, /MathNotesRuntime/);
assert.match(configuration, /MathNotesPWA/);
assert.match(configuration, /MATHNOTES_PWA_STATIC_ROOT_DIR/);
assert.match(configuration, /MATHNOTES_NODE_EXECUTABLE/);
assert.match(packager, /MACOS_HOST_REQUIRED/);
assert.match(packager, /core-server\.mjs/);
assert.match(packager, /run\("npm", \["run", "build:pwa"\]\)/);
assert.match(packager, /apps", "pwa", "dist/);
assert.match(packager, /MathNotesPWA/);
assert.match(packager, /await cp\(sourcePwa, pwaPath, \{ recursive: true \}\)/);
assert.match(packager, /MathNotesKaTeX/);
assert.match(packager, /katex\.min\.css/);
assert.match(packager, /process\.execPath/);
assert.match(packager, /run\("strip", \["-x", targetExecutable\]\)/);
assert.match(packager, /run\("strip", \["-x", targetNode\]\)/);
assert.match(packager, /run\(targetNode, \["--version"\]\)/);
assert.match(packager, /MACOS_NATIVE_NODE_BYTES_AFTER_STRIP/);
assert.match(packager, /Info\.plist/);
assert.match(packager, /codesign/);
assert.match(packager, /ditto/);

console.log("MACOS_NATIVE_PACKAGE_CONTRACT_OK");
