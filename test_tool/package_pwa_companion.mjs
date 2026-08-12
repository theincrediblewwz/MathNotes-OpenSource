import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "output", "pwa-companion");
const stageRoot = path.join(outputRoot, "stage");
const siteRoot = path.join(stageRoot, "site");
const rootPackage = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));

await rm(outputRoot, { recursive: true, force: true });
await mkdir(stageRoot, { recursive: true });
await cp(path.join(projectRoot, "apps", "pwa", "dist"), siteRoot, { recursive: true });
await copyFile(path.join(projectRoot, "deploy", "pwa", "README.md"), path.join(stageRoot, "README.md"));

const files = [];
for (const relativePath of await listFiles(stageRoot)) {
  const absolutePath = path.join(stageRoot, relativePath);
  const content = await readFile(absolutePath);
  const fileStat = await stat(absolutePath);
  files.push({
    path: relativePath.replaceAll(path.sep, "/"),
    bytes: fileStat.size,
    sha256: createHash("sha256").update(content).digest("hex")
  });
}
files.sort((left, right) => left.path.localeCompare(right.path, "en"));

await writeFile(path.join(stageRoot, "artifact-manifest.json"), `${JSON.stringify({
  schemaVersion: 1,
  product: "MathNotes PWA Read-only Companion",
  packageVersion: rootPackage.version,
  generatedFrom: "apps/pwa/dist",
  deploymentRoot: "site",
  manifestScope: "payload files only; artifact-manifest.json is excluded",
  files
}, null, 2)}\n`, "utf8");

console.log(`PWA_COMPANION_PACKAGE_STAGE=${stageRoot}`);
console.log(`PWA_COMPANION_PACKAGE_FILES=${files.length}`);

async function listFiles(root, current = "") {
  const entries = await readdir(path.join(root, current), { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const relativePath = path.join(current, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(root, relativePath));
    else if (entry.isFile()) result.push(relativePath);
  }
  return result;
}
