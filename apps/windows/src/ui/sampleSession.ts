import type { EditableMarkdownBlock, RenderBlock, SourceLine } from "../common/sessionDocument";
import type { SessionSourceDocument } from "../common/sessionSourceDocument";

export type { EditableMarkdownBlock, RenderBlock, SourceLine };

export const sourceLines: SourceLine[] = [
  { line: 1, kind: "dim", text: "---" },
  { line: 2, id: "src-pdf", kind: "key", text: "source: pdf" },
  { line: 3, kind: "key", text: "page: 12" },
  { line: 4, kind: "dim", text: "---" },
  { line: 5, kind: "md", text: "## 泛函分析 第 3 讲" },
  { line: 6, kind: "md", text: "### 1. 基本定义" },
  { line: 7, text: "设 X 为赋范线性空间，T: X \\\\to X 为有界线性算子。" },
  { line: 8, text: "**定义 3.1** 若存在常数 M > 0，使得对任意 x \\\\in X，" },
  { line: 9, text: "$$ \\\\|Tx\\\\| \\\\le M \\\\|x\\\\| $$" },
  { line: 10, text: "则称 T 为有界算子。" },
  { line: 11, text: "**定理 3.1** 有界线性算子的全体 \\\\mathcal{B}(X) 构成 Banach 空间。" },
  { line: 12, text: "**证明：** 设 (T_n) 为 \\\\mathcal{B}(X) 中的 Cauchy 列。" },
  { line: 13, text: "对任意 x \\\\in X，(T_nx) 在 X 中为 Cauchy 列。" },
  { line: 14, text: "定义 Tx = \\\\lim_{n\\\\to\\\\infty} T_nx。" },
  { line: 15, text: "需证 T 有界 ......" },
  { line: 16, kind: "quote", text: "> [看不清：最后一步估计式]" },
  { line: 17, kind: "dim", text: "---" },
  { line: 18, id: "src-photo-1", kind: "key", text: "source:", linkTarget: "photo_2026-06-26_001.png" },
  { line: 19, kind: "dim", text: "---" },
  { line: 20, id: "src-ocr-1", kind: "md", text: "#### 推导片段（来自 OCR 草稿）", editableBlockId: "sample-ocr-1" },
  { line: 21, text: "设 T_n 为有界线性算子，T_n \\\\to T 强收敛。" },
  { line: 22, text: "若 T 有界，则 \\\\sup_n \\\\|T_n\\\\| < \\\\infty？" },
  { line: 23, text: "（待验证）" },
  { line: 24, kind: "dim", text: "---" },
  {
    line: 25,
    id: "src-ocr-2",
    kind: "key",
    text: "source:",
    linkTarget: "photo_2026-06-26_001.png",
    suffix: "(ocr_transcript)",
    editableBlockId: "sample-ocr-2"
  },
  { line: 26, kind: "dim", text: "```text" },
  { line: 27, text: "设 T: X -> Y 线性有界，" },
  { line: 28, text: "||Tx||_Y <= C ||x||_X,   C > 0" },
  { line: 29, text: "||T|| = sup ||Tx||_Y," },
  { line: 30, text: "        ||x||_X <= 1" },
  { line: 31, kind: "dim", text: "```" },
  { line: 32, kind: "dim", text: "---" },
  {
    line: 33,
    id: "src-ocr-3",
    kind: "key",
    text: "source:",
    linkTarget: "photo_2026-06-26_002.png",
    suffix: "(ocr_transcript)",
    editableBlockId: "sample-ocr-3"
  },
  { line: 34, kind: "dim", text: "```text" },
  { line: 35, text: "||T|| = sup_{x != 0} <Tx, Tx>^{1/2} / <x,x>^{1/2}" },
  { line: 36, text: "      = sup_{||x|| = 1} ||Tx||" },
  { line: 37, kind: "dim", text: "```" },
  { line: 38, kind: "dim", text: "---" },
  { line: 39, id: "src-revision", kind: "key", text: "source: user_revision", editableBlockId: "sample-revision" },
  { line: 40, text: "注意常数记号的一致性：这里将有界常数记为 C，coercivity 常数记为 \\\\alpha。" },
  { line: 41, text: "同时 \\\\|T\\\\| = \\\\sup_{\\\\|x\\\\|=1}\\\\|Tx\\\\| 更简洁。" },
  { line: 42, kind: "dim", text: "---" },
  { line: 43, kind: "key", text: "source: user_note" },
  { line: 44, text: "后续需要补：一致有界性原理与 Lax-Milgram 的联系。" },
  { line: 45, text: "检查讨论班里关于弱收敛与强收敛的例子。" }
];

export const editableBlocks: EditableMarkdownBlock[] = [
  {
    id: "sample-ocr-1",
    sourceId: "src-ocr-1",
    sourceLine: 20,
    path: "blocks/sample_ocr_1.md",
    source: "ai_transcription",
    markdown: ["#### 推导片段（来自 OCR 草稿）", "", "设 T_n 为有界线性算子，T_n \\\\to T 强收敛。", "若 T 有界，则 \\\\sup_n \\\\|T_n\\\\| < \\\\infty？", "（待验证）"].join("\n")
  },
  {
    id: "sample-ocr-2",
    sourceId: "src-ocr-2",
    sourceLine: 25,
    path: "blocks/sample_ocr_2.md",
    source: "ai_transcription",
    markdown: ["```text", "设 T: X -> Y 线性有界，", "||Tx||_Y <= C ||x||_X,   C > 0", "||T|| = sup ||Tx||_Y,", "        ||x||_X <= 1", "```"].join("\n")
  },
  {
    id: "sample-ocr-3",
    sourceId: "src-ocr-3",
    sourceLine: 33,
    path: "blocks/sample_ocr_3.md",
    source: "ai_transcription",
    markdown: ["```text", "||T|| = sup_{x != 0} <Tx, Tx>^{1/2} / <x,x>^{1/2}", "      = sup_{||x|| = 1} ||Tx||", "```"].join("\n")
  },
  {
    id: "sample-revision",
    sourceId: "src-revision",
    sourceLine: 39,
    path: "blocks/sample_revision.md",
    source: "user_revision",
    markdown: "注意常数记号的一致性：这里将有界常数记为 C，coercivity 常数记为 \\\\alpha。\n同时 \\\\|T\\\\| = \\\\sup_{\\\\|x\\\\|=1}\\\\|Tx\\\\| 更简洁。"
  }
];

