import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "output", "headless-package");
const stageRoot = path.join(outputRoot, "stage");
const rootPackage = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));

const payload = [
  ["packages/core-server/dist/headless/networkNodeCli.cjs", "bin/mathnotes-network-node.cjs"],
  ["docs/deployment/headless/network-node-v2.example.json", "config/network-node-v2.example.json"],
  ["deploy/headless/README.md", "README.md"],
  ["deploy/headless/systemd/mathnotes-network-node.service.template", "service/systemd/mathnotes-network-node.service.template"],
  ["deploy/headless/launchd/com.mathnotes.network-node.plist.template", "service/launchd/com.mathnotes.network-node.plist.template"],
  ["deploy/headless/windows/MathNotesNetworkNode.xml.template", "service/windows/MathNotesNetworkNode.xml.template"],
  ["deploy/headless/windows/MathNotesHost.ps1.template", "service/windows/MathNotesHost.ps1.template"]
];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(stageRoot, { recursive: true });

for (const [sourceRelative, targetRelative] of payload) {
  const target = path.join(stageRoot, targetRelative);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(projectRoot, sourceRelative), target);
}

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
const manifest = {
  schemaVersion: 1,
  product: "MathNotes Headless Network Node",
  packageVersion: rootPackage.version,
  manifestScope: "payload files only; artifact-manifest.json is excluded",
  files
};
await writeFile(path.join(stageRoot, "artifact-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`HEADLESS_PACKAGE_STAGE=${stageRoot}`);
console.log(`HEADLESS_PACKAGE_FILES=${files.length}`);

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
