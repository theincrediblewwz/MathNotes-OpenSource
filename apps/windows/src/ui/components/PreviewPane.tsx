import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefCallback
} from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import MarkdownIt from "markdown-it";
import { normalizeMathForPortableMarkdown } from "../../common/markdownMath";
import type { RenderBlock } from "../sampleSession";
import { resolveSessionAssetPreview } from "../assetReferences";
import { PdfDocumentPreview } from "./PdfDocumentPreview";

const PreviewTanStackLab = lazy(async () => {
  const module = await import("./PreviewTanStackLab");
  return { default: module.PreviewTanStackLab };
});

export type PreviewSourceLocationInput = {
  blockId: string;
  sourceId: string;
  displayBlockId: string;
  lineInBlock?: number;
  lineCount?: number;
};

type PreviewPaneProps = {
  blocks: RenderBlock[];
  forceStatic?: boolean;
  sessionDir?: string;
  onLocateSource: (location: PreviewSourceLocationInput) => void;
  onHover: (event: MouseEvent<HTMLElement>, block: RenderBlock, location: PreviewSourceLocationInput) => void;
  onLeave: () => void;
};

export type PreviewLabVirtualLayout = {
  heights: number[];
  offsets: number[];
  totalHeight: number;
};

type PreviewLabVirtualRange = {
  start: number;
  end: number;
};

const previewLabSegmentSize = 12;
const previewLabOverscanPx = 1200;

export function buildPreviewLabVirtualLayout(
  blocks: RenderBlock[],
  measuredHeights: ReadonlyMap<string, number> = new Map()
): PreviewLabVirtualLayout {
  const heights = blocks.map((block) => measuredHeights.get(block.id) ?? estimatePreviewBlockHeight(block));
  const offsets: number[] = [];
  let totalHeight = 0;
  for (const height of heights) {
    offsets.push(totalHeight);
    totalHeight += height;
  }
  return { heights, offsets, totalHeight };
}

export function calculatePreviewLabScrollAnchorAdjustment(input: {
  previousLayout: PreviewLabVirtualLayout;
  nextLayout: PreviewLabVirtualLayout;
  scrollTop: number;
  contentTop?: number;
}): number {
  const relativeScrollTop = Math.max(0, input.scrollTop - (input.contentTop ?? 0));
  const intersectingIndex = findPreviewIndexAtOffset(input.previousLayout, relativeScrollTop);
  const nextIndex = Math.min(intersectingIndex + 1, input.previousLayout.offsets.length - 1);
  const intersectingDistance = Math.abs(
    relativeScrollTop - (input.previousLayout.offsets[intersectingIndex] ?? 0)
  );
  const nextDistance = Math.abs(
    (input.previousLayout.offsets[nextIndex] ?? Number.POSITIVE_INFINITY) - relativeScrollTop
  );
  const anchorIndex = nextDistance < intersectingDistance ? nextIndex : intersectingIndex;
  if (anchorIndex <= 0) return 0;
  return (input.nextLayout.offsets[anchorIndex] ?? 0) - (input.previousLayout.offsets[anchorIndex] ?? 0);
}

export function findPreviewLabVirtualRange(input: {
  layout: PreviewLabVirtualLayout;
  scrollTop: number;
  viewportHeight: number;
  itemCount: number;
  overscanPx?: number;
}): PreviewLabVirtualRange {
  if (input.itemCount === 0) return { start: 0, end: 0 };
  const overscan = input.overscanPx ?? previewLabOverscanPx;
  const startOffset = Math.max(0, input.scrollTop - overscan);
  const endOffset = Math.min(input.layout.totalHeight, input.scrollTop + input.viewportHeight + overscan);
  const visibleStart = findPreviewIndexAtOffset(input.layout, startOffset);
  const visibleEnd = Math.min(input.itemCount, findPreviewIndexAtOffset(input.layout, endOffset) + 1);
  const segmentStart = Math.floor(visibleStart / previewLabSegmentSize) * previewLabSegmentSize;
  return {
    start: Math.max(0, segmentStart - previewLabSegmentSize),
    end: Math.min(input.itemCount, segmentStart + previewLabSegmentSize * 2, visibleEnd + previewLabSegmentSize)
  };
}