export const sourceDocument: SessionSourceDocument = {
  text: [
    "--- source: pdf | block: sample-pdf ---",
    "## 泛函分析 第 3 讲",
    "### 1. 基本定义",
    "设 X 为赋范线性空间，T: X \\\\to X 为有界线性算子。",
    "**定义 3.1** 若存在常数 M > 0，使得对任意 x \\\\in X，",
    "$$ \\\\|Tx\\\\| \\\\le M \\\\|x\\\\| $$",
    "则称 T 为有界算子。",
    "**定理 3.1** 有界线性算子的全体 \\\\mathcal{B}(X) 构成 Banach 空间。",
    "**证明：** 设 (T_n) 为 \\\\mathcal{B}(X) 中的 Cauchy 列。",
    "对任意 x \\\\in X，(T_nx) 在 X 中为 Cauchy 列。",
    "定义 Tx = \\\\lim_{n\\\\to\\\\infty} T_nx。",
    "需证 T 有界 ......",
    "> [看不清：最后一步估计式]",
    "",
    "--- source: photo_2026-06-26_001.png | block: sample-ocr-1 ---",
    editableBlocks[0].markdown,
    "",
    "--- source: photo_2026-06-26_001.png | block: sample-ocr-2 ---",
    editableBlocks[1].markdown,
    "",
    "--- source: photo_2026-06-26_002.png | block: sample-ocr-3 ---",
    editableBlocks[2].markdown,
    "",
    "--- source: user_revision | block: sample-revision ---",
    editableBlocks[3].markdown,
    "",
    "--- source: user_note | block: sample-user-note ---",
    "后续需要补：一致有界性原理与 Lax-Milgram 的联系。",
    "检查讨论班里关于弱收敛与强收敛的例子。"
  ].join("\n"),
  markdownBlocks: [
    {
      blockId: "sample-pdf",
      sourceId: "src-pdf",
      path: "assets/pdfs/lecture_notes.pdf",
      source: "pdf_import",
      header: "pdf",
      locked: false
    },
    ...editableBlocks.map((block) => ({
      blockId: block.id,
      sourceId: block.sourceId,
      path: block.path,
      source: block.source,
      header:
        block.id === "sample-revision"
          ? "user_revision"
          : block.id === "sample-ocr-3"
            ? "photo_2026-06-26_002.png"
            : "photo_2026-06-26_001.png",
      locked: false
    })),
    {
      blockId: "sample-user-note",
      sourceId: "src-user-note",
      path: "blocks/sample_user_note.md",
      source: "user",
      header: "user_note",
      locked: false
    }
  ]
};

export const renderBlocks: RenderBlock[] = [
  {
    id: "preview-pdf",
    sourceId: "src-pdf",
    sourceLine: 2,
    title: "泛函分析 第 3 讲",
    subtitle: "1. 基本定义",
    paragraphs: ["设 X 为赋范线性空间，T: X → X 为有界线性算子。"],
    formulas: ["∥Tx∥ ≤ M∥x∥"]
  },
  {
    id: "preview-theorem",
    sourceId: "src-pdf",
    sourceLine: 11,
    paragraphs: [
      "定理 3.1 有界线性算子的全体 𝓑(X) 在算子范数下构成 Banach 空间。",
      "证明：设 (Tₙ) 为 𝓑(X) 中的 Cauchy 列。对任意 x ∈ X，(Tₙx) 在 X 中为 Cauchy 列，因而收敛。",
      "定义 Tx = lim Tₙx，需证 T 有界 ……"
    ],
    unclear: "[看不清：最后一步估计式]"
  },
  {
    id: "preview-ocr-1",
    sourceId: "src-ocr-1",
    sourceLine: 20,
    className: "compact",
    title: "推导片段",
    paragraphs: ["设 Tₙ 为有界线性算子，Tₙ → T 强收敛。", "若 T 有界，则 supₙ ∥Tₙ∥ < ∞？"],
    unclear: "（待验证）"
  },
  {
    id: "preview-ocr-2",
    sourceId: "src-ocr-2",
    sourceLine: 25,
    paragraphs: ["设 T: X → Y 线性有界，"],
    formulas: ["∥Tx∥ᵧ ≤ C∥x∥ₓ,   C > 0", "∥T∥ = sup∥x∥≤1 ∥Tx∥ᵧ"]
  },
  {
    id: "preview-ocr-3",
    sourceId: "src-ocr-3",
    sourceLine: 33,
    formulas: ["∥T∥ = supₓ≠0 ⟨Tx, Tx⟩¹ᐟ² / ⟨x, x⟩¹ᐟ²", "= sup∥x∥=1 ∥Tx∥"]
  },
  {
    id: "preview-revision",
    sourceId: "src-revision",
    sourceLine: 39,
    className: "revision",
    paragraphs: [
      "注：注意常数记号的一致性：这里将有界常数记为 C，coercivity 常数记为 α。",
      "同时 ∥T∥ = sup∥x∥=1∥Tx∥ 更简洁。"
    ]
  }
];
