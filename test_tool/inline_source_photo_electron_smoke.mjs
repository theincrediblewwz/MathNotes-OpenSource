import { _electron as electron } from "playwright";
import { createCanvas } from "@napi-rs/canvas";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const fixture = await mkdtemp(path.join(tmpdir(), "mathnotes-inline-photo-"));
const output = process.env.MATHNOTES_QA_OUTPUT || path.join(fixture, "evidence");
const notes = path.join(fixture, "notes");
const notebookId = "graphs";
const sessionId = "processed-photo";
const sessionDir = path.join(notes, "notebooks", notebookId, "sessions", sessionId);
const now = new Date().toISOString();
await Promise.all([mkdir(output, { recursive: true }), mkdir(path.join(sessionDir, "assets/photos"), { recursive: true }), mkdir(path.join(sessionDir, "blocks"), { recursive: true })]);
const canvas = createCanvas(1000, 700);
const context = canvas.getContext("2d");
context.fillStyle = "#223e35";
context.fillRect(0, 0, 1000, 700);
context.strokeStyle = "#ffffff";
context.lineWidth = 7;
context.beginPath(); context.moveTo(110, 570); context.lineTo(600, 570); context.moveTo(150, 620); context.lineTo(150, 140); context.stroke();
context.beginPath(); context.moveTo(150, 540); context.quadraticCurveTo(380, 80, 560, 390); context.stroke();
context.fillStyle = "white";
context.font = "32px sans-serif";
context.fillText("Graph: y = f(x)", 100, 85);
context.fillText("PRIVATE ORIGINAL TEXT", 660, 200);
const original = canvas.toBuffer("image/png");
context.fillStyle = "#000";
context.fillRect(650, 0, 350, 700);
const processed = canvas.toBuffer("image/png");
assert.deepEqual([...context.getImageData(850, 200, 1, 1).data], [0, 0, 0, 255]);
const imagePath = "assets/photos/processed.png";
const markdown = "# 图形说明\n\n曲线先上升再下降，下图是本次识别实际收到的整张处理后照片。\n\n![识别照片](../assets/photos/processed.png)\n\n由图继续讨论函数的单调性，黑色遮盖部分不参与识别。\n";
await Promise.all([
  writeFile(path.join(sessionDir, imagePath), processed),
  writeFile(path.join(sessionDir, "assets/photos/original.png"), original),
  writeFile(path.join(sessionDir, "blocks/0002.md"), markdown),
  writeFile(path.join(notes, "notebooks", notebookId, "notebook.json"), JSON.stringify({ id: notebookId, title: "图形与推导", createdAt: now, updatedAt: now })),
  writeFile(path.join(sessionDir, "session.json"), JSON.stringify({ id: sessionId, title: "完整识别照片", status: "draft", createdAt: now, updatedAt: now, locks: [], blocks: [
    { id: "0001", type: "image", path: imagePath, source: "android_camera", status: "draft", readonly: true, editableByAi: false, createdAt: now, updatedAt: now },
    { id: "0002", type: "markdown", path: "blocks/0002.md", source: "ai_transcription", fromAssets: [imagePath], status: "draft", readonly: false, editableByAi: true, createdAt: now, updatedAt: now }
  ] }))
]);
const errors = [];
const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const app = await electron.launch({ executablePath, args: ["--no-stdio-init", ...(executablePath ? [] : [path.join(root, "apps/windows/electron-dist/main.cjs")]), `--user-data-dir=${path.join(fixture, "profile")}`], chromiumSandbox: false,
  cwd: root, env: { ...process.env, MATHNOTES_ROOT: notes, MATHNOTES_DEV_SERVER: "" } });
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector("[data-testid=session-source-editor] .cm-editor");
  await page.evaluate((target) => window.mathNotes.openSession(target), { notebookId, sessionId });
  await page.reload();
  const inline = page.getByTestId("preview-pane").getByAltText("识别照片");
  await inline.waitFor();
  await page.waitForFunction(() => document.querySelector("[data-testid=preview-pane] img")?.naturalWidth === 1000);
  assert.equal(await page.getByTestId("preview-pane").locator("img").count(), 1, "Hidden image block must not duplicate the inline photo");
  const imageBytes = await inline.evaluate(async (image) => Array.from(new Uint8Array(await (await fetch(image.src)).arrayBuffer())));
  assert.deepEqual(Buffer.from(imageBytes), processed, "Reader must use the full processed photo, including its black mask");
  await page.mouse.move(10, 800);
  await page.screenshot({ path: path.join(output, "inline-photo.png"), animations: "disabled" });
  await inline.click();
  const enlarged = page.getByTestId("asset-preview").getByRole("img");
  await enlarged.waitFor();
  assert.equal(await enlarged.getAttribute("src"), await inline.getAttribute("src"));
  await page.screenshot({ path: path.join(output, "enlarged-photo.png"), animations: "disabled" });
  await page.getByRole("button", { name: "关闭素材预览", exact: true }).click();
  const exported = await page.evaluate((target) => window.mathNotes.exportCurrentSession({ ...target, includeMetadataComments: false, packageMode: "share" }), { notebookId, sessionId });
  assert.deepEqual(exported.copiedAssets, [imagePath]);
  assert.deepEqual(await readFile(path.join(exported.packageDir, imagePath)), processed);
  assert.deepEqual(await readdir(path.join(exported.packageDir, "assets/photos")), ["processed.png"]);
  assert.match(await readFile(exported.outPath, "utf8"), /!\[识别照片\]\(assets\/photos\/processed.png\)/);
  const receiver = await page.evaluate(() => window.mathNotes.loadIngestServerState());
  const origin = `http://127.0.0.1:${receiver.port}`;
  const query = new URLSearchParams({ notebookId, sessionId });
  const headers = { authorization: `Bearer ${receiver.token}` };
  const manifestResponse = await fetch(`${origin}/api/v2/companion/session/manifest?${query}`, { headers });
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.deepEqual(manifest.assets.map((asset) => asset.path), [imagePath]);
  const htmlResponse = await fetch(`${origin}/api/v2/companion/session/document?${query}&format=html`, { headers });
  assert.equal(htmlResponse.status, 200);
  const html = await htmlResponse.text();
  assert.match(html, /mathnotes-companion-asset:\/\//);
  assert.equal((html.match(/<img /g) ?? []).length, 1);
  const assetResponse = await fetch(`${origin}/api/v1/companion/asset?${query}&path=${encodeURIComponent(imagePath)}`, { headers });
  assert.equal(assetResponse.status, 200);
  assert.deepEqual(Buffer.from(await assetResponse.arrayBuffer()), processed);
  await writeFile(path.join(output, "companion-host.html"), html);
  // Existing embedded photos may have Unicode filenames or spaces; Markdown-it
  // escapes these URLs, which must still resolve and open the exact same bytes.
  const unicodeImagePath = "assets/photos/处理后 照片.png";
  await writeFile(path.join(sessionDir, unicodeImagePath), processed);
  await writeFile(path.join(sessionDir, "blocks/0002.md"), markdown.replace("../assets/photos/processed.png", `<../${unicodeImagePath}>`));
  await page.evaluate((target) => window.mathNotes.openSession(target), { notebookId, sessionId });
  await page.reload();
  await page.waitForFunction(() => document.querySelector("[data-testid=preview-pane] img")?.naturalWidth === 1000);
  const unicodeBytes = await inline.evaluate(async (image) => Array.from(new Uint8Array(await (await fetch(image.src)).arrayBuffer())));
  assert.deepEqual(Buffer.from(unicodeBytes), processed);
  await inline.click();
  await enlarged.waitFor();
  assert.equal(await enlarged.getAttribute("src"), await inline.getAttribute("src"));
  await page.getByRole("button", { name: "关闭素材预览", exact: true }).click();
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, "result.json"), JSON.stringify({ ok: true, fixture, dimensions: [1000, 700], blackMaskPixel: [0, 0, 0, 255], originalImageBlockHidden: true,
    fromAssets: [imagePath], inlineImageCount: 1, clickEnlargesSameImage: true, processedSha256: createHash("sha256").update(processed).digest("hex"),
    exportContainsOnlyProcessedPhoto: true, companionContainsOnlyProcessedPhoto: true, unicodeAndSpaceFilenamePreview: true, errors }, null, 2));
  console.log(`INLINE_SOURCE_PHOTO_OK ${output}`);
} finally { await app.close(); }
