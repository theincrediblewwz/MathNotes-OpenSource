import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPublicMaterial } from "./public_material_policy.mjs";

export async function verifyPwaUpdate(root) {
  const actual = (await listFiles(root)).sort();
  const manifest = JSON.parse(await readFile(path.join(root, "artifact-manifest.json"), "utf8"));
  if (manifest.product !== "MathNotes PWA Update" || manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error("Unsupported PWA update manifest");
  const listed = new Set();
  for (const file of manifest.files) {
    if (!safeRelativePath(file.path) || listed.has(file.path)) throw new Error(`Unsafe or duplicate manifest path: ${file.path}`);
    listed.add(file.path);
    const actual = path.join(root, ...file.path.split("/"));
    if (!(await lstat(actual)).isFile()) throw new Error(`Not a regular file: ${file.path}`);
    const bytes = await readFile(actual);
    assertPublicMaterial(file.path, bytes);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`Hash mismatch: ${file.path}`);
  }
  const expected = [...listed, "artifact-manifest.json", "SHA256SUMS"].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("Package contains missing or unexpected files");
  const checksumLines = await Promise.all([...listed, "artifact-manifest.json"].sort().map(async name => `${sha256(await readFile(path.join(root, name)))}  ${name}`));
  if ((await readFile(path.join(root, "SHA256SUMS"), "utf8")).trim() !== checksumLines.join("\n")) throw new Error("SHA256SUMS mismatch");
  return { version: manifest.packageVersion, sourceCommit: manifest.sourceCommit, files: listed.size };
}

export function safeRelativePath(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes(":") && !/[\x00-\x1f\x7f]/.test(value) && value.split("/").every(part => part && part !== "." && part !== "..");
}
export function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
export async function listFiles(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not accepted: ${relative}`);
    if (entry.isDirectory()) result.push(...await listFiles(root, relative));
    else if (entry.isFile()) result.push(relative);
    else throw new Error(`Unexpected file type: ${relative}`);
  }
  return result.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? path.dirname(fileURLToPath(import.meta.url)));
  console.log(`PWA_UPDATE_VERIFIED ${JSON.stringify(await verifyPwaUpdate(root))}`);
}
