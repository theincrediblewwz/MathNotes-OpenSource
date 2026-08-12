import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const androidKatex = path.join(root, "apps", "android", "app", "src", "main", "assets", "katex");
const androidCss = await readFile(path.join(androidKatex, "katex.min.css"), "utf8");
const androidFonts = (await readdir(path.join(androidKatex, "fonts"))).filter((name) => name.endsWith(".woff2"));
const pwaSource = await readFile(path.join(root, "apps", "pwa", "src", "katexReaderStyle.ts"), "utf8");
const androidReader = await readFile(path.join(root, "apps", "android", "app", "src", "main", "java", "com", "mathnotes", "capture", "companion", "CompanionNotesScreen.kt"), "utf8");

assert.equal(androidFonts.length, 20, "Android must package all 20 KaTeX woff2 fonts");
for (const font of ["KaTeX_Main-Regular.woff2", "KaTeX_Size1-Regular.woff2", "KaTeX_Size2-Regular.woff2", "KaTeX_Size3-Regular.woff2", "KaTeX_Size4-Regular.woff2"]) {
  assert(androidFonts.includes(font), `Android is missing ${font}`);
}
assert(androidCss.includes('content:"0.17.0"'), "Android KaTeX CSS version drifted");
assert(!/url\(["']?https?:/i.test(androidCss), "Android KaTeX CSS must not fetch network fonts");
assert.equal((pwaSource.match(/\.woff2\?inline/g) ?? []).length, 20, "PWA must embed all 20 KaTeX fonts");
assert(androidReader.includes("COMPANION_READER_BASE_URL"), "Android reader must use the local HTTPS asset origin");
assert(androidReader.includes("katex/katex.min.css"), "Android reader must load bundled KaTeX CSS");

console.log("mobile KaTeX assets contract passed");
