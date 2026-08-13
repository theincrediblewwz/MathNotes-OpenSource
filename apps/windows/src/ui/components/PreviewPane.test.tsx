import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderBlock } from "../sampleSession";
import {
  buildPreviewLabVirtualLayout,
  calculatePreviewLabScrollAnchorAdjustment,
  findPreviewFocusTarget,
  findPreviewLabVirtualRange,
  PreviewPane,
  renderMarkdownPreview
} from "./PreviewPane";

describe("PreviewPane", () => {
  beforeEach(() => {
    window.localStorage.setItem("mathnotes:preview-windowing-lab", "off");
  });

  afterEach(() => {
    window.localStorage.removeItem("mathnotes:preview-windowing-lab");
  });

  it("maps a source caret line to the nearest split preview segment", () => {
    const blocks = [
      { id: "p-1", sourceId: "src-1", sourceBlockId: "0001", sourceLine: 2, sourceBlockLine: 1, markdown: "one\ntwo\nthree" },
      { id: "p-2", sourceId: "src-1", sourceBlockId: "0001", sourceLine: 8, sourceBlockLine: 7, markdown: "seven\neight\nnine" },
      { id: "p-3", sourceId: "src-1", sourceBlockId: "0001", sourceLine: 14, sourceBlockLine: 13, markdown: "thirteen\nfourteen\nfifteen" }
    ] satisfies RenderBlock[];

    expect(findPreviewFocusTarget(blocks, {
      blockId: "0001",
      displayBlockId: "0001",
      lineCount: 15,
      lineInBlock: 14,
      sourceId: "src-1"
    })).toEqual({ index: 2, ratio: 0.5 });
    expect(findPreviewFocusTarget(blocks, {
      blockId: "9999",
      displayBlockId: "9999",
      lineInBlock: 1,
      sourceId: "missing"
    })).toBeNull();
  });

  it("builds a stable segmented range for the preview windowing lab", () => {
    const blocks = Array.from({ length: 48 }, (_, index) => ({
      id: `preview-${index}`,
      sourceId: `source-${index}`,
      sourceLine: index + 1,
      markdown: `## Block ${index}\n\n${"content ".repeat(18)}`
    })) satisfies RenderBlock[];
    const layout = buildPreviewLabVirtualLayout(blocks);
    const range = findPreviewLabVirtualRange({
      layout,
      scrollTop: layout.offsets[26],
      viewportHeight: 900,
      itemCount: blocks.length,
      overscanPx: 0
    });

    expect(layout.offsets).toHaveLength(48);
    expect(layout.totalHeight).toBeGreaterThan(layout.offsets.at(-1) ?? 0);
    expect(range.start).toBe(12);
    expect(range.end).toBe(44);
  });

  it("uses measured preview heights without changing unmeasured estimates", () => {
    const blocks = Array.from({ length: 4 }, (_, index) => ({
      id: `preview-${index}`,
      sourceId: `source-${index}`,
      sourceLine: index + 1,
      markdown: `## Block ${index}\n\n${"content ".repeat(index + 1)}`
    })) satisfies RenderBlock[];
    const estimatedLayout = buildPreviewLabVirtualLayout(blocks);
    const measuredLayout = buildPreviewLabVirtualLayout(blocks, new Map([
      ["preview-0", 180],
      ["preview-2", 360]
    ]));

    expect(measuredLayout.heights).toEqual([
      180,
      estimatedLayout.heights[1],
      360,
      estimatedLayout.heights[3]
    ]);
    expect(measuredLayout.offsets[3]).toBe(180 + estimatedLayout.heights[1] + 360);
  });

  it("keeps the visible preview anchor stable when earlier blocks are remeasured", () => {
    const blocks = Array.from({ length: 5 }, (_, index) => ({
      id: `preview-${index}`,
      sourceId: `source-${index}`,
      sourceLine: index + 1,
      markdown: `Block ${index}`
    })) satisfies RenderBlock[];
    const previousLayout = buildPreviewLabVirtualLayout(blocks, new Map(blocks.map((block) => [block.id, 100])));
    const nextLayout = buildPreviewLabVirtualLayout(blocks, new Map([
      ["preview-0", 160],
      ["preview-1", 140],
      ["preview-2", 100],
      ["preview-3", 100],
      ["preview-4", 100]
    ]));

    expect(calculatePreviewLabScrollAnchorAdjustment({
      previousLayout,
      nextLayout,
      scrollTop: 350,
      contentTop: 50
    })).toBe(100);
    expect(calculatePreviewLabScrollAnchorAdjustment({
      previousLayout,
      nextLayout,
      scrollTop: 80,
      contentTop: 50
    })).toBe(0);
  });

  it("anchors the block nearest the viewport edge when the preceding block is almost hidden", () => {
    const blocks = Array.from({ length: 4 }, (_, index) => ({
      id: `preview-${index}`,
      sourceId: `source-${index}`,
      sourceLine: index + 1,
      markdown: `Block ${index}`
    })) satisfies RenderBlock[];
    const previousLayout = buildPreviewLabVirtualLayout(blocks, new Map(blocks.map((block) => [block.id, 100])));
    const nextLayout = buildPreviewLabVirtualLayout(blocks, new Map([
      ["preview-0", 100],
      ["preview-1", 190],
      ["preview-2", 100],
      ["preview-3", 100]
    ]));

    expect(calculatePreviewLabScrollAnchorAdjustment({
      previousLayout,
      nextLayout,
      scrollTop: 195
    })).toBe(90);
  });

  it("renders Markdown inline code without showing literal backticks", () => {
    const command = "openclaw plugins install @tencent-connect/openclaw-qqbot@latest";
    const blocks: RenderBlock[] = [
      {
        id: "preview-command",
        sourceId: "src-command",
        sourceLine: 13,
        items: [
          {
            kind: "paragraph",
            text: `\`${command}\``
          }
        ]
      }
    ];

    const { container } = render(
      <PreviewPane blocks={blocks} onHover={vi.fn()} onLeave={vi.fn()} onLocateSource={vi.fn()} />
    );

    const inlineCode = container.querySelector(".preview-inline-code");
    expect(inlineCode?.textContent).toBe(command);
    expect(screen.queryByText(`\`${command}\``)).toBeNull();
  });

  it("renders ordinary Markdown structure from raw block markdown", () => {
    const blocks: Array<RenderBlock & { markdown: string }> = [
      {
        id: "preview-baseline",
        sourceId: "src-baseline",
        sourceLine: 1,
        markdown: [
          "## OpenClaw 原生接入流程",
          "",
          "1. 安装 OpenClaw 插件",
          "",
          "`openclaw plugins install @tencent-connect/openclaw-qqbot@latest`",
          "",
          "```bash",
          "openclaw gateway restart",
          "```",
          "",
          "> 请保管好 Webhook 地址。",
          "",
          "[查看文档](https://example.com/openclaw-docs)"
        ].join("\n")
      }
    ];

    const { container } = render(
      <PreviewPane blocks={blocks} onHover={vi.fn()} onLeave={vi.fn()} onLocateSource={vi.fn()} />
    );

    expect(container.querySelector("h2")?.textContent).toBe("OpenClaw 原生接入流程");
    expect(container.querySelector("ol li")?.textContent).toContain("安装 OpenClaw 插件");
    expect(container.querySelector(".preview-inline-code")?.textContent).toContain("openclaw plugins install");
    expect(container.querySelector("pre code")?.textContent).toContain("openclaw gateway restart");
    expect(container.querySelector("blockquote")?.textContent).toContain("Webhook 地址");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/openclaw-docs");
  });

  it("locates the source block from nested rendered markdown pointer hits", () => {
    const onLocateSource = vi.fn();
    const blocks: Array<RenderBlock & { markdown: string }> = [
      {
        id: "preview-link",
        sourceId: "source-link-block",
        sourceLine: 7,
        sourceBlockId: "0007",
        sourceBlockLine: 1,
        sourceBlockLineCount: 3,
        markdown: "[查看文档](https://example.com/openclaw-docs)"
      }
    ];

    render(<PreviewPane blocks={blocks} onHover={vi.fn()} onLeave={vi.fn()} onLocateSource={onLocateSource} />);

    const link = screen.getByRole("link", { name: "查看文档" });
    fireEvent.pointerDown(link, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(link, { button: 0, pointerId: 1 });

    expect(onLocateSource).toHaveBeenCalledTimes(1);
    expect(onLocateSource).toHaveBeenCalledWith({
      blockId: "0007",
      displayBlockId: "0007",
      lineInBlock: 1,
      lineCount: 3,
      sourceId: "source-link-block"
    });
  });

  it("does not locate a nearby block when clicking preview whitespace", () => {
    const onLocateSource = vi.fn();
    const blocks: Array<RenderBlock & { markdown: string }> = [
      {
        id: "preview-one",
        sourceId: "src-0001",
        sourceLine: 1,
        sourceBlockId: "0001",
        sourceBlockLine: 1,
        sourceBlockLineCount: 2,
        markdown: "第一块"
      }
    ];

    const { container } = render(
      <PreviewPane blocks={blocks} onHover={vi.fn()} onLeave={vi.fn()} onLocateSource={onLocateSource} />
    );

    fireEvent.click(container.querySelector(".rendered-note")!);

    expect(onLocateSource).not.toHaveBeenCalled();
  });

  it("keeps repeated preview pointer hits tied to the clicked block id", () => {
    const onLocateSource = vi.fn();
    const blocks: Array<RenderBlock & { markdown: string }> = [
      {
        id: "preview-shared-one",
        sourceId: "src-shared",
        sourceLine: 1,
        sourceBlockId: "0001",
        sourceBlockLine: 2,
        sourceBlockLineCount: 5,
        markdown: "第一块"
      },
      {
        id: "preview-shared-two",
        sourceId: "src-shared",
        sourceLine: 9,
        sourceBlockId: "0002",
        sourceBlockLine: 4,
        sourceBlockLineCount: 8,
        markdown: "第二块"
      }
    ];

    render(<PreviewPane blocks={blocks} onHover={vi.fn()} onLeave={vi.fn()} onLocateSource={onLocateSource} />);

    for (const [index, label] of ["第二块", "第一块", "第二块"].entries()) {
      const target = screen.getByText(label);
      fireEvent.pointerDown(target, { button: 0, pointerId: index + 1 });
      fireEvent.pointerUp(target, { button: 0, pointerId: index + 1 });
    }

    expect(onLocateSource).toHaveBeenCalledTimes(3);
    expect(onLocateSource.mock.calls.map(([location]) => location.blockId)).toEqual(["0002", "0001", "0002"]);
    expect(onLocateSource).toHaveBeenLastCalledWith({
      blockId: "0002",
      displayBlockId: "0002",
      lineInBlock: 4,
      lineCount: 8,
      sourceId: "src-shared"
    });
  });

  it("estimates block-local source line from the clicked preview position", () => {
    const onLocateSource = vi.fn();
    const onHover = vi.fn();
    const blocks: Array<RenderBlock & { markdown: string }> = [
      {
        id: "preview-position",
        sourceId: "src-position",
        sourceLine: 1,
        sourceBlockId: "0009",
        sourceBlockLine: 1,
        sourceBlockLineCount: 10,
        markdown: ["# 标题", "第一段", "第二段", "第三段"].join("\n\n")
      }
    ];

    const { container } = render(<PreviewPane blocks={blocks} onHover={onHover} onLeave={vi.fn()} onLocateSource={onLocateSource} />);
    const block = container.querySelector(".render-block") as HTMLElement;
    block.getBoundingClientRect = () =>
      ({
        bottom: 200,
        height: 100,
        left: 0,
        right: 600,
        top: 100,
        width: 600,
        x: 0,
        y: 100,
        toJSON: () => ({})
      }) as DOMRect;

    fireEvent.mouseMove(block, { clientY: 175 });
    fireEvent.pointerDown(block, { button: 0, clientX: 100, clientY: 175, pointerId: 1 });
    fireEvent.pointerUp(block, { button: 0, clientX: 100, clientY: 175, pointerId: 1 });

    expect(onHover).toHaveBeenCalledWith(expect.anything(), blocks[0], {
      blockId: "0009",
      displayBlockId: "0009",
      lineCount: 10,
      lineInBlock: 8,
      sourceId: "src-position"
    });
    expect(onLocateSource).toHaveBeenCalledWith({
      blockId: "0009",
      displayBlockId: "0009",
      lineCount: 10,
      lineInBlock: 8,
      sourceId: "src-position"
    });
  });

  it("locates from the block visual hit area after a click gesture", () => {
    const onLocateSource = vi.fn();
    const blocks: Array<RenderBlock & { markdown: string }> = [
      {
        id: "preview-hit-area",
        sourceId: "src-hit-area",
        sourceLine: 1,
        sourceBlockId: "0010",
        sourceBlockLine: 1,
        sourceBlockLineCount: 6,
        markdown: ["# 标题", "", "正文", "", "$$x+y$$"].join("\n")
      }
    ];

    const { container } = render(
      <PreviewPane blocks={blocks} onHover={vi.fn()} onLeave={vi.fn()} onLocateSource={onLocateSource} />
    );
    const block = container.querySelector(".render-block") as HTMLElement;

    fireEvent.pointerDown(block, { button: 0, clientX: 120, clientY: 120, pointerId: 1 });
    fireEvent.pointerUp(block, { button: 0, clientX: 120, clientY: 120, pointerId: 1 });

    expect(onLocateSource).toHaveBeenCalledTimes(1);
    expect(onLocateSource).toHaveBeenCalledWith({
      blockId: "0010",
      displayBlockId: "0010",
      lineCount: 6,
      lineInBlock: 1,
      sourceId: "src-hit-area"
    });
  });

  it("does not locate source while dragging an overflowing formula scrollbar", () => {
    const onLocateSource = vi.fn();
    const blocks: Array<RenderBlock & { markdown: string }> = [
      {
        id: "preview-wide-math",
        sourceId: "src-wide-math",
        sourceLine: 1,
        sourceBlockId: "0011",
        sourceBlockLine: 1,
        sourceBlockLineCount: 3,
        markdown: "$$\\displaystyle " + "x_1+x_2+".repeat(40) + "x_{80}$$"
      }
    ];

    const { container } = render(
      <PreviewPane blocks={blocks} onHover={vi.fn()} onLeave={vi.fn()} onLocateSource={onLocateSource} />
    );
    const block = container.querySelector(".render-block") as HTMLElement;
    const math = container.querySelector(".preview-math-block") as HTMLElement;
    Object.defineProperties(math, {
      clientHeight: { configurable: true, value: 80 },
      clientWidth: { configurable: true, value: 300 },
      offsetHeight: { configurable: true, value: 96 },
      scrollWidth: { configurable: true, value: 900 }
    });
    math.getBoundingClientRect = () =>
      ({ bottom: 196, height: 96, left: 0, right: 300, top: 100, width: 300, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;

    fireEvent.pointerDown(math, { button: 0, clientX: 120, clientY: 190, pointerId: 9 });
    fireEvent.pointerUp(block, { button: 0, clientX: 220, clientY: 190, pointerId: 9 });

    expect(onLocateSource).not.toHaveBeenCalled();
  });

  it("does not locate source after a drag gesture in preview content", () => {
    const onLocateSource = vi.fn();
    const blocks: Array<RenderBlock & { markdown: string }> = [
      {
        id: "preview-drag",
        sourceId: "src-drag",
        sourceLine: 1,
        sourceBlockId: "0012",
        sourceBlockLine: 1,
        sourceBlockLineCount: 2,
        markdown: "可以选择或拖动的内容"
      }
    ];
    const { container } = render(
      <PreviewPane blocks={blocks} onHover={vi.fn()} onLeave={vi.fn()} onLocateSource={onLocateSource} />
    );
    const block = container.querySelector(".render-block") as HTMLElement;

    fireEvent.pointerDown(block, { button: 0, clientX: 80, clientY: 100, pointerId: 3 });
    fireEvent.pointerUp(block, { button: 0, clientX: 140, clientY: 100, pointerId: 3 });

    expect(onLocateSource).not.toHaveBeenCalled();
  });

  it("resolves embedded session image links only for preview rendering", () => {
    const blocks: Array<RenderBlock & { markdown: string }> = [
      {
        id: "preview-image",
        sourceId: "src-image",
        sourceLine: 1,
        markdown: "![图](../assets/embedded/diagram_01.png)"
      }
    ];

    const { container } = render(
      <PreviewPane
        blocks={blocks}
        sessionDir="C:/Users/MathNotesUser/AppData/Roaming/Electron/MyMathNotes/notebooks/n/sessions/s"
        onHover={vi.fn()}
        onLeave={vi.fn()}
        onLocateSource={vi.fn()}
      />
    );

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "mathnotes-asset://local/C:/Users/MathNotesUser/AppData/Roaming/Electron/MyMathNotes/notebooks/n/sessions/s/assets/embedded/diagram_01.png"
    );
    expect(blocks[0].markdown).toBe("![图](../assets/embedded/diagram_01.png)");
  });

  it("renders embedded image links even when the markdown line has trailing punctuation", () => {
    const blocks: Array<RenderBlock & { markdown: string }> = [
      {
        id: "preview-image-punctuated",
        sourceId: "src-image-punctuated",
        sourceLine: 1,
        markdown: "![图](../assets/embedded/diagram_02.png)."
      }
    ];

    const { container } = render(
      <PreviewPane
        blocks={blocks}
        sessionDir="C:/Users/MathNotesUser/AppData/Roaming/Electron/MyMathNotes/notebooks/n/sessions/s"
        onHover={vi.fn()}
        onLeave={vi.fn()}
        onLocateSource={vi.fn()}
      />
    );

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "mathnotes-asset://local/C:/Users/MathNotesUser/AppData/Roaming/Electron/MyMathNotes/notebooks/n/sessions/s/assets/embedded/diagram_02.png"
    );
  });

  it("renders inline and display math without exposing raw delimiters", () => {
    const blocks: Array<RenderBlock & { markdown: string }> = [
      {
        id: "preview-math",
        sourceId: "src-math",
        sourceLine: 1,
        markdown: [
          "若 $T_n \\to T$ 强收敛，则检查：",
          "",
          "$$",
          "\\\\|Tx\\\\| \\\\le C\\\\|x\\\\|",
          "$$"
        ].join("\n")
      }
    ];

    const { container } = render(
      <PreviewPane blocks={blocks} onHover={vi.fn()} onLeave={vi.fn()} onLocateSource={vi.fn()} />
    );

    expect(container.querySelector(".katex")).toBeTruthy();
    expect(container.querySelector(".preview-math-block .katex-display")).toBeTruthy();
    expect(container.textContent).not.toContain("$T_n");
    expect(container.textContent).not.toContain("$$");
  });

  it("normalizes adjacent display math delimiters before rendering live preview", () => {
    const blocks: Array<RenderBlock & { markdown: string }> = [
      {
        id: "preview-adjacent-display-math",
        sourceId: "src-adjacent-display-math",
        sourceLine: 1,
        markdown: [
          "我会按图片内容直接转写。$$",
          "|e^{tA_0}| \\le M_0 e^{\\omega_0 t},\\quad t \\ge 0",
          "$$",
          "$c$"
        ].join("\n")
      }
    ];

    const { container } = render(
      <PreviewPane blocks={blocks} onHover={vi.fn()} onLeave={vi.fn()} onLocateSource={vi.fn()} />
    );

    expect(container.textContent).toContain("我会按图片内容直接转写。");
    expect(container.querySelector(".preview-math-block .katex-display")).toBeTruthy();
    expect(container.textContent).not.toContain("转写。$$");
    expect(container.textContent).not.toContain("$$");
  });

  it("makes an invalid display formula visible as a render failure instead of silent plain text", () => {
    const html = renderMarkdownPreview("$$\\frac{x}{$$");

    expect(html).toContain('data-math-render-error="true"');
    expect(html).toContain("公式未能渲染");
    expect(html).toContain("\\frac");
  });

  it("keeps inline math inside an indented list continuation after display math", () => {
    const blocks: Array<RenderBlock & { markdown: string }> = [
      {
        id: "preview-indented-list-math",
        sourceId: "src-indented-list-math",
        sourceLine: 1,
        markdown: [
          "* temporal formulation 中，$\\alpha \\in R$，中性条件是",
          "    $$\\text{Im}\\omega = 0,$$",
          "    或者 $\\omega = \\alpha c$ 时",
          "    $$\\text{Im} c = 0.$$"
        ].join("\n")
      }
    ];

    const { container } = render(
      <PreviewPane blocks={blocks} onHover={vi.fn()} onLeave={vi.fn()} onLocateSource={vi.fn()} />
    );

    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(4);
    expect(container.querySelector(".preview-inline-code")).toBeNull();
    expect(container.textContent).not.toContain("$\\omega");
  });

  it("keeps rendering when math input is invalid", () => {
    const blocks: Array<RenderBlock & { markdown: string }> = [
      {
        id: "preview-bad-math",
        sourceId: "src-bad-math",
        sourceLine: 1,
        markdown: "坏公式 $\\notacommand$ 后面的正文仍然可见。"
      }
    ];

    const { container } = render(
      <PreviewPane blocks={blocks} onHover={vi.fn()} onLeave={vi.fn()} onLocateSource={vi.fn()} />
    );

    expect(container.textContent).toContain("后面的正文仍然可见");
    expect(container.querySelector(".katex-error")).toBeNull();
  });

  it("does not expose math delimiters when display math cannot be rendered", () => {
    const blocks: Array<RenderBlock & { markdown: string }> = [
      {
        id: "preview-invalid-display-math",
        sourceId: "src-invalid-display-math",
        sourceLine: 1,
        markdown: [
          "我会按图片内容直接转写。",
          "",
          "$$",
          "$c$   σ_- σ_0 σ_+ ()||--()--||--()",
          "$$",
          "",
          "W^{0-}\\quad X_0 \\oplus X_-"
        ].join("\n")
      }
    ];

    const { container } = render(
      <PreviewPane blocks={blocks} onHover={vi.fn()} onLeave={vi.fn()} onLocateSource={vi.fn()} />
    );

    expect(container.textContent).toContain("σ_- σ_0 σ_+");
    expect(container.textContent).toContain("W");
    expect(container.textContent).not.toContain("$$");
    expect(container.querySelector(".katex-error")).toBeNull();
  });
});
