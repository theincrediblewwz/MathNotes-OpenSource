#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "output/macos-phase1d-fixture");
const notebookId = "functional_analysis";
const sessionId = "lecture_03";
const notebookDir = path.join(root, "notebooks", notebookId);
const sessionDir = path.join(notebookDir, "sessions", sessionId);
const blocksDir = path.join(sessionDir, "blocks");
const embeddedDir = path.join(sessionDir, "assets", "embedded");
const pdfDir = path.join(sessionDir, "assets", "pdfs");
await Promise.all([blocksDir, embeddedDir, pdfDir].map((directory) => mkdir(directory, { recursive: true })));

const now = "2026-07-23T11:00:00.000Z";
await writeFile(path.join(notebookDir, "notebook.json"), json({
  id: notebookId,
  title: "泛函分析",
  createdAt: now,
  updatedAt: now
}));

const blocks = [];
const mainMarkdown = [
  "## 半群与生成元",
  "",
  "设 $T(t)$ 是 Banach 空间 $X$ 上的强连续半群。若 $x \\in D(A)$，则",
  "",
  "$$",
  "\\lim_{t \\downarrow 0} \\frac{T(t)x-x}{t}=Ax.",
  "$$",
  "",
  "> [不确定：板书右侧的边界条件]",
  "",
  "![相图](../assets/embedded/phase-portrait.png)",
  "",
  "内积形式也可写为 $\\langle Ax,x\\rangle \\le 0$。",
  "",
  "<script>window.bad = true</script>"
].join("\n");
await writeFile(path.join(blocksDir, "0001_user.md"), mainMarkdown);
blocks.push(block("0001", "markdown", "blocks/0001_user.md", "user", now));

for (let index = 2; index <= 10; index += 1) {
  const id = String(index).padStart(4, "0");
  const blockPath = `blocks/${id}_note.md`;
  await writeFile(path.join(sessionDir, blockPath), [
    `### 推导片段 ${index - 1}`,
    "",
    `这是用于验证长 Session 惰性读取的第 ${index - 1} 段。`,
    "",
    `$$\\|T(t)x\\| \\le M e^{${index}t}\\|x\\|.$$`
  ].join("\n"));
  blocks.push(block(id, "markdown", blockPath, index % 2 ? "ai_transcription" : "user", now));
}

blocks.push({
  ...block("0011", "image", "assets/embedded/phase-portrait.png", "user", now),
  sourceName: "phase-portrait.png",
  renderInNote: true
});
blocks.push({
  ...block("0012", "pdf", "assets/pdfs/lecture-handout.pdf", "pdf_import", now),
  sourceName: "lecture-handout.pdf",
  pageCount: 1,
  renderInNote: true
});

await writeFile(path.join(sessionDir, "session.json"), json({
  id: sessionId,
  title: "泛函分析 第 3 讲",
  status: "draft",
  createdAt: now,
  updatedAt: now,
  blocks,
  locks: [],
  currentDraftPolicy: "append_only",
  exportPolicy: { includeMetadataComments: true, includeImageLinks: true }
}));

await writeFile(
  path.join(embeddedDir, "phase-portrait.png"),
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
);
await writeFile(path.join(pdfDir, "lecture-handout.pdf"), minimalPdf("MathNotes Phase 1D"));
console.log(`MACOS_PHASE1D_FIXTURE=${root}`);

function block(id, type, relativePath, source, timestamp) {
  return {
    id,
    type,
    path: relativePath,
    source,
    status: "draft",
    readonly: type !== "markdown",
    editableByAi: false,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function minimalPdf(label) {
  const content = `BT /F1 24 Tf 72 720 Td (${label}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}