const markdownParser = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: false
});

type MarkdownInlineState = Parameters<Parameters<typeof markdownParser.inline.ruler.before>[2]>[0];
type MarkdownBlockState = Parameters<Parameters<typeof markdownParser.block.ruler.before>[2]>[0];

const defaultFenceRenderer = markdownParser.renderer.rules.fence;
markdownParser.inline.ruler.before("escape", "math_inline", mathInlineRule);
markdownParser.block.ruler.before("fence", "math_block", mathBlockRule, {
  alt: ["paragraph", "reference", "blockquote"]
});
markdownParser.renderer.rules.code_inline = (tokens, index) =>
  `<code class="preview-inline-code">${markdownParser.utils.escapeHtml(tokens[index].content)}</code>`;
markdownParser.renderer.rules.math_inline = (tokens, index) => renderMath(tokens[index].content, false, "inline");
markdownParser.renderer.rules.math_block = (tokens, index) => renderMath(tokens[index].content, true, "block");
markdownParser.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index];
  const srcIndex = token.attrIndex("src");
  if (srcIndex >= 0 && token.attrs) {
    token.attrs[srcIndex][1] = resolvePreviewImageSrc(token.attrs[srcIndex][1], env.sessionDir);
  }
  return self.renderToken(tokens, index, options);
};
markdownParser.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index];
  const info = token.info ? markdownParser.utils.unescapeAll(token.info).trim() : "";
  const language = info ? ` data-language="${markdownParser.utils.escapeHtml(info.split(/\s+/)[0])}"` : "";
  const rendered = defaultFenceRenderer
    ? defaultFenceRenderer(tokens, index, options, env, self)
    : `<pre><code>${markdownParser.utils.escapeHtml(token.content)}</code></pre>`;

  return rendered.replace("<pre", `<pre class="preview-code-block"${language}`);
};

