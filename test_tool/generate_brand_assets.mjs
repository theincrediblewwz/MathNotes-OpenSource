import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "assets", "brand", "source");
const windowsAssets = path.join(projectRoot, "apps", "windows", "assets");
const androidMarketing = path.join(projectRoot, "apps", "android", "marketing");
const pwaIcons = path.join(projectRoot, "apps", "pwa", "public", "icons");
const previewRoot = path.join(projectRoot, "docs", "assets", "brand");

const windowsMaster = await readFile(path.join(sourceRoot, "windows-master.svg"), "utf8");
const windowsSmall = await readFile(path.join(sourceRoot, "windows-small.svg"), "utf8");
const androidForeground = await readFile(path.join(sourceRoot, "android-foreground.svg"), "utf8");
const androidMonochrome = await readFile(path.join(sourceRoot, "android-monochrome.svg"), "utf8");

await mkdir(windowsAssets, { recursive: true });
await mkdir(androidMarketing, { recursive: true });
await mkdir(pwaIcons, { recursive: true });
await mkdir(previewRoot, { recursive: true });

const browser = await chromium.launch({ headless: true });

async function renderSvg(svg, size, outputPath) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<!doctype html><style>
    html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}
    svg{display:block;width:100%;height:100%}
  </style>${svg}`);
  await page.screenshot({ path: outputPath, type: "png", omitBackground: true });
  await page.close();
}

const iconSizes = [16, 24, 32, 48, 64, 128, 256];
const iconEntries = [];
for (const size of iconSizes) {
  const outputPath = path.join(windowsAssets, `mathnotes-${size}.png`);
  await renderSvg(size <= 32 ? windowsSmall : windowsMaster, size, outputPath);
  iconEntries.push({ size, bytes: await readFile(outputPath) });
}
await writeFile(path.join(windowsAssets, "mathnotes.png"), iconEntries.at(-1).bytes);

function encodeIco(entries) {
  const headerSize = 6;
  const directorySize = entries.length * 16;
  let imageOffset = headerSize + directorySize;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const directories = [];
  for (const entry of entries) {
    const directory = Buffer.alloc(16);
    directory.writeUInt8(entry.size === 256 ? 0 : entry.size, 0);
    directory.writeUInt8(entry.size === 256 ? 0 : entry.size, 1);
    directory.writeUInt8(0, 2);
    directory.writeUInt8(0, 3);
    directory.writeUInt16LE(1, 4);
    directory.writeUInt16LE(32, 6);
    directory.writeUInt32LE(entry.bytes.length, 8);
    directory.writeUInt32LE(imageOffset, 12);
    imageOffset += entry.bytes.length;
    directories.push(directory);
  }
  return Buffer.concat([header, ...directories, ...entries.map((entry) => entry.bytes)]);
}

await writeFile(path.join(windowsAssets, "mathnotes.ico"), encodeIco(iconEntries));
const androidForegroundBody = androidForeground
  .replace(/^.*?<svg[^>]*>/s, "")
  .replace(/<\/svg>\s*$/s, "");
const androidStoreIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 432 432"><rect width="432" height="432" fill="#FBFAF7"/><g fill="none">${androidForegroundBody}</g></svg>`;
await renderSvg(androidStoreIcon, 512, path.join(androidMarketing, "play-icon-512.png"));
await renderSvg(androidStoreIcon, 192, path.join(pwaIcons, "mathnotes-192.png"));
await renderSvg(androidStoreIcon, 512, path.join(pwaIcons, "mathnotes-512.png"));

