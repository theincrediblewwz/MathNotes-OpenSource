import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stageRoot = path.join(projectRoot, "output", "headless-package", "stage");
const manifestPath = path.join(stageRoot, "artifact-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

assert(manifest.schemaVersion === 1, "unexpected manifest schema");
assert(manifest.product === "MathNotes Headless Network Node", "unexpected product name");
assert(typeof manifest.packageVersion === "string" && manifest.packageVersion.length > 0, "missing package version");

const expected = [
  "README.md",
  "bin/mathnotes-network-node.cjs",
  "config/network-node-v2.example.json",
  "service/launchd/com.mathnotes.network-node.plist.template",
  "service/systemd/mathnotes-network-node.service.template",
  "service/windows/MathNotesNetworkNode.xml.template",
  "service/windows/MathNotesHost.ps1.template"
].sort((left, right) => left.localeCompare(right, "en"));
const manifestPaths = manifest.files.map((entry) => entry.path);
assert(JSON.stringify(manifestPaths) === JSON.stringify([...manifestPaths].sort((a, b) => a.localeCompare(b, "en"))), "manifest is not sorted");
assert(JSON.stringify(manifestPaths) === JSON.stringify(expected), "manifest payload differs from the deployment contract");

for (const entry of manifest.files) {
  assert(!path.isAbsolute(entry.path), `manifest contains an absolute path: ${entry.path}`);
  const absolutePath = path.join(stageRoot, entry.path);
  const content = await readFile(absolutePath);
  const fileStat = await stat(absolutePath);
  assert(fileStat.size === entry.bytes, `size mismatch for ${entry.path}`);
  assert(createHash("sha256").update(content).digest("hex") === entry.sha256, `hash mismatch for ${entry.path}`);
}

const actualFiles = (await listFiles(stageRoot))
  .map((entry) => entry.replaceAll(path.sep, "/"))
  .filter((entry) => entry !== "artifact-manifest.json");
assert(JSON.stringify(actualFiles) === JSON.stringify(expected), "stage contains untracked payload files");

const textPayload = (await Promise.all(expected.map(async (relativePath) =>
  `${relativePath}\n${await readFile(path.join(stageRoot, relativePath), "utf8")}`
))).join("\n");
const normalizedRoot = projectRoot.replaceAll("\\", "/").toLowerCase();
assert(!textPayload.replaceAll("\\", "/").toLowerCase().includes(normalizedRoot), "package leaks the build root");
assert(!/E:[\\/]opensourceproject/i.test(textPayload), "package leaks a development drive path");
assert(!/MATHNOTES_HEADLESS_TOKEN\s*[:=]\s*["'][^"']{8,}["']/i.test(textPayload), "package embeds a token value");

const config = JSON.parse(await readFile(path.join(stageRoot, "config/network-node-v2.example.json"), "utf8"));
assert(config.legacyTokenEnv === "MATHNOTES_HEADLESS_TOKEN", "config must contain only the token environment variable name");
assert(config.advertisedUrlEnv === "MATHNOTES_HEADLESS_URL", "config must contain only the URL environment variable name");

const systemd = await readFile(path.join(stageRoot, "service/systemd/mathnotes-network-node.service.template"), "utf8");
assert(systemd.includes("Restart=on-failure") && systemd.includes("StandardOutput=journal"), "systemd recovery or logging contract missing");
assert(systemd.includes("@@NODE_EXECUTABLE@@") && systemd.includes("@@CONFIG_PATH@@"), "systemd placeholders missing");

const launchd = await readFile(path.join(stageRoot, "service/launchd/com.mathnotes.network-node.plist.template"), "utf8");
assert(launchd.includes("<key>ProgramArguments</key>") && launchd.includes("<key>KeepAlive</key>"), "launchd runtime contract missing");
assert(launchd.includes("@@LOG_DIR@@") && launchd.includes("@@CONFIG_PATH@@"), "launchd placeholders missing");

const winsw = await readFile(path.join(stageRoot, "service/windows/MathNotesNetworkNode.xml.template"), "utf8");
assert(winsw.includes("<onfailure action=\"restart\"") && winsw.includes("<log mode=\"roll-by-size\">"), "WinSW recovery or rolling log contract missing");
assert(winsw.includes("@@NODE_EXECUTABLE@@") && winsw.includes("@@CONFIG_PATH@@"), "WinSW placeholders missing");

const windowsControl = await readFile(path.join(stageRoot, "service/windows/MathNotesHost.ps1.template"), "utf8");
assert(windowsControl.includes('"pair"') && windowsControl.includes("/api/v2/pairing/challenge"), "Windows pairing action missing");
assert(windowsControl.includes("@@MATHNOTES_ROOT@@") && windowsControl.includes("@@SECRET_PATH@@"), "Windows control placeholders missing");

console.log(`HEADLESS_PACKAGE_SMOKE_OK files=${manifest.files.length} version=${manifest.packageVersion}`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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