export function PreviewPane({ blocks, forceStatic = false, sessionDir, onLocateSource, onHover, onLeave }: PreviewPaneProps) {
  const pointerGesture = useRef<{ pointerId: number; x: number; y: number; scrollInteraction: boolean } | null>(null);
  const previewRootRef = useRef<HTMLDivElement | null>(null);
  const previewArticleRef = useRef<HTMLElement | null>(null);
  const previewWindowingMode = useMemo(
    () => typeof window === "undefined"
      ? "off"
      : forceStatic ? "off" : window.localStorage.getItem("mathnotes:preview-windowing-lab") ?? "tanstack-measured",
    [forceStatic]
  );
  const previewTanStackLab = previewWindowingMode === "tanstack-measured";
  const previewWindowingLab = previewWindowingMode === "virtual" || previewWindowingMode === "virtual-measured";
  const previewMeasuredWindowingLab = previewWindowingMode === "virtual-measured";
  const measuredPreviewHeightsRef = useRef(new Map<string, number>());
  const previewWidthRef = useRef<number | null>(null);
  const previewCalibrationRef = useRef({ correctionCount: 0, correctionPx: 0 });
  const [previewMeasurementRevision, setPreviewMeasurementRevision] = useState(0);
  const estimatedPreviewLayout = useMemo(() => buildPreviewLabVirtualLayout(blocks), [blocks]);
  const previewLayout = useMemo(
    () => buildPreviewLabVirtualLayout(
      blocks,
      previewMeasuredWindowingLab ? measuredPreviewHeightsRef.current : new Map()
    ),
    [blocks, previewMeasuredWindowingLab, previewMeasurementRevision]
  );
  const previewLayoutRef = useRef(previewLayout);
  const schedulePreviewRangeRef = useRef<() => void>(() => undefined);
  const [previewRange, setPreviewRange] = useState<PreviewLabVirtualRange>(() => ({
    start: 0,
    end: Math.min(blocks.length, previewLabSegmentSize * 2)
  }));

  useEffect(() => {
    previewLayoutRef.current = previewLayout;
    schedulePreviewRangeRef.current();
  }, [previewLayout]);

  useEffect(() => {
    const validBlockIds = new Set(blocks.map((block) => block.id));
    for (const blockId of measuredPreviewHeightsRef.current.keys()) {
      if (!validBlockIds.has(blockId)) measuredPreviewHeightsRef.current.delete(blockId);
    }
  }, [blocks]);

  useEffect(() => {
    if (!previewWindowingLab) return;
    const root = previewRootRef.current;
    if (!root) return;
    let frame: number | null = null;
    const updateRange = () => {
      frame = null;
      const nextRange = findPreviewLabVirtualRange({
        layout: previewLayoutRef.current,
        scrollTop: root.scrollTop,
        viewportHeight: root.clientHeight,
        itemCount: blocks.length
      });
      setPreviewRange((current) => current.start === nextRange.start && current.end === nextRange.end ? current : nextRange);
    };
    const scheduleUpdate = () => {
      if (frame === null) frame = window.requestAnimationFrame(updateRange);
    };
    schedulePreviewRangeRef.current = scheduleUpdate;
    root.addEventListener("scroll", scheduleUpdate, { passive: true });
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(root);
    updateRange();
    return () => {
      root.removeEventListener("scroll", scheduleUpdate);
      resizeObserver?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      schedulePreviewRangeRef.current = () => undefined;
    };
  }, [blocks.length, previewWindowingLab]);

  useLayoutEffect(() => {
    if (!previewMeasuredWindowingLab || typeof ResizeObserver === "undefined") return;
    const root = previewRootRef.current;
    const article = previewArticleRef.current;
    if (!root || !article) return;
    const measuredElements = Array.from(article.querySelectorAll<HTMLElement>("[data-preview-measure-key]"));
    let measureFrame: number | null = null;

    const applyLayout = (nextMeasuredHeights: Map<string, number>) => {
      const previousLayout = previewLayoutRef.current;
      const nextLayout = buildPreviewLabVirtualLayout(blocks, nextMeasuredHeights);
      const anchorAdjustment = calculatePreviewLabScrollAnchorAdjustment({
        previousLayout,
        nextLayout,
        scrollTop: root.scrollTop,
        contentTop: article.offsetTop
      });
      measuredPreviewHeightsRef.current = nextMeasuredHeights;
      previewLayoutRef.current = nextLayout;
      if (Math.abs(anchorAdjustment) > 0.5) {
        root.scrollTop += anchorAdjustment;
        previewCalibrationRef.current.correctionCount += 1;
        previewCalibrationRef.current.correctionPx += Math.abs(anchorAdjustment);
      }
      setPreviewMeasurementRevision((revision) => revision + 1);
    };

    const measureRenderedBlocks = () => {
      measureFrame = null;
      const nextMeasuredHeights = new Map(measuredPreviewHeightsRef.current);
      let changed = false;
      for (const element of measuredElements) {
        const key = element.dataset.previewMeasureKey;
        if (!key) continue;
        const styles = window.getComputedStyle(element);
        const marginBottom = Number.parseFloat(styles.marginBottom) || 0;
        const measuredHeight = element.getBoundingClientRect().height + marginBottom;
        if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) continue;
        if (Math.abs((nextMeasuredHeights.get(key) ?? 0) - measuredHeight) <= 0.5) continue;
        nextMeasuredHeights.set(key, measuredHeight);
        changed = true;
      }
      if (changed) applyLayout(nextMeasuredHeights);
    };

    const scheduleMeasure = () => {
      if (measureFrame === null) measureFrame = window.requestAnimationFrame(measureRenderedBlocks);
    };
    const observer = new ResizeObserver((entries) => {
      const rootEntry = entries.find((entry) => entry.target === root);
      if (rootEntry) {
        const nextWidth = root.clientWidth;
        const previousWidth = previewWidthRef.current;
        previewWidthRef.current = nextWidth;
        if (previousWidth !== null && Math.abs(previousWidth - nextWidth) > 1 && measuredPreviewHeightsRef.current.size > 0) {
          applyLayout(new Map());
        }
      }
      scheduleMeasure();
    });
    previewWidthRef.current ??= root.clientWidth;
    observer.observe(root);
    for (const element of measuredElements) observer.observe(element);
    scheduleMeasure();
    return () => {
      observer.disconnect();
      if (measureFrame !== null) window.cancelAnimationFrame(measureFrame);
    };
  }, [blocks, previewMeasuredWindowingLab, previewRange.end, previewRange.start]);

  const renderedBlocks = previewWindowingLab ? blocks.slice(previewRange.start, previewRange.end) : blocks;
  const topSpacerHeight = previewWindowingLab ? previewLayout.offsets[previewRange.start] ?? 0 : 0;
  const renderedEndOffset = previewWindowingLab
    ? (previewLayout.offsets[previewRange.end] ?? previewLayout.totalHeight)
    : previewLayout.totalHeight;
  const bottomSpacerHeight = previewWindowingLab ? Math.max(0, previewLayout.totalHeight - renderedEndOffset) : 0;

  function handleBlockPointerDown(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0) {
      return;
    }
    pointerGesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollInteraction: isMathScrollInteraction(event)
    };
  }

  function handleBlockPointerUp(event: PointerEvent<HTMLElement>) {
    const gesture = pointerGesture.current;
    pointerGesture.current = null;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.scrollInteraction) {
      return;
    }
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 5) {
      return;
    }

    const sourceBlock = event.currentTarget;
    if (sourceBlock.dataset.blockId && sourceBlock.dataset.source) {
      onLocateSource(locationFromElement(sourceBlock, event.clientY));
    }
  }

  function handleBlockClick(event: MouseEvent<HTMLElement>) {
    if (!(event.target instanceof Element)) {
      return;
    }
    if (event.target.closest("a")) {
      event.preventDefault();
    }
  }

  function renderPreviewBlock(
    block: RenderBlock,
    previewIndex: number,
    options: {
      measureElement?: RefCallback<HTMLElement>;
      style?: CSSProperties;
    } = {}
  ) {
    return (
      <section
        className={["render-block", block.className].filter(Boolean).join(" ")}
        data-block-id={block.sourceBlockId ?? block.sourceId}
        data-display-block={block.sourceBlockId ?? block.sourceId}
        data-index={previewTanStackLab ? previewIndex : undefined}
        data-line={block.sourceLine}
        data-line-count={block.sourceBlockLineCount}
        data-line-in-block={block.sourceBlockLine}
        data-preview-index={previewIndex}
        data-preview-measure-key={previewMeasuredWindowingLab ? block.id : undefined}
        data-source={block.sourceId}
        data-testid="render-block"
        key={block.id}
        onClick={handleBlockClick}
        onMouseLeave={onLeave}
        onMouseMove={(event) => onHover(event, block, locationFromElement(event.currentTarget, event.clientY))}
        onMouseEnter={(event) => onHover(event, block, locationFromElement(event.currentTarget, event.clientY))}
        onPointerDown={handleBlockPointerDown}
        onPointerCancel={() => {
          pointerGesture.current = null;
        }}
        onPointerUp={handleBlockPointerUp}
        ref={options.measureElement}
        style={options.style}
      >
        {block.pdf ? (
          <PdfDocumentPreview
            label={block.sourceLabel ?? "PDF"}
            pageCount={block.pdf.pageCount}
            sourceUrl={resolveSessionAssetPreview({ sessionDir, target: block.pdf.assetPath })?.previewUrl ?? block.pdf.assetPath}
          />
        ) : block.markdown ? (
          <MemoizedMarkdownPreview markdown={block.markdown} sessionDir={sessionDir} />
        ) : (
          renderFallbackBlock(block)
        )}
      </section>
    );
  }

  return (
    <div
      className="preview-scroll"
      data-preview-anchor-correction-count={previewCalibrationRef.current.correctionCount}
      data-preview-anchor-correction-px={previewCalibrationRef.current.correctionPx.toFixed(2)}
      data-preview-calibrated-total-height={previewLayout.totalHeight.toFixed(2)}
      data-preview-estimated-total-height={estimatedPreviewLayout.totalHeight.toFixed(2)}
      data-preview-measured-count={previewMeasuredWindowingLab ? measuredPreviewHeightsRef.current.size : 0}
      data-preview-windowing-lab={previewTanStackLab || previewWindowingLab ? previewWindowingMode : "off"}
      ref={previewRootRef}
    >
      {previewTanStackLab ? (
        <Suspense fallback={<article aria-hidden="true" className="rendered-note" />}>
          <PreviewTanStackLab
            blocks={blocks}
            estimateSize={estimatePreviewBlockHeight}
            renderItem={(block, index, measureElement, style) => renderPreviewBlock(block, index, { measureElement, style })}
            scrollElementRef={previewRootRef}
          />
        </Suspense>
      ) : (
        <article className="rendered-note" ref={previewArticleRef}>
          {previewWindowingLab && topSpacerHeight > 0 ? (
            <div aria-hidden="true" data-testid="preview-virtual-spacer-top" style={{ height: topSpacerHeight }} />
          ) : null}
          {renderedBlocks.map((block, renderedIndex) => renderPreviewBlock(
            block,
            previewWindowingLab ? previewRange.start + renderedIndex : renderedIndex
          ))}
          {previewWindowingLab && bottomSpacerHeight > 0 ? (
            <div aria-hidden="true" data-testid="preview-virtual-spacer-bottom" style={{ height: bottomSpacerHeight }} />
          ) : null}
        </article>
      )}
    </div>
  );
}