const previewPage = await browser.newPage({ viewport: { width: 1500, height: 860 } });
const png16 = (await readFile(path.join(windowsAssets, "mathnotes-16.png"))).toString("base64");
const png32 = (await readFile(path.join(windowsAssets, "mathnotes-32.png"))).toString("base64");
await previewPage.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box} body{margin:0;background:#f5f3ee;color:#24231f;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
  main{width:1500px;height:860px;padding:54px 64px} h1{font-size:30px;margin:0 0 8px} .sub{color:#716f68;margin-bottom:38px}
  .row{display:grid;grid-template-columns:190px repeat(5,1fr);gap:18px;align-items:center;margin:18px 0;padding:22px 0;border-top:1px solid #dcd9d1}
  .name strong{display:block;font-size:23px;margin-bottom:8px}.name span,.label{color:#747169;font-size:14px}
  .sample{height:230px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:13px}
  .art{width:172px;height:172px;display:flex;align-items:center;justify-content:center;overflow:hidden}.art svg{width:100%;height:100%}
  .checker{background-color:#fff;background-image:linear-gradient(45deg,#e9e7e1 25%,transparent 25%),linear-gradient(-45deg,#e9e7e1 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#e9e7e1 75%),linear-gradient(-45deg,transparent 75%,#e9e7e1 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0}
  .round{border-radius:50%;background:#fbfaf7;box-shadow:0 0 0 1px #e1ded7}.squircle{border-radius:27%;background:#fbfaf7;box-shadow:0 0 0 1px #e1ded7}
  .foreground{background:#fff;border:1px dashed #b9b5ac}.mono{background:#e9f5ef;border-radius:27%}.mono svg path{stroke:#24231f}
  .tiny{display:flex;align-items:end;gap:18px}.tiny figure{margin:0;text-align:center}.tiny img{display:block;margin:auto}.tiny .zoom{image-rendering:pixelated;width:128px;height:128px}.tiny .actual16{width:16px;height:16px;margin-top:8px}.tiny .actual32{width:32px;height:32px;margin-top:8px}
  footer{margin-top:28px;padding-top:20px;border-top:1px solid #dcd9d1;color:#747169;font-size:14px}
</style></head><body><main>
  <h1>MathNotes 图标生产预览</h1><div class="sub">最终方向：Windows 柔和折页 · Android 折角扫描环。外层形状由系统决定，不烘焙进图形。</div>
  <section class="row"><div class="name"><strong>Windows</strong><span>源码 / 渲染双页</span></div>
    <div class="sample"><div class="art checker">${windowsMaster}</div><div class="label">透明母版</div></div>
    <div class="sample"><div class="tiny"><figure><img class="zoom" src="data:image/png;base64,${png16}"><img class="actual16" src="data:image/png;base64,${png16}"></figure></div><div class="label">16px 专用轮廓</div></div>
    <div class="sample"><div class="tiny"><figure><img class="zoom" src="data:image/png;base64,${png32}"><img class="actual32" src="data:image/png;base64,${png32}"></figure></div><div class="label">32px 专用轮廓</div></div>
    <div class="sample"><div class="art">${windowsMaster}</div><div class="label">任务栏 / 安装包</div></div>
    <div class="sample"><div class="art">${windowsSmall}</div><div class="label">单色识别</div></div>
  </section>
  <section class="row"><div class="name"><strong>Android</strong><span>拍照 / 数学识别</span></div>
    <div class="sample"><div class="art foreground">${androidForeground}</div><div class="label">Adaptive 前景层</div></div>
    <div class="sample"><div class="art round">${androidForeground}</div><div class="label">圆形系统蒙版</div></div>
    <div class="sample"><div class="art squircle">${androidForeground}</div><div class="label">方圆系统蒙版</div></div>
    <div class="sample"><div class="art mono">${androidMonochrome}</div><div class="label">主题单色层</div></div>
    <div class="sample"><div class="art" style="width:72px;height:72px">${androidForeground}</div><div class="label">小尺寸轮廓</div></div>
  </section>
  <footer>Palette: paper #FBFAF7 · ink #24231F · mint #267A5A · pale mint #E9F5EF</footer>
</main></body></html>`);
await previewPage.screenshot({ path: path.join(previewRoot, "mathnotes-icon-system.png"), type: "png" });
await previewPage.close();
await browser.close();

console.log(`BRAND_ASSETS_GENERATED sizes=${iconSizes.join(",")} play=512 pwa=192,512 preview=${path.relative(projectRoot, path.join(previewRoot, "mathnotes-icon-system.png"))}`);
