import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const head = run("git", ["rev-parse", "HEAD"]).trim();
if (run("git", ["status", "--porcelain"]).trim()) throw new Error("Packaging requires a clean worktree");
const short = head.slice(0, 8);
const outputRoot = path.join(root, "output", "test-packages", `mobile-standalone-${short}`);
const ready = path.join(outputRoot, "ready");
const pwaStage = path.join(outputRoot, "pwa-site");
await rm(outputRoot, { recursive: true, force: true });
await mkdir(ready, { recursive: true });
await cp(path.join(root, "apps", "pwa", "dist"), pwaStage, { recursive: true });

const apkName = `MathNotes-Android-${pkg.version}-${short}-development-signed.apk`;
const pwaName = `MathNotes-PWA-Standalone-${pkg.version}-${short}.zip`;
const workerName = `MathNotes-PWA-Worker-${pkg.version}-${short}`;
const bundleName = `MathNotes-Mobile-Standalone-${pkg.version}-${short}.zip`;
await copyFile(path.join(root, "apps", "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk"), path.join(ready, apkName));
archive(path.join(ready, pwaName), pwaStage, ".");

const workerDir = path.join(ready, workerName);
await mkdir(workerDir, { recursive: true });
await cp(path.join(root, "apps", "worker", "src"), path.join(workerDir, "src"), { recursive: true });
await cp(pwaStage, path.join(workerDir, "pwa-site"), { recursive: true });
await copyFile(path.join(root, "apps", "worker", "package.json"), path.join(workerDir, "package.json"));
await copyFile(path.join(root, "apps", "worker", "README.md"), path.join(workerDir, "README.md"));
const workerConfig = (await readFile(path.join(root, "apps", "worker", "wrangler.jsonc"), "utf8"))
  .replace('"directory": "../pwa/dist"', '"directory": "./pwa-site"');
await writeFile(path.join(workerDir, "wrangler.jsonc"), workerConfig, "utf8");
await copyFile(
  path.join(root, "docs", "deployment", "standalone-gateway-contract-v1.md"),
  path.join(workerDir, "网关接口合同.md")
);

const gatewayDir = path.join(ready, "gateway-local-fake");
await mkdir(gatewayDir, { recursive: true });
await copyFile(path.join(root, "test_tool", "standalone_gateway_fake.mjs"), path.join(gatewayDir, "standalone_gateway_fake.mjs"));
await copyFile(path.join(root, "docs", "deployment", "standalone-gateway-contract-v1.md"), path.join(gatewayDir, "接口与启动说明.md"));
await copyFile(path.join(root, "docs", "deployment", "standalone-pwa-hosting-v1.md"), path.join(ready, "PWA托管说明.md"));
await writeFile(path.join(ready, "首次使用.md"), `# MathNotes 手机独立版 ${pkg.version}\n\n` +
  `构建提交：${head}\n\n` +
  `- Android：安装 \`${apkName}\`。这是开发签名验收包，可直接安装；不是应用商店正式签名。\n` +
  `- PWA（只读/本地假识别）：把 \`${pwaName}\` 解压后部署到固定 HTTPS 站点根目录。无需电脑或 Tailscale 即可打开手机独立工作区。\n` +
  `- PWA（真实识别候选）：\`${workerName}\` 是同域 Worker + PWA 工程。它把 Provider key 留在 Worker secret，正式部署仍需账号、域名、秘密和费用关卡。\n` +
  `- Gateway：\`gateway-local-fake\` 只做零费用本地接口验证，不能公开部署。\n` +
  `- Android 可配置 OpenAI-compatible HTTPS Endpoint、模型和 API Key；Key 由 Android Keystore 加密。每次真实识别必须由用户确认，自动测试没有发出真实 Provider 请求。\n`, "utf8");

const files = await listFiles(ready);
const manifestFiles = [];
for (const relative of files) {
  const absolute = path.join(ready, relative);
  const content = await readFile(absolute);
  manifestFiles.push({ path: relative.replaceAll(path.sep, "/"), bytes: content.length, sha256: digest(content) });
}
const pwaUnpackedBytes = await directoryBytes(pwaStage);
const apkBytes = (await stat(path.join(ready, apkName))).size;
await writeFile(path.join(ready, "artifact-manifest.json"), JSON.stringify({
  schemaVersion: 1, product: "MathNotes Mobile Standalone", version: pkg.version,
  commit: head, dirty: false, signing: { android: "development-debug-key", publicReleaseReady: false },
  footprint: { androidApkBytes: apkBytes, pwaUnpackedBytes },
  hosting: { staticPwaIncluded: true, sameOriginWorkerIncluded: true, productionDeployed: false },
  files: manifestFiles
}, null, 2) + "\n", "utf8");
const checksumFiles = await listFiles(ready);
const checksumLines = [];
for (const relative of checksumFiles) checksumLines.push(`${digest(await readFile(path.join(ready, relative)))}  ${relative.replaceAll(path.sep, "/")}`);
await writeFile(path.join(ready, "SHA256SUMS.txt"), checksumLines.join("\n") + "\n", "utf8");
const bundlePath = path.join(outputRoot, bundleName);
archive(bundlePath, ready, ".");
await writeFile(`${bundlePath}.sha256`, `${digest(await readFile(bundlePath))}  ${bundleName}\n`, "utf8");
console.log(`MOBILE_STANDALONE_READY=${ready}`);
console.log(`MOBILE_STANDALONE_BUNDLE=${bundlePath}`);
console.log(`MOBILE_STANDALONE_SHA256=${digest(await readFile(bundlePath))}`);
console.log(`MOBILE_STANDALONE_ANDROID_APK_BYTES=${apkBytes}`);
console.log(`MOBILE_STANDALONE_PWA_UNPACKED_BYTES=${pwaUnpackedBytes}`);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}
function archive(target, cwd, entry) {
  const result = spawnSync("tar.exe", ["-a", "-c", "-f", target, "-C", cwd, entry], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}
function digest(content) { return createHash("sha256").update(content).digest("hex"); }
async function listFiles(dir, current = "") {
  const result = [];
  for (const entry of (await readdir(path.join(dir, current), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const relative = path.join(current, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(dir, relative)); else if (entry.isFile()) result.push(relative);
  }
  return result;
}
async function directoryBytes(dir) {
  let total = 0;
  for (const relative of await listFiles(dir)) total += (await stat(path.join(dir, relative))).size;
  return total;
}
