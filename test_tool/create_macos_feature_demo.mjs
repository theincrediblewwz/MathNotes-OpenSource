import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

// A separate, self-contained notebook. Never write into an existing library.
const root = path.resolve(process.argv[2] ?? "output/macos-feature-demo");
await mkdir(root, { recursive: true });
if ((await readdir(root)).length) throw new Error("Choose an empty directory for the demo notebook.");
const notebookId = "mac_feature_demo";
const sessionId = "original_image_and_math";
const notebook = path.join(root, "notebooks", notebookId);
const session = path.join(notebook, "sessions", sessionId);
await mkdir(path.join(session, "blocks"), { recursive: true });
await mkdir(path.join(session, "assets", "embedded"), { recursive: true });
const timestamp = new Date().toISOString();
await cp("apps/macos/Sources/MathNotesMac/Resources/wwz-sysu-avatar.jpg", path.join(session, "assets/embedded/original.jpg"));
await writeFile(path.join(session, "blocks/0001_demo.md"), [
  "## 点击标题，查看原图", "",
  "在左侧找到带图片来源的内容段，点击它的标题 **① 点我查看原图**。会弹出原图窗口，点击关闭即可回到笔记。", "",
  "如果当前只看到阅读区，先点右下角的 **编辑**，再点击左侧内容段标题。", "",
  "这段文字已关联示例原图，演示的是从识别文字回看拍摄素材的入口。示例原图使用 WWZ SYSU 的头像。", "",
  "### 说明与原图一起阅读", "",
  "[图片：身穿盔甲的人物，胸前有太阳图案。这是原图内嵌功能的演示素材。]", "",
  "[[mathnotes:source-image]]", "",
  "图片应出现在上面的说明与本段文字之间。实际识别时，软件会在 AI 标记的位置放入本次处理后的照片；仍保留 AI 对图形的文字说明。", "",
  "### 悬停预览也能显示公式", "",
  "打开 Notebooks → Mac 功能演示，把鼠标停在这份 Session 卡片上。小窗口应显示标题、表格和公式，而不是 Markdown 符号。", "",
  "$$\\int_0^1 x^2\\,dx=\\frac{1}{3}$$", "",
  "| 操作 | 结果 |", "| --- | --- |", "| 点击左侧 block 标题 | 查看关联的原图 |", "| 点击阅读 / 编辑 | 切换正文与源码 |", "| 点击展开按钮 | 显示导出等操作 |"
].join("\n"));
await writeFile(path.join(session, "blocks/0002_note.md"), "## 继续整理笔记\n\n这是普通文本块，没有关联原图。只有带素材来源的标题会打开原图。\n\n行内公式也会渲染：$a^2+b^2=c^2$。\n");
const block = (id, source, sourceName, extra = {}) => ({
  id, type: "markdown", path: `blocks/${id}_${id === "0001" ? "demo" : "note"}.md`,
  source, sourceName, status: "draft", readonly: false, editableByAi: false,
  createdAt: timestamp, updatedAt: timestamp, ...extra
});
await writeFile(path.join(notebook, "notebook.json"), JSON.stringify({
  id: notebookId, title: "Mac 功能演示", createdAt: timestamp, updatedAt: timestamp
}, null, 2));
await writeFile(path.join(session, "session.json"), JSON.stringify({
  id: sessionId, title: "原图与公式演示", status: "draft", createdAt: timestamp, updatedAt: timestamp,
  blocks: [
    block("0001", "ai_transcription", "① 点我查看原图", { fromAssets: ["assets/embedded/original.jpg"] }),
    block("0002", "user", "普通文本块")
  ], locks: [], currentDraftPolicy: "append_only", exportPolicy: { includeMetadataComments: true, includeImageLinks: true }
}, null, 2));

const fixedSession = path.join(notebook, "sessions", "fixed_blocks_and_ai");
await mkdir(path.join(fixedSession, "blocks"), { recursive: true });
const pieces = [
  "## 固定块与连续公式\n\n这份示例把公式中间的一小段变成固定块，但阅读时公式仍完整。\n\n$$a^2+",
  "b^2",
  "=c^2$$\n\n上面三个块的原文直接连接，保持顺序。编辑模式下，第二块已固定，前后两块可以继续修改。\n\n### AI 修改入口\n\n右键点击左侧块标题，选择“用 AI 修改该块内容”；或打开右下角 AI 对话，再选择“修改全文”。修改先显示提案，应用时保留固定块，并列出未执行的建议。此示例不会自动请求 AI。\n"
];
const fixedBlocks = [];
for (let index = 0; index < pieces.length; index++) {
  const id = String(index + 1).padStart(4, "0");
  const relativePath = `blocks/${id}.md`;
  await writeFile(path.join(fixedSession, relativePath), pieces[index]);
  fixedBlocks.push({ ...block(id, "user", ["公式前文", "固定选区 b²", "公式后文与操作说明"][index]),
    path: relativePath, status: index === 1 ? "locked" : "draft", continuationGroup: "demo-continuation" });
}
await writeFile(path.join(fixedSession, "session.json"), JSON.stringify({
  id: "fixed_blocks_and_ai", title: "固定块与 AI 修改入口", status: "draft", createdAt: timestamp, updatedAt: timestamp,
  blocks: fixedBlocks,
  locks: [{ id: "lock_block_0002", blockId: "0002", kind: "block", contentHash: createHash("sha256").update(pieces[1]).digest("hex"),
    createdAt: timestamp, createdBy: "user", aiEditable: false }],
  currentDraftPolicy: "append_only", exportPolicy: { includeMetadataComments: true, includeImageLinks: true }
}, null, 2));
await writeFile(path.join(root, "README.md"), "# Mac 功能演示\n\n这是独立示例库，不包含你的现有笔记或密钥。\n\n打开 Mac 功能演示 → 原图与公式演示，可以直接看到说明中的原图；在编辑模式点击左侧「① 点我查看原图」标题，还能单独查看素材。右下角从左到右是 AI 对话、阅读/编辑、展开。\n\n另一个 Session「固定块与 AI 修改入口」演示公式拆成三个块后保持完整渲染，其中只有中间块固定，并说明 AI 修改入口。示例不会请求 AI 或使用你的密钥。\n\n可以将 notebooks/mac_feature_demo 文件夹复制到现有笔记库的 notebooks 文件夹（同名文件夹已存在时请停止，勿覆盖）。也可以在独立验收 App 中直接查看。\n");
console.log(`MACOS_FEATURE_DEMO=${root}`);