function estimatePreviewBlockHeight(block: RenderBlock): number {
  const markdown = block.markdown ?? [
    block.title,
    block.subtitle,
    ...(block.paragraphs ?? []),
    ...(block.formulas ?? []),
    ...(block.items?.map((item) => item.text) ?? [])
  ].filter(Boolean).join("\n");
  const visualLines = markdown.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 72)), 0);
  const displayMathCount = (markdown.match(/\$\$/g)?.length ?? 0) / 2;
  return Math.max(92, Math.ceil(54 + visualLines * 31 + displayMathCount * 24));
}

function findPreviewIndexAtOffset(layout: PreviewLabVirtualLayout, offset: number): number {
  if (layout.offsets.length === 0) return 0;
  let low = 0;
  let high = layout.offsets.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (layout.offsets[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

const MemoizedMarkdownPreview = memo(function MemoizedMarkdownPreview({
  markdown,
  sessionDir
}: {
  markdown: string;
  sessionDir?: string;
}) {
  return (
    <div
      className="rendered-markdown"
      dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(markdown, sessionDir) }}
    />
  );
});

function isMathScrollInteraction(event: PointerEvent<HTMLElement>): boolean {
  if (!(event.target instanceof Element)) {
    return false;
  }
  const scrollArea = event.target.closest<HTMLElement>(".preview-math-block");
  if (!scrollArea || scrollArea.scrollWidth <= scrollArea.clientWidth) {
    return false;
  }
  const rect = scrollArea.getBoundingClientRect();
  const scrollbarBand = Math.max(14, scrollArea.offsetHeight - scrollArea.clientHeight);
  return event.clientY >= rect.bottom - scrollbarBand;
}

function locationFromElement(sourceBlock: HTMLElement, clientY: number): PreviewSourceLocationInput {
  const blockId = sourceBlock.dataset.blockId ?? sourceBlock.dataset.source ?? "";
  const sourceId = sourceBlock.dataset.source ?? blockId;
  const lineCount = parseOptionalPositiveInteger(sourceBlock.dataset.lineCount);
  return {
    blockId,
    sourceId,
    displayBlockId: sourceBlock.dataset.displayBlock || blockId,
    lineInBlock: estimateLineInBlock(sourceBlock, clientY, lineCount),
    lineCount
  };
}

function estimateLineInBlock(sourceBlock: HTMLElement, clientY: number, lineCount: number | undefined): number | undefined {
  const fallbackLine = parseOptionalPositiveInteger(sourceBlock.dataset.lineInBlock);
  if (!lineCount || lineCount <= 1) {
    return fallbackLine;
  }

  const rect = sourceBlock.getBoundingClientRect();
  if (!Number.isFinite(rect.height) || rect.height <= 0) {
    return fallbackLine;
  }

  const ratio = Math.max(0, Math.min(0.999, (clientY - rect.top) / rect.height));
  return Math.max(1, Math.min(lineCount, Math.floor(ratio * lineCount) + 1));
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function renderMarkdownPreview(markdown: string, sessionDir?: string): string {
  return markdownParser.render(normalizeMathForPortableMarkdown(markdown), { sessionDir });
}

function resolvePreviewImageSrc(src: string, sessionDir?: string): string {
  if (/^(?:[a-z]+:|\/\/|#)/i.test(src)) {
    return src;
  }

  return resolveSessionAssetPreview({ sessionDir, target: src })?.previewUrl ?? src;
}

function renderMath(content: string, displayMode: boolean, kind: "inline" | "block"): string {
  const trimmed = content.trim();

  try {
    const html = katex.renderToString(trimmed, {
      displayMode,
      output: "html",
      strict: false,
      throwOnError: true,
      trust: false
    });
    return kind === "block"
      ? `<div class="preview-math-block">${html}</div>`
      : `<span class="preview-math-inline">${html}</span>`;
  } catch {
    const escaped = markdownParser.utils.escapeHtml(trimmed);
    return kind === "block"
      ? `<div class="preview-math-fallback" data-math-render-error="true"><strong>公式未能渲染</strong><code>${escaped}</code></div>`
      : `<span class="preview-math-fallback" data-math-render-error="true" title="公式未能渲染，请检查 LaTeX">${escaped}</span>`;
  }
}

function mathInlineRule(state: MarkdownInlineState, silent: boolean): boolean {
  const source = state.src;
  const start = state.pos;

  if (source.startsWith("\\(", start)) {
    const close = source.indexOf("\\)", start + 2);
    if (close === -1) {
      return false;
    }
    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.content = source.slice(start + 2, close);
    }
    state.pos = close + 2;
    return true;
  }

  if (source.charCodeAt(start) !== 0x24 || source[start + 1] === "$") {
    return false;
  }

  const close = findClosingDollar(source, start + 1);
  if (close === -1) {
    return false;
  }

  const content = source.slice(start + 1, close);
  if (!content.trim()) {
    return false;
  }

  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.content = content;
  }
  state.pos = close + 1;
  return true;
}

function mathBlockRule(state: MarkdownBlockState, startLine: number, endLine: number, silent: boolean): boolean {
  const lineStart = state.bMarks[startLine] + state.tShift[startLine];
  const lineEnd = state.eMarks[startLine];
  const firstLine = state.src.slice(lineStart, lineEnd).trim();
  const delimiter = firstLine.startsWith("$$") ? "$$" : firstLine.startsWith("\\[") ? "\\]" : null;

  if (!delimiter) {
    return false;
  }

  const openerLength = delimiter === "$$" ? 2 : 2;
  const sameLineContent = firstLine.slice(openerLength);
  const sameLineClose = delimiter === "$$" ? sameLineContent.indexOf("$$") : sameLineContent.indexOf("\\]");

  if (sameLineClose !== -1) {
    if (!silent) {
      const token = state.push("math_block", "math", 0);
      token.block = true;
      token.content = sameLineContent.slice(0, sameLineClose);
      token.map = [startLine, startLine + 1];
    }
    state.line = startLine + 1;
    return true;
  }

  const lines: string[] = [];
  if (sameLineContent.trim()) {
    lines.push(sameLineContent);
  }

  for (let nextLine = startLine + 1; nextLine < endLine; nextLine += 1) {
    const nextStart = state.bMarks[nextLine] + state.tShift[nextLine];
    const nextEnd = state.eMarks[nextLine];
    const nextContent = state.src.slice(nextStart, nextEnd);
    const closeIndex = delimiter === "$$" ? nextContent.indexOf("$$") : nextContent.indexOf("\\]");

    if (closeIndex !== -1) {
      lines.push(nextContent.slice(0, closeIndex));
      if (!silent) {
        const token = state.push("math_block", "math", 0);
        token.block = true;
        token.content = lines.join("\n");
        token.map = [startLine, nextLine + 1];
      }
      state.line = nextLine + 1;
      return true;
    }

    lines.push(nextContent);
  }

  return false;
}

function findClosingDollar(source: string, from: number): number {
  for (let index = from; index < source.length; index += 1) {
    if (source[index] === "$" && source[index - 1] !== "\\") {
      return index;
    }
  }
  return -1;
}

function renderFallbackBlock(block: RenderBlock) {
  return (
    <>
      {block.title ? <h1>{renderInlineMarkdown(block.title)}</h1> : null}
      {block.subtitle ? <h2>{renderInlineMarkdown(block.subtitle)}</h2> : null}
      {block.items
        ? block.items.map((item, index) => renderBlockItem(item, index))
        : (
            <>
              {block.paragraphs?.map((paragraph) => <p key={paragraph}>{renderInlineMarkdown(paragraph)}</p>)}
              {block.formulas?.map((formula) => (
                <div className="formula" key={formula}>
                  {formula}
                </div>
              ))}
              {block.unclear ? <p className="unclear">{renderInlineMarkdown(block.unclear)}</p> : null}
            </>
          )}
    </>
  );
}

function renderBlockItem(item: NonNullable<RenderBlock["items"]>[number], index: number) {
  if (item.kind === "code") {
    return (
      <pre className="preview-code-block" data-language={item.language} key={`${item.kind}-${index}`}>
        <code>{item.text}</code>
      </pre>
    );
  }

  if (item.kind === "formula") {
    return (
      <div className="formula" key={`${item.kind}-${index}`}>
        {item.text}
      </div>
    );
  }

  return (
    <p className={item.kind === "unclear" ? "unclear" : undefined} key={`${item.kind}-${index}`}>
      {renderInlineMarkdown(item.text)}
    </p>
  );
}

function renderInlineMarkdown(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  while (cursor < text.length) {
    const start = text.indexOf("`", cursor);
    if (start === -1) {
      nodes.push(text.slice(cursor));
      break;
    }

    const end = text.indexOf("`", start + 1);
    if (end === -1) {
      nodes.push(text.slice(cursor));
      break;
    }

    if (start > cursor) {
      nodes.push(text.slice(cursor, start));
    }

    const code = text.slice(start + 1, end);
    if (code) {
      nodes.push(
        <code className="preview-inline-code" key={`inline-code-${key}`}>
          {code}
        </code>
      );
      key += 1;
    } else {
      nodes.push("``");
    }

    cursor = end + 1;
  }

  return nodes.length ? nodes : text;
}
