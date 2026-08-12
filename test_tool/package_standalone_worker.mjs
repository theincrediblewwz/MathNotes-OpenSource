import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const head = run("git", ["rev-parse", "HEAD"]).trim();
const dirty = Boolean(run("git", ["status", "--porcelain", "--untracked-files=no"]).trim());
const short = head.slice(0, 8);
const outputRoot = path.join(root, "output", "test-packages", `standalone-worker-${short}`);
const ready = path.join(outputRoot, "ready");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(ready, { recursive: true });

// PWA static site (built by the caller: npm run build:pwa).
await cp(path.join(root, "apps", "pwa", "dist"), path.join(ready, "pwa-site"), { recursive: true });
// Worker source, config, metadata and instructions.
await cp(path.join(root, "apps", "worker", "src"), path.join(ready, "src"), { recursive: true });
await copyFile(path.join(root, "apps", "worker", "wrangler.jsonc"), path.join(ready, "wrangler.jsonc"));
await copyFile(path.join(root, "apps", "worker", "package.json"), path.join(ready, "package.json"));
await copyFile(path.join(root, "apps", "worker", "README.md"), path.join(ready, "README.md"));
await copyFile(
  path.join(root, "docs", "deployment", "standalone-gateway-contract-v1.md"),
  path.join(ready, "网关接口合同.md")
);

// The staged config is self-contained: assets live next to the worker.
const stagedConfigPath = path.join(ready, "wrangler.jsonc");
const stagedConfig = (await readFile(stagedConfigPath, "utf8"))
  .replace('"directory": "../pwa/dist"', '"directory": "./pwa-site"');
await writeFile(stagedConfigPath, stagedConfig, "utf8");

await writeFile(path.join(ready, "部署说明.md"), deploymentInstructions(head, short, dirty), "utf8");

const files = await listFiles(ready);
const manifestFiles = [];
for (const relative of files) {
  const absolute = path.join(ready, relative);
  const content = await readFile(absolute);
  manifestFiles.push({ path: relative.replaceAll(path.sep, "/"), bytes: content.length, sha256: digest(content) });
}
const pwaFiles = manifestFiles.filter((entry) => entry.path.startsWith("pwa-site/")).length;
const pwaBytes = await directoryBytes(path.join(ready, "pwa-site"));
await writeFile(path.join(ready, "artifact-manifest.json"), JSON.stringify({
  schemaVersion: 1,
  product: "MathNotes Standalone Worker",
  version: pkg.version,
  commit: head,
  dirty,
  footprint: { pwaUnpackedBytes: pwaBytes, pwaFiles },
  files: manifestFiles
}, null, 2) + "\n", "utf8");

const checksumFiles = await listFiles(ready);
const checksumLines = [];
for (const relative of checksumFiles) {
  checksumLines.push(`${digest(await readFile(path.join(ready, relative)))}  ${relative.replaceAll(path.sep, "/")}`);
}
await writeFile(path.join(ready, "SHA256SUMS.txt"), checksumLines.join("\n") + "\n", "utf8");

const bundleName = `MathNotes-Standalone-Worker-${pkg.version}-${short}.zip`;
const bundlePath = path.join(outputRoot, bundleName);
archive(bundlePath, ready, ".");
await writeFile(`${bundlePath}.sha256`, `${digest(await readFile(bundlePath))}  ${bundleName}\n`, "utf8");

console.log(`STANDALONE_WORKER_READY=${ready}`);
console.log(`STANDALONE_WORKER_BUNDLE=${bundlePath}`);
console.log(`STANDALONE_WORKER_SHA256=${digest(await readFile(bundlePath))}`);
console.log(`STANDALONE_WORKER_PWA_BYTES=${pwaBytes}`);
console.log(`STANDALONE_WORKER_DIRTY=${dirty}`);

function deploymentInstructions(head, short, dirty) {
  return `# MathNotes Standalone Worker 部署说明（不自动部署）

本目录是可直接交给 Wrangler 的独立 Worker 工程，包含：

- \`src/index.js\`：网关 + 静态资产回退 Worker；
- \`wrangler.jsonc\`：\`ASSETS\` 绑定指向 \`./pwa-site\`，Worker 全量先执行；
- \`pwa-site/\`：\`apps/pwa/dist\` 构建产物（本包已包含）；
- \`README.md\` 与 \`网关接口合同.md\`：接口与安全边界；
- \`artifact-manifest.json\` / \`SHA256SUMS.txt\`：逐文件哈希与构建元数据。

构建提交：\`${head}\`（${short}）
工作树状态：${dirty ? "dirty（提交前冒烟包；正式发布请在干净提交重新打包）" : "clean"}

## 本地验证

\`\`\`powershell
npm run test:standalone-worker
npm run test:standalone-worker-package
\`\`\`

## 部署（人工关卡，本包不执行）

1. 在干净提交上重新执行 \`npm run package:standalone-worker\` 并核对 manifest；
2. 选定正式域名与 Cloudflare 账号、费用与回滚策略；
3. 补持久幂等/去重策略；当前只校验请求键，网络重试仍可能重复调用 Provider；
4. 在本目录安装或调用 Wrangler \`>= 4.36\`（启用限流绑定时）；
5. 先以缺少秘密时 fail-closed 的状态创建 Worker，再写入秘密：\`npx wrangler secret put MATHNOTES_GATEWAY_TOKEN\`、
   \`npx wrangler secret put MATHNOTES_PROVIDER_API_KEY\`；
6. 配置普通变量：\`MATHNOTES_PROVIDER_BASE_URL\`、\`MATHNOTES_PROVIDER_MODEL\`；
7. 可选：取消 \`wrangler.jsonc\` 中 \`ratelimits\` 注释，并把
   \`namespace_id\` 换成账号内唯一的整数；
8. \`npx wrangler deploy\` 最终版本。

真实 Provider 调用、正式域名和任何收费资源仍需单独窄范围批准。
`;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

function archive(target, cwd, entry) {
  const result = spawnSync("tar.exe", ["-a", "-c", "-f", target, "-C", cwd, entry], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function listFiles(dir, current = "") {
  const result = [];
  for (const entry of (await readdir(path.join(dir, current), { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const relative = path.join(current, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(dir, relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}

async function directoryBytes(dir) {
  let total = 0;
  for (const relative of await listFiles(dir)) total += (await stat(path.join(dir, relative))).size;
  return total;
}
