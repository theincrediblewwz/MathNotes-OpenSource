import { EditorState, RangeSetBuilder, StateEffect, StateField, Transaction } from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  bracketMatching,
  codeFolding,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  foldAll,
  indentOnInput,
  syntaxHighlighting,
  unfoldAll
} from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { lintKeymap } from "@codemirror/lint";
import { markdown } from "@codemirror/lang-markdown";
import { BookOpenText } from "lucide-react";
import {
  lazy,
  Suspense,
  type CSSProperties,
  type MutableRefObject,
  type RefCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  findProtectedSpanAtPosition,
  findProtectedSpanCoveringSelection,
  findProtectedSpanRanges,
  wrapProtectedSpan
} from "../../common/lockSpan";
import type { SessionSourceDocument, SessionSourceMarkdownBlock } from "../../common/sessionSourceDocument";
import type { AssistantRemark } from "../../core/assistantRemarkStore";
import { findMarkdownImageReferenceAtPosition } from "../assetReferences";
import {
  buildMarkdownProjection,
  buildSourceTextFromBlockMarkdowns,
  type SourceHeaderReference
} from "./sessionSourceEditorModel";
import { createSourceBlockDisplays } from "./sourceBlockDisplay";
import { assistantDragMime, writeAssistantDragPayload } from "../assistantDragPayload";

const SourceTanStackLab = lazy(async () => {
  const module = await import("./SourceTanStackLab");
  return { default: module.SourceTanStackLab };
});

type SessionSourceEditorProps = {
  document: SessionSourceDocument;
  value: string;
  locatingRequest: {
    blockId: string;
    sourceId: string;
    lineInBlock?: number;
    lineCount?: number;
    nonce: number;
  } | null;
  insertMarkdownRequest?: {
    id: number;
    markdown: string;
  } | null;
  lockSelectionRequest: number;
  unlockProtectedSpanRequest: number;
  onChange: (value: string, projection?: SourceDocumentProjectionChange) => void;
  onActiveBlockChange: (block: SessionSourceMarkdownBlock | null) => void;
  onCaretLocationChange?: (location: SourceCaretLocation) => void;
  onProtectedSpanUnlockableChange: (unlockable: boolean) => void;
  onProtectedSpanUnlocked: () => void;
  onSelectionLockableChange: (lockable: boolean) => void;
  onSelectionLocked: () => void;
  onSourceReferenceClick: (reference: SourceHeaderReference) => void;
  onDeleteBlockRequest: (blockId: string) => void;
  onCreateBlockAfterRequest?: (blockId: string) => void;
  onAiSelectionEditRequest?: (input: {
    blockId: string;
    from: number;
    to: number;
    selectedText: string;
  }) => void;
  onReorderBlocksRequest?: (blockIds: string[], direction: "up" | "down") => void;
  onRerecognizeBlockRequest?: (blockId: string) => void;
  onTransferBlocksRequest?: (blockIds: string[], mode: "copy" | "move") => void;
  assistantRemarks?: AssistantRemark[];
  onAssistantRemarkOpen?: (remarkId: string) => void;
  assistantOpen?: boolean;
};

export type SourceCaretLocation = {
  blockId: string;
  sourceId: string;
  displayBlockId: string;
  lineInBlock: number;
  lineCount: number;
};

export type SourceDocumentProjectionChange = {
  editedBlockIds: readonly string[];
  markdownByBlockId: Readonly<Record<string, string>>;
};

type BlockMarkdownEditorProps = {
  block: SessionSourceMarkdownBlock;
  locatingLineRequest?: {
    lineInBlock?: number;
    nonce: number;
  };
  markdown: string;
  onAssetReferenceClick: (block: SessionSourceMarkdownBlock, target: string) => void;
  onMarkdownChange: (blockId: string, markdown: string) => void;
  onSelectionChange: (block: SessionSourceMarkdownBlock, view: EditorView) => void;
  onViewReady: (blockId: string, view: EditorView | null) => void;
  cachedEditorState?: EditorStateSnapshot;
  onEditorStateSnapshot?: (blockId: string, snapshot: EditorStateSnapshot) => void;
  assistantOpen: boolean;
  onContextMenu: (block: SessionSourceMarkdownBlock, view: EditorView, x: number, y: number) => void;
};

type EditorContextMenuState = {
  kind: "editor";
  block: SessionSourceMarkdownBlock;
  view: EditorView;
  x: number;
  y: number;
};

type BlockContextMenuState = {
  kind: "block";
  block: SessionSourceMarkdownBlock;
  x: number;
  y: number;
};

type AssistantSelectionFrame = {
  left: number;
  top: number;
  width: number;
  height: number;
  text: string;
  from: number;
  to: number;
};

type SourceTopEdgeClickDetail = {
  clientX: number;
  clientY: number;
};

type PerformanceLabWindow = Window & {
  __MATHNOTES_EDITOR_WINDOWING_LAB__?: boolean | "finite" | "dynamic" | "virtual" | "tanstack-virtual";
};

type EditorWindowingLabMode = "off" | "finite" | "dynamic" | "virtual" | "tanstack-virtual";

type VirtualBlockRange = {
  start: number;
  end: number;
};

type VirtualBlockLayout = {
  offsets: number[];
  sizes: number[];
  totalSize: number;
};

type EditorStateSnapshot = {
  state: EditorState;
  lastLocalEditAt: number;
};

const performanceLabEditorViewLimit = 12;
const performanceLabOverscanPx = 1200;
const performanceLabVirtualSegmentSize = 12;
const performanceLabLongSourceBlockLineLimit = 85;
const performanceLabStorageKey = "mathnotes:editor-windowing-lab";
const performanceLabSourceOverscanStorageKey = "mathnotes:source-overscan-lab";
const performanceLabVirtualHeaderHeight = 39;
const performanceLabVirtualLineHeight = 24;

export function getEditorWindowingPerformanceLabMode(): EditorWindowingLabMode {
  const runtimeMode = (window as PerformanceLabWindow).__MATHNOTES_EDITOR_WINDOWING_LAB__;
  const storedMode = window.localStorage?.getItem(performanceLabStorageKey);
  const mode = storedMode || runtimeMode;
  if (mode === "off") return "off";
  if (mode === "tanstack-virtual") return "tanstack-virtual";
  if (mode === "virtual") return "virtual";
  if (mode === "dynamic") return "dynamic";
  if (mode === true || mode === "finite") return "finite";
  return "tanstack-virtual";
}

function getSourceOverscanPerformanceLabValue() {
  const storedValue = Number.parseInt(window.localStorage?.getItem(performanceLabSourceOverscanStorageKey) ?? "", 10);
  return Number.isFinite(storedValue) ? Math.max(1, Math.min(16, storedValue)) : 2;
}

export function buildPerformanceLabVirtualLayout(markdowns: readonly string[]): VirtualBlockLayout {
  const offsets: number[] = [];
  const sizes: number[] = [];
  let totalSize = 0;
  for (const markdown of markdowns) {
    offsets.push(totalSize);
    const visualLines = markdown.split("\n").reduce((count, line) => (
      count + Math.max(1, Math.ceil(Math.max(1, line.length) / 88))
    ), 0);
    const size = performanceLabVirtualHeaderHeight + visualLines * performanceLabVirtualLineHeight;
    sizes.push(size);
    totalSize += size;
  }
  return { offsets, sizes, totalSize };
}

export function getTanStackSourceWindowingFallbackReason(
  markdowns: readonly string[]
): "small-session" | "long-block" | null {
  // A session with at most twelve blocks gains little from a second layer of
  // virtualization because CodeMirror already virtualizes the lines inside
  // each block. Keeping these editors in normal document flow also avoids
  // competing viewport calculations during native scrollbar drags.
  if (markdowns.length <= performanceLabEditorViewLimit) return "small-session";

  for (const markdown of markdowns) {
    let lineCount = 1;
    for (let index = 0; index < markdown.length; index += 1) {
      if (markdown.charCodeAt(index) !== 10) continue;
      lineCount += 1;
      if (lineCount >= performanceLabLongSourceBlockLineLimit) return "long-block";
    }
  }
  return null;
}

export function getTanStackSourceWindowingEffectiveMode(
  markdowns: readonly string[]
): "off" | "tanstack-virtual" {
  const fallbackReason = getTanStackSourceWindowingFallbackReason(markdowns);
  if (fallbackReason) return "off";
  return "tanstack-virtual";
}

export function findPerformanceLabVirtualRange({
  layout,
  scrollTop,
  viewportHeight,
  overscanPx,
  itemCount
}: {
  layout: VirtualBlockLayout;
  scrollTop: number;
  viewportHeight: number;
  overscanPx: number;
  itemCount: number;
}): VirtualBlockRange {
  if (itemCount === 0) return { start: 0, end: 0 };
  const from = Math.max(0, scrollTop - overscanPx);
  const to = Math.max(from, scrollTop + viewportHeight + overscanPx);
  const start = findVirtualBlockIndex(layout, from, itemCount);
  const end = Math.min(itemCount, findVirtualBlockIndex(layout, to, itemCount) + 1);
  return { start, end: Math.max(start + 1, end) };
}

export function expandPerformanceLabVirtualRange(
  visibleRange: VirtualBlockRange,
  itemCount: number,
  segmentSize = performanceLabVirtualSegmentSize
): VirtualBlockRange {
  if (itemCount === 0) return { start: 0, end: 0 };
  const currentSegmentStart = Math.floor(visibleRange.start / segmentSize) * segmentSize;
  return {
    start: Math.max(0, currentSegmentStart - segmentSize),
    end: Math.min(itemCount, currentSegmentStart + segmentSize * 2)
  };
}

function findVirtualBlockIndex(layout: VirtualBlockLayout, offset: number, itemCount: number) {
  let low = 0;
  let high = Math.max(0, itemCount - 1);
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if ((layout.offsets[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  const size = layout.sizes[low] ?? 0;
  if ((layout.offsets[low] ?? 0) + size < offset && low < itemCount - 1) return low + 1;
  return low;
}

export function findEditorCaretTargetAtPoint(
  editorViews: ReadonlyMap<string, EditorView>,
  point: SourceTopEdgeClickDetail
): { blockId: string; view: EditorView; position: number } | null {
  for (const [blockId, view] of editorViews) {
    const rect = view.dom.getBoundingClientRect();
    if (point.clientX < rect.left || point.clientX > rect.right || point.clientY < rect.top || point.clientY > rect.bottom) {
      continue;
    }
    const position = view.posAtCoords({ x: point.clientX, y: point.clientY });
    if (position !== null) return { blockId, view, position };
  }
  return null;
}

const localEditEchoGuardMs = 180;

export function shouldApplyExternalMarkdown({
  currentMarkdown,
  externalMarkdown,
  hasFocus,
  lastLocalEditAt,
  now
}: {
  currentMarkdown: string;
  externalMarkdown: string;
  hasFocus: boolean;
  lastLocalEditAt: number;
  now: number;
}) {
  if (currentMarkdown === externalMarkdown) {
    return false;
  }

  return !(hasFocus && now - lastLocalEditAt < localEditEchoGuardMs);
}

export function SessionSourceEditor({
  document,
  value,
  locatingRequest,
  insertMarkdownRequest,
  lockSelectionRequest,
  unlockProtectedSpanRequest,
  onChange,
  onActiveBlockChange,
  onCaretLocationChange,
  onProtectedSpanUnlockableChange,
  onProtectedSpanUnlocked,
  onSelectionLockableChange,
  onSelectionLocked,
  onSourceReferenceClick,
  onDeleteBlockRequest,
  onCreateBlockAfterRequest,
  onAiSelectionEditRequest,
  assistantRemarks = [],
  onAssistantRemarkOpen,
  assistantOpen = false,
  onReorderBlocksRequest,
  onRerecognizeBlockRequest,
  onTransferBlocksRequest
}: SessionSourceEditorProps) {
  const requestedEditorWindowingLabMode = getEditorWindowingPerformanceLabMode();
  const editorScrollerRef = useRef<HTMLDivElement>(null);
  const blockElementsRef = useRef(new Map<string, HTMLElement>());
  const editorViewsRef = useRef(new Map<string, EditorView>());
  const editorStateCacheRef = useRef(new Map<string, EditorStateSnapshot>());
  const measuredBlockHeightsRef = useRef(new Map<string, number>());
  const activeBlockIdRef = useRef<string | null>(null);
  const markdownByBlockIdRef = useRef<Record<string, string>>({});
  const documentRef = useRef(document);
  const onChangeRef = useRef(onChange);
  const onActiveBlockChangeRef = useRef(onActiveBlockChange);
  const onCaretLocationChangeRef = useRef(onCaretLocationChange);
  const onProtectedSpanUnlockableChangeRef = useRef(onProtectedSpanUnlockableChange);
  const onProtectedSpanUnlockedRef = useRef(onProtectedSpanUnlocked);
  const onSelectionLockableChangeRef = useRef(onSelectionLockableChange);
  const onSelectionLockedRef = useRef(onSelectionLocked);
  const onSourceReferenceClickRef = useRef(onSourceReferenceClick);
  const onDeleteBlockRequestRef = useRef(onDeleteBlockRequest);
  const lastLockSelectionRequestRef = useRef(lockSelectionRequest);
  const lastUnlockProtectedSpanRequestRef = useRef(unlockProtectedSpanRequest);
  const lastInsertMarkdownRequestRef = useRef(insertMarkdownRequest?.id ?? 0);
  const pendingMarkdownChangeFrameRef = useRef<number | null>(null);
  const pendingEditedBlockIdsRef = useRef(new Set<string>());
  const lastLocalProjectionRef = useRef<{
    blockIds: string;
    markdownByBlockId: Record<string, string>;
    value: string;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<EditorContextMenuState | BlockContextMenuState | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedBlockIds, setSelectedBlockIds] = useState<Set<string>>(() => new Set());
  const [activeWindowBlockId, setActiveWindowBlockId] = useState<string | null>(null);
  const [dynamicVisibleBlockIds, setDynamicVisibleBlockIds] = useState<ReadonlySet<string>>(
    () => new Set(document.markdownBlocks.slice(0, performanceLabEditorViewLimit).map((block) => block.blockId))
  );
  const observedDynamicVisibleBlockIdsRef = useRef<Set<string>>(
    new Set(document.markdownBlocks.slice(0, performanceLabEditorViewLimit).map((block) => block.blockId))
  );
  const dynamicVisibleBlockIdsRef = useRef(dynamicVisibleBlockIds);
  dynamicVisibleBlockIdsRef.current = dynamicVisibleBlockIds;
  const [virtualBlockRange, setVirtualBlockRange] = useState<VirtualBlockRange>(() => ({
    start: 0,
    end: Math.min(document.markdownBlocks.length, performanceLabEditorViewLimit)
  }));
  const [virtualHydratedBlockIds, setVirtualHydratedBlockIds] = useState<ReadonlySet<string>>(
    () => new Set(document.markdownBlocks.slice(0, performanceLabEditorViewLimit).map((block) => block.blockId))
  );
  const [locatingMountEpoch, setLocatingMountEpoch] = useState(0);

  const markdownBlockIds = useMemo(
    () => document.markdownBlocks.map((block) => block.blockId).join("\u0000"),
    [document.markdownBlocks]
  );
  const markdownByBlockId = useMemo(() => {
    const localProjection = lastLocalProjectionRef.current;
    if (localProjection?.value === value && localProjection.blockIds === markdownBlockIds) {
      return localProjection.markdownByBlockId;
    }
    return buildMarkdownProjection(value, document.markdownBlocks);
  }, [document.markdownBlocks, markdownBlockIds, value]);
  const displayByBlockId = useMemo(
    () => new Map(createSourceBlockDisplays(document.markdownBlocks).map((display) => [display.internalBlockId, display.displayBlockId])),
    [document.markdownBlocks]
  );
  const remarksByBlockId = useMemo(() => groupAssistantRemarksByBlockId(assistantRemarks), [assistantRemarks]);
  const sourceMarkdowns = useMemo(
    () => document.markdownBlocks.map((block) => markdownByBlockId[block.blockId] ?? ""),
    [document.markdownBlocks, markdownBlockIds, markdownByBlockId]
  );
  const tanStackFallbackReason = requestedEditorWindowingLabMode === "tanstack-virtual"
    ? getTanStackSourceWindowingFallbackReason(sourceMarkdowns)
    : null;
  const editorWindowingLabMode: EditorWindowingLabMode = requestedEditorWindowingLabMode === "tanstack-virtual"
    ? getTanStackSourceWindowingEffectiveMode(sourceMarkdowns)
    : requestedEditorWindowingLabMode;
  const dynamicEditorWindowingLab = editorWindowingLabMode === "dynamic";
  const virtualBlockWindowingLab = editorWindowingLabMode === "virtual";
  const tanStackSourceWindowingLab = editorWindowingLabMode === "tanstack-virtual";
  const statefulEditorWindowingLab = dynamicEditorWindowingLab ||
    virtualBlockWindowingLab ||
    requestedEditorWindowingLabMode === "tanstack-virtual";
  const virtualBlockLayout = useMemo(
    () => buildPerformanceLabVirtualLayout(sourceMarkdowns),
    [sourceMarkdowns]
  );

  useEffect(() => {
    // A local CodeMirror edit is projected to the aggregate source on the next frame.
    // Do not let an unrelated render replace that pending draft with the previous prop.
    if (pendingMarkdownChangeFrameRef.current === null) {
      markdownByBlockIdRef.current = markdownByBlockId;
    }
  }, [markdownByBlockId]);

  useEffect(() => {
    const validBlockIds = new Set(document.markdownBlocks.map((block) => block.blockId));
    for (const blockId of editorStateCacheRef.current.keys()) {
      if (!validBlockIds.has(blockId)) editorStateCacheRef.current.delete(blockId);
    }
    for (const blockId of measuredBlockHeightsRef.current.keys()) {
      if (!validBlockIds.has(blockId)) measuredBlockHeightsRef.current.delete(blockId);
    }
  }, [markdownBlockIds]);

  useEffect(() => {
    if (!dynamicEditorWindowingLab) return;
    const root = editorScrollerRef.current;
    if (!root || typeof IntersectionObserver === "undefined") {
      const allBlockIds = new Set(document.markdownBlocks.map((block) => block.blockId));
      dynamicVisibleBlockIdsRef.current = allBlockIds;
      setDynamicVisibleBlockIds(allBlockIds);
      return;
    }

    const observedVisibleBlockIds = observedDynamicVisibleBlockIdsRef.current;
    const validBlockIds = new Set(document.markdownBlocks.map((block) => block.blockId));
    for (const blockId of observedVisibleBlockIds) {
      if (!validBlockIds.has(blockId)) observedVisibleBlockIds.delete(blockId);
    }
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let hydrationFrame: number | null = null;
    let hydrationGeneration = 0;
    const commitSettledWindow = () => {
      settleTimer = null;
      const generation = ++hydrationGeneration;
      const desiredBlockIds = new Set(observedVisibleBlockIds);
      const pendingBlockIds = [...desiredBlockIds].filter((blockId) => !dynamicVisibleBlockIdsRef.current.has(blockId));
      const mountNextChunk = () => {
        if (generation !== hydrationGeneration) return;
        const chunk = pendingBlockIds.splice(0, 2);
        if (chunk.length === 0) {
          dynamicVisibleBlockIdsRef.current = desiredBlockIds;
          setDynamicVisibleBlockIds(desiredBlockIds);
          hydrationFrame = null;
          return;
        }
        const next = new Set(dynamicVisibleBlockIdsRef.current);
        for (const blockId of chunk) next.add(blockId);
        dynamicVisibleBlockIdsRef.current = next;
        setDynamicVisibleBlockIds(next);
        hydrationFrame = window.requestAnimationFrame(mountNextChunk);
      };
      mountNextChunk();
    };
    const observer = new IntersectionObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const blockId = (entry.target as HTMLElement).dataset.blockId;
        if (!blockId) continue;
        if (entry.isIntersecting) {
          if (!observedVisibleBlockIds.has(blockId)) {
            observedVisibleBlockIds.add(blockId);
            changed = true;
          }
        } else if (observedVisibleBlockIds.delete(blockId)) {
          changed = true;
        }
      }
      if (!changed) return;
      hydrationGeneration += 1;
      if (hydrationFrame !== null) {
        window.cancelAnimationFrame(hydrationFrame);
        hydrationFrame = null;
      }
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(commitSettledWindow, 90);
    }, {
      root,
      rootMargin: `${performanceLabOverscanPx}px 0px`,
      threshold: 0
    });

    for (const element of blockElementsRef.current.values()) observer.observe(element);
    return () => {
      if (settleTimer !== null) clearTimeout(settleTimer);
      hydrationGeneration += 1;
      if (hydrationFrame !== null) window.cancelAnimationFrame(hydrationFrame);
      observer.disconnect();
    };
  }, [dynamicEditorWindowingLab, markdownBlockIds]);

  useEffect(() => {
    if (!virtualBlockWindowingLab) return;
    const root = editorScrollerRef.current;
    if (!root) return;
    let rangeFrame: number | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let hydrationFrame: number | null = null;
    let generation = 0;

    const hydrateRange = (range: VirtualBlockRange) => {
      const currentGeneration = ++generation;
      const desiredBlockIds = document.markdownBlocks
        .slice(range.start, range.end)
        .map((block) => block.blockId);
      const nextIds = new Set<string>();
      const pending = [...desiredBlockIds];
      const mountNextChunk = () => {
        if (currentGeneration !== generation) return;
        for (const blockId of pending.splice(0, 2)) nextIds.add(blockId);
        setVirtualHydratedBlockIds(new Set(nextIds));
        if (pending.length > 0) hydrationFrame = window.requestAnimationFrame(mountNextChunk);
        else hydrationFrame = null;
      };
      mountNextChunk();
    };

    const updateRange = () => {
      rangeFrame = null;
      const visibleRange = findPerformanceLabVirtualRange({
        layout: virtualBlockLayout,
        scrollTop: root.scrollTop,
        viewportHeight: root.clientHeight,
        overscanPx: performanceLabOverscanPx,
        itemCount: document.markdownBlocks.length
      });
      const nextRange = expandPerformanceLabVirtualRange(visibleRange, document.markdownBlocks.length);
      setVirtualBlockRange((current) => (
        current.start === nextRange.start && current.end === nextRange.end ? current : nextRange
      ));
      generation += 1;
      if (hydrationFrame !== null) {
        window.cancelAnimationFrame(hydrationFrame);
        hydrationFrame = null;
      }
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        hydrateRange(visibleRange);
      }, 90);
    };
    const scheduleRangeUpdate = () => {
      if (rangeFrame === null) rangeFrame = window.requestAnimationFrame(updateRange);
    };

    root.addEventListener("scroll", scheduleRangeUpdate, { passive: true });
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleRangeUpdate);
    resizeObserver?.observe(root);
    updateRange();
    return () => {
      root.removeEventListener("scroll", scheduleRangeUpdate);
      resizeObserver?.disconnect();
      if (rangeFrame !== null) window.cancelAnimationFrame(rangeFrame);
      if (settleTimer !== null) clearTimeout(settleTimer);
      generation += 1;
      if (hydrationFrame !== null) window.cancelAnimationFrame(hydrationFrame);
    };
  }, [markdownBlockIds, virtualBlockLayout, virtualBlockWindowingLab]);

  useEffect(() => {
    if (!statefulEditorWindowingLab || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const blockId = (entry.target as HTMLElement).dataset.blockId;
        if (!blockId || entry.contentRect.height <= 0) continue;
        measuredBlockHeightsRef.current.set(blockId, entry.contentRect.height);
      }
    });
    for (const element of blockElementsRef.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [markdownBlockIds, statefulEditorWindowingLab, virtualBlockRange.end, virtualBlockRange.start]);

  useEffect(() => {
    documentRef.current = document;
  }, [document]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onActiveBlockChangeRef.current = onActiveBlockChange;
  }, [onActiveBlockChange]);

  useEffect(() => {
    onCaretLocationChangeRef.current = onCaretLocationChange;
  }, [onCaretLocationChange]);

  useEffect(() => {
    onProtectedSpanUnlockableChangeRef.current = onProtectedSpanUnlockableChange;
  }, [onProtectedSpanUnlockableChange]);

  useEffect(() => {
    onProtectedSpanUnlockedRef.current = onProtectedSpanUnlocked;
  }, [onProtectedSpanUnlocked]);

  useEffect(() => {
    onSelectionLockableChangeRef.current = onSelectionLockableChange;
  }, [onSelectionLockableChange]);

  useEffect(() => {
    onSelectionLockedRef.current = onSelectionLocked;
  }, [onSelectionLocked]);

  useEffect(() => {
    onSourceReferenceClickRef.current = onSourceReferenceClick;
  }, [onSourceReferenceClick]);

  useEffect(() => {
    onDeleteBlockRequestRef.current = onDeleteBlockRequest;
  }, [onDeleteBlockRequest]);

  useEffect(() => {
    const placeCaretUnderTopDragRegion = (event: Event) => {
      const detail = (event as CustomEvent<SourceTopEdgeClickDetail>).detail;
      if (!detail || !Number.isFinite(detail.clientX) || !Number.isFinite(detail.clientY)) return;

      const target = findEditorCaretTargetAtPoint(editorViewsRef.current, detail);
      if (target) {
        target.view.dispatch({ selection: { anchor: target.position } });
        target.view.focus();
        const block = documentRef.current.markdownBlocks.find((candidate) => candidate.blockId === target.blockId);
        if (!block) return;
        activeBlockIdRef.current = target.blockId;
        onActiveBlockChangeRef.current(block);
        notifyCaretLocation(block, target.view);
        onSelectionLockableChangeRef.current(!target.view.state.selection.main.empty);
        onProtectedSpanUnlockableChangeRef.current(Boolean(findUnlockableProtectedSpan(target.view.state)));
      }
    };

    window.addEventListener("mathnotes:source-top-edge-click", placeCaretUnderTopDragRegion);
    return () => window.removeEventListener("mathnotes:source-top-edge-click", placeCaretUnderTopDragRegion);
  }, []);

  useEffect(() => {
    if (!locatingRequest) {
      return;
    }

    const element = blockElementsRef.current.get(locatingRequest.blockId);
    if (!element) {
      if (virtualBlockWindowingLab) {
        const targetIndex = document.markdownBlocks.findIndex((block) => block.blockId === locatingRequest.blockId);
        const root = editorScrollerRef.current;
        if (targetIndex >= 0 && root) {
          const start = Math.max(0, targetIndex - 2);
          const end = Math.min(document.markdownBlocks.length, targetIndex + 3);
          setVirtualBlockRange({ start, end });
          setVirtualHydratedBlockIds(new Set(document.markdownBlocks.slice(start, end).map((block) => block.blockId)));
          root.scrollTop = virtualBlockLayout.offsets[targetIndex] ?? 0;
        }
      }
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      scrollSourceBlockIntoView(element, locatingRequest.lineInBlock, locatingRequest.lineCount);
      const view = editorViewsRef.current.get(locatingRequest.blockId);
      if (!view || !locatingRequest.lineInBlock || locatingRequest.lineInBlock <= 1) {
        return;
      }

      const targetLineNumber = Math.min(locatingRequest.lineInBlock, view.state.doc.lines);
      const targetLine = view.state.doc.line(targetLineNumber);
      view.dispatch({
        effects: EditorView.scrollIntoView(targetLine.from, { y: "center" })
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    locatingRequest?.blockId,
    locatingRequest?.lineCount,
    locatingRequest?.lineInBlock,
    locatingRequest?.nonce,
    locatingMountEpoch,
    virtualBlockRange.end,
    virtualBlockRange.start,
    virtualBlockWindowingLab,
    virtualBlockLayout
  ]);

  useEffect(() => {
    if (!insertMarkdownRequest || lastInsertMarkdownRequestRef.current === insertMarkdownRequest.id) {
      return;
    }
    lastInsertMarkdownRequestRef.current = insertMarkdownRequest.id;

    const view = getActiveView(activeBlockIdRef, editorViewsRef);
    if (!view) {
      return;
    }

    const selection = view.state.selection.main;
    const from = Math.min(selection.from, selection.to);
    const to = Math.max(selection.from, selection.to);
    const prefix = from > 0 && !view.state.doc.sliceString(Math.max(0, from - 1), from).endsWith("\n") ? "\n\n" : "";
    const suffix = to < view.state.doc.length && !view.state.doc.sliceString(to, Math.min(view.state.doc.length, to + 1)).startsWith("\n") ? "\n\n" : "";
    const insert = `${prefix}${insertMarkdownRequest.markdown}${suffix}`;

    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length }
    });
    view.focus();
  }, [insertMarkdownRequest]);

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (lastLockSelectionRequestRef.current === lockSelectionRequest) {
      return;
    }
    lastLockSelectionRequestRef.current = lockSelectionRequest;

    const view = getActiveView(activeBlockIdRef, editorViewsRef);
    if (!view || view.state.selection.main.empty) {
      return;
    }

    const selection = view.state.selection.main;
    const from = Math.min(selection.from, selection.to);
    const to = Math.max(selection.from, selection.to);
    const selected = view.state.doc.sliceString(from, to);

    void wrapProtectedSpan({
      markdown: selected,
      id: createLockId()
    }).then((locked) => {
      const currentView = getActiveView(activeBlockIdRef, editorViewsRef);
      if (!currentView) {
        return;
      }
      currentView.dispatch({
        changes: { from, to, insert: locked },
        selection: { anchor: from, head: from + locked.length }
      });
      onSelectionLockedRef.current();
    });
  }, [lockSelectionRequest]);

  useEffect(() => {
    if (lastUnlockProtectedSpanRequestRef.current === unlockProtectedSpanRequest) {
      return;
    }
    lastUnlockProtectedSpanRequestRef.current = unlockProtectedSpanRequest;

    const view = getActiveView(activeBlockIdRef, editorViewsRef);
    if (!view) {
      return;
    }

    const span = findUnlockableProtectedSpan(view.state);
    if (!span) {
      return;
    }

    view.dispatch({
      changes: { from: span.from, to: span.to, insert: span.content },
      selection: { anchor: span.from, head: span.from + span.content.length }
    });
    onProtectedSpanUnlockedRef.current();
  }, [unlockProtectedSpanRequest]);

  function handleMarkdownChange(blockId: string, markdown: string) {
    const nextMarkdowns = {
      ...markdownByBlockIdRef.current,
      [blockId]: markdown
    };
    markdownByBlockIdRef.current = nextMarkdowns;
    pendingEditedBlockIdsRef.current.add(blockId);
    if (pendingMarkdownChangeFrameRef.current !== null) {
      return;
    }
    pendingMarkdownChangeFrameRef.current = window.requestAnimationFrame(() => {
      pendingMarkdownChangeFrameRef.current = null;
      const nextValue = buildSourceTextFromBlockMarkdowns(
        documentRef.current.markdownBlocks,
        markdownByBlockIdRef.current
      );
      lastLocalProjectionRef.current = {
        blockIds: documentRef.current.markdownBlocks.map((block) => block.blockId).join("\u0000"),
        markdownByBlockId: markdownByBlockIdRef.current,
        value: nextValue
      };
      const editedBlockIds = [...pendingEditedBlockIdsRef.current];
      pendingEditedBlockIdsRef.current.clear();
      onChangeRef.current(nextValue, {
        editedBlockIds,
        markdownByBlockId: markdownByBlockIdRef.current
      });
    });
  }

  useEffect(() => () => {
    if (pendingMarkdownChangeFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingMarkdownChangeFrameRef.current);
    }
  }, []);

  useEffect(() => {
    const existing = new Set(document.markdownBlocks.map((block) => block.blockId));
    setSelectedBlockIds((current) => {
      const next = new Set([...current].filter((id) => existing.has(id)));
      if (next.size === 0) setSelectionMode(false);
      return next.size === current.size ? current : next;
    });
  }, [document.markdownBlocks]);

  function toggleBlockSelection(blockId: string) {
    setSelectedBlockIds((current) => {
      const next = new Set(current);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      setSelectionMode(next.size > 0);
      return next;
    });
  }

  function beginBlockSelection(blockId: string) {
    setSelectedBlockIds(new Set([blockId]));
    setSelectionMode(true);
    setContextMenu(null);
  }

  function cancelBlockSelection() {
    setSelectedBlockIds(new Set());
    setSelectionMode(false);
  }

  function handleSelectionChange(block: SessionSourceMarkdownBlock, view: EditorView) {
    activeBlockIdRef.current = block.blockId;
    if (statefulEditorWindowingLab) setActiveWindowBlockId(block.blockId);
    onActiveBlockChangeRef.current(block);
    notifyCaretLocation(block, view);
    onSelectionLockableChangeRef.current(!view.state.selection.main.empty);
    onProtectedSpanUnlockableChangeRef.current(Boolean(findUnlockableProtectedSpan(view.state)));
  }

  function notifyCaretLocation(block: SessionSourceMarkdownBlock, view: EditorView) {
    onCaretLocationChangeRef.current?.({
      blockId: block.blockId,
      sourceId: block.sourceId,
      displayBlockId: block.blockId,
      lineInBlock: view.state.doc.lineAt(view.state.selection.main.head).number,
      lineCount: view.state.doc.lines
    });
  }

  function handleViewReady(blockId: string, view: EditorView | null) {
    if (view) {
      editorViewsRef.current.set(blockId, view);
      return;
    }
    editorViewsRef.current.delete(blockId);
  }

  function handleSourceHeaderClick(block: SessionSourceMarkdownBlock) {
    onSourceReferenceClickRef.current({
      kind: "source",
      target: block.header,
      assetPath: block.sourceAssetPath,
      blockId: block.blockId,
      sourcePageNumber: block.sourcePageNumber
    });
  }

  function handleMarkdownAssetClick(block: SessionSourceMarkdownBlock, target: string) {
    onSourceReferenceClickRef.current({
      kind: "asset",
      target,
      blockId: block.blockId
    });
  }

  function requestDeleteBlock(block: SessionSourceMarkdownBlock) {
    const confirmed = window.confirm(`删除整个 Markdown block ${block.blockId}？\n\n这会从当前 Session 中移除该块，但不会删除原始图片素材。`);
    if (confirmed) {
      onDeleteBlockRequestRef.current(block.blockId);
    }
  }

  function handleEditorStateSnapshot(blockId: string, snapshot: EditorStateSnapshot) {
    if (!statefulEditorWindowingLab) return;
    editorStateCacheRef.current.set(blockId, snapshot);
  }

  async function runContextCommand(command: "copy" | "cut" | "paste" | "undo" | "redo" | "selectAll" | "foldAll" | "unfoldAll") {
    const menu = contextMenu;
    if (!menu || menu.kind !== "editor") return;
    const { view } = menu;
    setContextMenu(null);
    view.focus();
    const selection = view.state.selection.main;
    if (command === "undo") return void undo(view);
    if (command === "redo") return void redo(view);
    if (command === "foldAll") return void foldAll(view);
    if (command === "unfoldAll") return void unfoldAll(view);
    if (command === "selectAll") {
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
      return;
    }
    if (command === "copy" || command === "cut") {
      if (selection.empty) return;
      await navigator.clipboard.writeText(view.state.doc.sliceString(selection.from, selection.to));
      if (command === "cut") view.dispatch({ changes: { from: selection.from, to: selection.to, insert: "" } });
      return;
    }
    const pasted = await navigator.clipboard.readText();
    if (pasted) {
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: pasted },
        selection: { anchor: selection.from + pasted.length }
      });
    }
  }

  const renderedBlocks = virtualBlockWindowingLab
    ? document.markdownBlocks.slice(virtualBlockRange.start, virtualBlockRange.end)
    : document.markdownBlocks;
  const virtualTopSpacer = virtualBlockWindowingLab
    ? virtualBlockLayout.offsets[virtualBlockRange.start] ?? 0
    : 0;
  const virtualRenderedEnd = virtualBlockRange.end > 0
    ? (virtualBlockLayout.offsets[virtualBlockRange.end - 1] ?? 0) + (virtualBlockLayout.sizes[virtualBlockRange.end - 1] ?? 0)
    : 0;
  const virtualBottomSpacer = virtualBlockWindowingLab
    ? Math.max(0, virtualBlockLayout.totalSize - virtualRenderedEnd)
    : 0;

  const locatingBlockIndex = locatingRequest
    ? document.markdownBlocks.findIndex((block) => block.blockId === locatingRequest.blockId)
    : -1;

  const renderSourceBlock = (
    block: SessionSourceMarkdownBlock,
    blockIndex: number,
    measureElement?: RefCallback<HTMLElement>,
    virtualStyle?: CSSProperties
  ) => {
    const mountEditor =
      editorWindowingLabMode === "off" ||
      tanStackSourceWindowingLab ||
      (editorWindowingLabMode === "finite" && blockIndex < performanceLabEditorViewLimit) ||
      (dynamicEditorWindowingLab && (
        dynamicVisibleBlockIds.has(block.blockId) ||
        activeWindowBlockId === block.blockId ||
        locatingRequest?.blockId === block.blockId
      )) ||
      (virtualBlockWindowingLab && (
        virtualHydratedBlockIds.has(block.blockId) ||
        activeWindowBlockId === block.blockId ||
        locatingRequest?.blockId === block.blockId
      ));

    return (
      <SourceBlockSection
        block={block}
        assistantOpen={assistantOpen}
        displayBlockId={displayByBlockId.get(block.blockId) ?? block.blockId}
        selected={selectedBlockIds.has(block.blockId)}
        selectionMode={selectionMode}
        isLocating={block.blockId === locatingRequest?.blockId}
        locatingLine={block.blockId === locatingRequest?.blockId ? locatingRequest?.lineInBlock : undefined}
        locatingNonce={block.blockId === locatingRequest?.blockId ? locatingRequest?.nonce ?? 0 : 0}
        key={block.blockId}
        markdown={markdownByBlockId[block.blockId] ?? ""}
        cachedEditorState={statefulEditorWindowingLab ? editorStateCacheRef.current.get(block.blockId) : undefined}
        cachedHeight={statefulEditorWindowingLab && !mountEditor ? measuredBlockHeightsRef.current.get(block.blockId) : undefined}
        mountEditor={mountEditor}
        assistantRemarks={remarksByBlockId.get(block.blockId) ?? []}
        onAssistantRemarkOpen={onAssistantRemarkOpen}
        onDeleteBlockRequest={requestDeleteBlock}
        onSelectionToggle={toggleBlockSelection}
        onMarkdownAssetClick={handleMarkdownAssetClick}
        onMarkdownChange={handleMarkdownChange}
        onContextMenu={(menuBlock, view, x, y) => setContextMenu({
          kind: "editor",
          block: menuBlock,
          view,
          x: Math.max(8, Math.min(x, window.innerWidth - 226)),
          y: Math.max(8, Math.min(y, window.innerHeight - 352))
        })}
        onHeaderContextMenu={(menuBlock, x, y) => setContextMenu({
          kind: "block",
          block: menuBlock,
          x: Math.max(8, Math.min(x, window.innerWidth - 226)),
          y: Math.max(8, Math.min(y, window.innerHeight - 220))
        })}
        onSelectionChange={handleSelectionChange}
        onEditorStateSnapshot={handleEditorStateSnapshot}
        onSourceHeaderClick={handleSourceHeaderClick}
        onViewReady={handleViewReady}
        registerElement={(element) => {
          if (element) blockElementsRef.current.set(block.blockId, element);
          else blockElementsRef.current.delete(block.blockId);
          measureElement?.(element);
        }}
        virtualIndex={measureElement ? blockIndex : undefined}
        virtualStyle={virtualStyle}
      />
    );
  };

  return (
    <div
      className="session-source-editor source-block-shell"
      data-editor-windowing-lab={editorWindowingLabMode}
      data-editor-windowing-requested={requestedEditorWindowingLabMode}
      data-editor-windowing-fallback={tanStackFallbackReason ?? undefined}
      data-testid="session-source-editor"
      ref={editorScrollerRef}
    >
      {selectionMode ? (
        <div className="source-block-organize-toolbar" data-testid="source-block-organize-toolbar">
          <strong>已选 {selectedBlockIds.size} 块</strong>
          <button type="button" onClick={() => onReorderBlocksRequest?.([...selectedBlockIds], "up")}>上移</button>
          <button type="button" onClick={() => onReorderBlocksRequest?.([...selectedBlockIds], "down")}>下移</button>
          <span />
          <button type="button" onClick={() => onTransferBlocksRequest?.([...selectedBlockIds], "copy")}>复制到…</button>
          <button type="button" onClick={() => onTransferBlocksRequest?.([...selectedBlockIds], "move")}>移动到…</button>
          <button type="button" onClick={cancelBlockSelection}>取消选择</button>
        </div>
      ) : null}
      {tanStackSourceWindowingLab ? (
        <Suspense fallback={null}>
          <SourceTanStackLab
            blocks={document.markdownBlocks}
            estimateSize={(_block, index) => virtualBlockLayout.sizes[index] ?? performanceLabVirtualHeaderHeight}
            locatingIndex={locatingBlockIndex}
            locatingNonce={locatingRequest?.nonce ?? 0}
            onLocateMounted={(nonce) => {
              if (nonce === locatingRequest?.nonce) {
                setLocatingMountEpoch((current) => current + 1);
              }
            }}
            overscan={getSourceOverscanPerformanceLabValue()}
            renderItem={renderSourceBlock}
            scrollElementRef={editorScrollerRef}
          />
        </Suspense>
      ) : (
        <>
          {virtualTopSpacer > 0 ? (
            <div aria-hidden="true" data-testid="performance-virtual-spacer-top" style={{ height: `${virtualTopSpacer}px` }} />
          ) : null}
          {renderedBlocks.map((block, renderedIndex) => renderSourceBlock(
            block,
            virtualBlockWindowingLab ? virtualBlockRange.start + renderedIndex : renderedIndex
          ))}
          {virtualBottomSpacer > 0 ? (
            <div aria-hidden="true" data-testid="performance-virtual-spacer-bottom" style={{ height: `${virtualBottomSpacer}px` }} />
          ) : null}
        </>
      )}
      {contextMenu ? (
        <div
          className="editor-context-menu"
          data-testid="editor-context-menu"
          onPointerDown={(event) => event.stopPropagation()}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.kind === "editor" ? (
            <>
              <button onClick={() => void runContextCommand("copy")} type="button">复制 <kbd>Ctrl+C</kbd></button>
              <button onClick={() => void runContextCommand("cut")} type="button">剪切 <kbd>Ctrl+X</kbd></button>
              <button onClick={() => void runContextCommand("paste")} type="button">粘贴 <kbd>Ctrl+V</kbd></button>
              <span />
              <button onClick={() => void runContextCommand("undo")} type="button">撤销 <kbd>Ctrl+Z</kbd></button>
              <button onClick={() => void runContextCommand("redo")} type="button">重做 <kbd>Ctrl+Y</kbd></button>
              <button onClick={() => void runContextCommand("selectAll")} type="button">全选 <kbd>Ctrl+A</kbd></button>
              <span />
              <button onClick={() => void runContextCommand("foldAll")} type="button">收起全部</button>
              <button onClick={() => void runContextCommand("unfoldAll")} type="button">展开全部</button>
              <span />
              <button
                disabled={contextMenu.block.locked || contextMenu.view.state.selection.main.empty}
                onClick={() => {
                  const selection = contextMenu.view.state.selection.main;
                  const selectedText = contextMenu.view.state.doc.sliceString(selection.from, selection.to);
                  const blockId = contextMenu.block.blockId;
                  setContextMenu(null);
                  onAiSelectionEditRequest?.({
                    blockId,
                    from: selection.from,
                    to: selection.to,
                    selectedText
                  });
                }}
                type="button"
              >
                用 AI 修改选中文字
              </button>
              <span />
            </>
          ) : null}
          <button
            onClick={() => {
              const blockId = contextMenu.block.blockId;
              setContextMenu(null);
              onCreateBlockAfterRequest?.(blockId);
            }}
            type="button"
          >
            在下方新建文本块
          </button>
          {!selectionMode ? (
            <button onClick={() => beginBlockSelection(contextMenu.block.blockId)} type="button">
              多选块
            </button>
          ) : (
            <button onClick={() => {
              toggleBlockSelection(contextMenu.block.blockId);
              setContextMenu(null);
            }} type="button">
              {selectedBlockIds.has(contextMenu.block.blockId) ? "取消选择这个块" : "选择这个块"}
            </button>
          )}
          <button
            onClick={() => {
              const blockId = contextMenu.block.blockId;
              setContextMenu(null);
              onRerecognizeBlockRequest?.(blockId);
            }}
            type="button"
          >
            重新识别这个块
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function groupAssistantRemarksByBlockId(remarks: AssistantRemark[]): Map<string, AssistantRemark[]> {
  const grouped = new Map<string, AssistantRemark[]>();
  for (const remark of remarks) {
    const blockId = remark.focus.blockId;
    if (!blockId || (remark.focus.kind !== "block" && remark.focus.kind !== "selection")) continue;
    grouped.set(blockId, [...(grouped.get(blockId) ?? []), remark]);
  }
  return grouped;
}

function SourceBlockSection({
  block,
  assistantOpen,
  cachedEditorState,
  cachedHeight,
  displayBlockId,
  selected,
  selectionMode,
  markdown,
  mountEditor,
  registerElement,
  onDeleteBlockRequest,
  onSelectionToggle,
  onMarkdownAssetClick,
  onMarkdownChange,
  onContextMenu,
  onHeaderContextMenu,
  onEditorStateSnapshot,
  onSelectionChange,
  onSourceHeaderClick,
  onViewReady,
  assistantRemarks,
  onAssistantRemarkOpen,
  isLocating,
  locatingLine,
  locatingNonce,
  virtualIndex,
  virtualStyle
}: {
  block: SessionSourceMarkdownBlock;
  assistantOpen: boolean;
  cachedEditorState?: EditorStateSnapshot;
  cachedHeight?: number;
  displayBlockId: string;
  selected: boolean;
  selectionMode: boolean;
  markdown: string;
  mountEditor: boolean;
  isLocating: boolean;
  locatingLine?: number;
  locatingNonce: number;
  virtualIndex?: number;
  virtualStyle?: CSSProperties;
  assistantRemarks: AssistantRemark[];
  onAssistantRemarkOpen?: (remarkId: string) => void;
  registerElement: (element: HTMLElement | null) => void;
  onDeleteBlockRequest: (block: SessionSourceMarkdownBlock) => void;
  onSelectionToggle: (blockId: string) => void;
  onMarkdownAssetClick: (block: SessionSourceMarkdownBlock, target: string) => void;
  onMarkdownChange: (blockId: string, markdown: string) => void;
  onContextMenu: (block: SessionSourceMarkdownBlock, view: EditorView, x: number, y: number) => void;
  onHeaderContextMenu: (block: SessionSourceMarkdownBlock, x: number, y: number) => void;
  onEditorStateSnapshot?: (blockId: string, snapshot: EditorStateSnapshot) => void;
  onSelectionChange: (block: SessionSourceMarkdownBlock, view: EditorView) => void;
  onSourceHeaderClick: (block: SessionSourceMarkdownBlock) => void;
  onViewReady: (blockId: string, view: EditorView | null) => void;
}) {
  return (
        <section
          className={[
            "source-block",
            selected ? "selected" : undefined,
            isLocating ? "locating" : undefined,
            isLocating ? (locatingNonce % 2 === 0 ? "locating-even" : "locating-odd") : undefined
          ].filter(Boolean).join(" ")}
          data-testid="source-block"
          data-block-id={block.blockId}
          data-locked={block.locked ? "true" : "false"}
          data-locating-nonce={locatingNonce || undefined}
          data-source={block.sourceId}
          data-index={virtualIndex}
          ref={registerElement}
          style={{
            ...(cachedHeight ? { minHeight: `${Math.ceil(cachedHeight)}px` } : {}),
            ...virtualStyle
          }}
        >
          <div
            className="source-block-header"
            data-testid="source-block-header"
            role="button"
            draggable={assistantOpen}
            tabIndex={0}
            title={`source: ${block.header}\ndisplay block: ${displayBlockId}\ninternal block: ${block.blockId}\npath: ${block.path}\nkind: ${block.source}`}
            onClick={() => onSourceHeaderClick(block)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onHeaderContextMenu(block, event.clientX, event.clientY);
            }}
            onDragStart={(event) => {
              if (!assistantOpen) return;
              writeAssistantDragPayload(event.dataTransfer, {
                kind: "block",
                blockId: block.blockId,
                label: `block ${displayBlockId} · ${block.header}`
              });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSourceHeaderClick(block);
              }
              if (event.key === "Backspace" || event.key === "Delete") {
                event.preventDefault();
                onDeleteBlockRequest(block);
              }
            }}
          >
            {selectionMode ? (
              <input
                aria-label={`${selected ? "取消选择" : "选择"} block ${displayBlockId}`}
                checked={selected}
                className="source-block-select"
                type="checkbox"
                onClick={(event) => {
                  event.stopPropagation();
                }}
                onChange={() => onSelectionToggle(block.blockId)}
              />
            ) : null}
            <span>source: {block.header}</span>
            <strong>block: {displayBlockId}</strong>
            {assistantRemarks.length > 0 ? (
              <button
                aria-label={`查看 block ${displayBlockId} 的 ${assistantRemarks.length} 条 AI 旁注`}
                className="source-block-remarks"
                title={`${assistantRemarks.length} 条 AI 旁注`}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onAssistantRemarkOpen?.(assistantRemarks[assistantRemarks.length - 1].id);
                }}
              >
                <BookOpenText />
                <span>{assistantRemarks.length}</span>
              </button>
            ) : null}
            <button
              aria-label={`删除 block ${displayBlockId}`}
              className="source-block-delete"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onDeleteBlockRequest(block);
              }}
            >
              ×
            </button>
          </div>
          {mountEditor ? (
            <BlockMarkdownEditor
              block={block}
              assistantOpen={assistantOpen}
              locatingLineRequest={
                isLocating
                  ? {
                      lineInBlock: locatingLine,
                      nonce: locatingNonce
                    }
                  : undefined
              }
              markdown={markdown}
              cachedEditorState={cachedEditorState}
              onAssetReferenceClick={onMarkdownAssetClick}
              onEditorStateSnapshot={onEditorStateSnapshot}
              onMarkdownChange={onMarkdownChange}
              onContextMenu={onContextMenu}
              onSelectionChange={onSelectionChange}
              onViewReady={onViewReady}
            />
          ) : (
            <StaticMarkdownSource markdown={markdown} />
          )}
        </section>
  );
}

function StaticMarkdownSource({ markdown }: { markdown: string }) {
  const lineNumbers = useMemo(
    () => Array.from({ length: Math.max(1, markdown.split("\n").length) }, (_, index) => String(index + 1)).join("\n"),
    [markdown]
  );

  return (
    <div className="performance-static-source" data-testid="performance-static-source">
      <pre aria-hidden="true" className="performance-static-source-lines">{lineNumbers}</pre>
      <pre className="performance-static-source-code">{markdown || " "}</pre>
    </div>
  );
}

function BlockMarkdownEditor({
  block,
  assistantOpen,
  cachedEditorState,
  locatingLineRequest,
  markdown,
  onAssetReferenceClick,
  onEditorStateSnapshot,
  onMarkdownChange,
  onContextMenu,
  onSelectionChange,
  onViewReady
}: BlockMarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const blockRef = useRef(block);
  const markdownRef = useRef(markdown);
  const onAssetReferenceClickRef = useRef(onAssetReferenceClick);
  const onMarkdownChangeRef = useRef(onMarkdownChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onContextMenuRef = useRef(onContextMenu);
  const assistantOpenRef = useRef(assistantOpen);
  const applyingExternalMarkdownRef = useRef(false);
  const lastLocalEditAtRef = useRef(Number.NEGATIVE_INFINITY);
  const selectionPointerDownRef = useRef(false);
  const selectionFrameRequestRef = useRef<number | null>(null);
  const selectionFinalizeFrameRef = useRef<number | null>(null);
  const selectionFrameElementRef = useRef<HTMLDivElement>(null);
  const [selectionFrame, setSelectionFrame] = useState<AssistantSelectionFrame | null>(null);

  useEffect(() => {
    blockRef.current = block;
  }, [block]);

  useEffect(() => {
    onAssetReferenceClickRef.current = onAssetReferenceClick;
  }, [onAssetReferenceClick]);

  useEffect(() => {
    onMarkdownChangeRef.current = onMarkdownChange;
  }, [onMarkdownChange]);

  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  useEffect(() => {
    onContextMenuRef.current = onContextMenu;
  }, [onContextMenu]);

  useEffect(() => {
    assistantOpenRef.current = assistantOpen;
    if (!assistantOpen) {
      setSelectionFrame(null);
    } else if (viewRef.current) {
      scheduleAssistantSelectionFrame(viewRef.current);
    }
  }, [assistantOpen]);

  function scheduleAssistantSelectionFrame(view: EditorView) {
    if (selectionFrameRequestRef.current !== null) {
      window.cancelAnimationFrame(selectionFrameRequestRef.current);
    }
    selectionFrameRequestRef.current = window.requestAnimationFrame(() => {
      selectionFrameRequestRef.current = null;
      if (!assistantOpenRef.current || selectionPointerDownRef.current || !hostRef.current) {
        setSelectionFrame(null);
        return;
      }
      const selection = view.state.selection.main;
      if (selection.empty) {
        setSelectionFrame(null);
        return;
      }
      const from = Math.min(selection.from, selection.to);
      const to = Math.max(selection.from, selection.to);
      const start = view.coordsAtPos(from);
      const end = view.coordsAtPos(to);
      const content = view.contentDOM.getBoundingClientRect();
      const host = hostRef.current.getBoundingClientRect();
      if (!start || !end) {
        setSelectionFrame(null);
        return;
      }
      const multiline = start.top !== end.top;
      const left = (multiline ? content.left : Math.min(start.left, end.left)) - host.left;
      const right = (multiline ? content.right : Math.max(start.right, end.right)) - host.left;
      setSelectionFrame({
        left: Math.max(0, left - 4),
        top: Math.max(0, start.top - host.top - 3),
        width: Math.max(12, right - left + 8),
        height: Math.max(18, end.bottom - start.top + 6),
        text: view.state.doc.sliceString(from, to),
        from,
        to
      });
    });
  }

  function finalizeNativeSelection(view: EditorView) {
    if (selectionFinalizeFrameRef.current !== null) {
      window.cancelAnimationFrame(selectionFinalizeFrameRef.current);
    }
    selectionFinalizeFrameRef.current = window.requestAnimationFrame(() => {
      selectionFinalizeFrameRef.current = null;
      selectionPointerDownRef.current = false;
      if (selectionFrameElementRef.current) {
        selectionFrameElementRef.current.style.visibility = "";
      }
      onSelectionChangeRef.current(blockRef.current, view);
      scheduleAssistantSelectionFrame(view);
    });
  }

  function writeSelectionDrag(event: React.DragEvent<HTMLElement>) {
    if (!selectionFrame || !event.dataTransfer) return;
    writeAssistantDragPayload(event.dataTransfer, {
      kind: "selection",
      blockId: blockRef.current.blockId,
      label: `选区 · block ${blockRef.current.blockId}`,
      text: selectionFrame.text,
      from: selectionFrame.from,
      to: selectionFrame.to
    });
  }

  useEffect(() => {
    if (!hostRef.current) {
      return;
    }

    const extensions = [
          blockEditorSetup,
          markdownLanguage(),
          EditorView.lineWrapping,
          blockEditorTheme,
          locatedLineHighlighter,
          protectedSpanHighlighter,
          EditorView.domEventHandlers({
            pointerdown: () => {
              selectionPointerDownRef.current = true;
              if (selectionFrameElementRef.current) {
                selectionFrameElementRef.current.style.visibility = "hidden";
              }
              return false;
            },
            pointerup: (_event, view) => {
              finalizeNativeSelection(view);
              return false;
            },
            pointercancel: () => {
              selectionPointerDownRef.current = false;
              if (selectionFrameElementRef.current) {
                selectionFrameElementRef.current.style.visibility = "";
              }
              return false;
            },
            click: (event, view) => {
              const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
              if (position === null) {
                return false;
              }

              const reference = findMarkdownImageReferenceAtPosition(view.state.doc.toString(), position);
              if (!reference) {
                return false;
              }

              event.preventDefault();
              event.stopPropagation();
              onAssetReferenceClickRef.current(blockRef.current, reference.target);
              return true;
            },
            focus: (_event, view) => {
              onSelectionChangeRef.current(blockRef.current, view);
              return false;
            },
            contextmenu: (event, view) => {
              event.preventDefault();
              const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
              if (position !== null && view.state.selection.main.empty) {
                view.dispatch({ selection: { anchor: position } });
              }
              onContextMenuRef.current(blockRef.current, view, event.clientX, event.clientY);
              return true;
            },
            drop: (event) => {
              if (!event.dataTransfer?.types.includes(assistantDragMime)) return false;
              event.preventDefault();
              return true;
            }
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !applyingExternalMarkdownRef.current) {
              const nextMarkdown = update.state.doc.toString();
              lastLocalEditAtRef.current = window.performance.now();
              markdownRef.current = nextMarkdown;
              onMarkdownChangeRef.current(blockRef.current.blockId, nextMarkdown);
            }
            if (update.docChanged || (update.selectionSet && !selectionPointerDownRef.current)) {
              onSelectionChangeRef.current(blockRef.current, update.view);
            }
            if (
              !selectionPointerDownRef.current &&
              (update.selectionSet || update.docChanged)
            ) {
              scheduleAssistantSelectionFrame(update.view);
            }
          })
        ];
    lastLocalEditAtRef.current = cachedEditorState?.lastLocalEditAt ?? Number.NEGATIVE_INFINITY;
    let editorState = cachedEditorState?.state;
    if (editorState) {
      editorState = editorState.update({ effects: StateEffect.reconfigure.of(extensions) }).state;
      if (editorState.doc.toString() !== markdownRef.current) {
        editorState = editorState.update({
          annotations: Transaction.addToHistory.of(false),
          changes: { from: 0, to: editorState.doc.length, insert: markdownRef.current }
        }).state;
      }
    } else {
      editorState = EditorState.create({
        doc: markdownRef.current,
        extensions
      });
    }

    const view = new EditorView({
      parent: hostRef.current,
      state: editorState
    });

    viewRef.current = view;
    onViewReady(block.blockId, view);

    const finishPointerGesture = (event: PointerEvent) => {
      if (!selectionPointerDownRef.current || event.pointerType === "touch") {
        return;
      }
      finalizeNativeSelection(view);
    };
    window.addEventListener("pointerup", finishPointerGesture, true);
    window.addEventListener("pointercancel", finishPointerGesture, true);

    return () => {
      if (selectionFrameRequestRef.current !== null) {
        window.cancelAnimationFrame(selectionFrameRequestRef.current);
      }
      if (selectionFinalizeFrameRef.current !== null) {
        window.cancelAnimationFrame(selectionFinalizeFrameRef.current);
      }
      window.removeEventListener("pointerup", finishPointerGesture, true);
      window.removeEventListener("pointercancel", finishPointerGesture, true);
      onEditorStateSnapshot?.(block.blockId, {
        state: view.state,
        lastLocalEditAt: lastLocalEditAtRef.current
      });
      onViewReady(block.blockId, null);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      markdownRef.current = markdown;
      return;
    }

    const currentMarkdown = view.state.doc.toString();
    if (!shouldApplyExternalMarkdown({
      currentMarkdown,
      externalMarkdown: markdown,
      hasFocus: view.hasFocus,
      lastLocalEditAt: lastLocalEditAtRef.current,
      now: window.performance.now()
    })) {
      if (currentMarkdown === markdown) {
        markdownRef.current = markdown;
      }
      return;
    }

    applyingExternalMarkdownRef.current = true;
    try {
      view.dispatch({
        annotations: Transaction.addToHistory.of(true),
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: markdown
        }
      });
      markdownRef.current = markdown;
    } finally {
      applyingExternalMarkdownRef.current = false;
    }
  }, [markdown]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    view.dispatch({
      effects: setLocatedLineEffect.of(locatingLineRequest?.lineInBlock ?? null)
    });
  }, [locatingLineRequest?.lineInBlock, locatingLineRequest?.nonce]);

  return (
    <div className="source-block-editor-shell">
      <div className="source-block-editor" data-testid="source-block-editor" ref={hostRef} />
      {assistantOpen && selectionFrame ? (
        <div
          aria-label="拖动所选文字到 AI 学习助手"
          className="assistant-selection-frame"
          data-testid="assistant-selection-frame"
          ref={selectionFrameElementRef}
          style={{
            left: selectionFrame.left,
            top: selectionFrame.top,
            width: selectionFrame.width,
            height: selectionFrame.height
          }}
        >
          {["top", "right", "bottom", "left"].map((edge) => (
            <span
              className={`assistant-selection-drag-edge ${edge}`}
              draggable
              key={edge}
              onDragStart={writeSelectionDrag}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function getActiveView(
  activeBlockIdRef: MutableRefObject<string | null>,
  editorViewsRef: MutableRefObject<Map<string, EditorView>>
): EditorView | null {
  return activeBlockIdRef.current ? editorViewsRef.current.get(activeBlockIdRef.current) ?? null : null;
}

function scrollSourceBlockIntoView(element: HTMLElement, lineInBlock: number | undefined, lineCount: number | undefined) {
  const editor = element.closest<HTMLElement>(".session-source-editor");
  if (!editor) {
    element.scrollIntoView({ behavior: "auto", block: "center" });
    return;
  }

  const blockRatio =
    lineInBlock && lineCount && lineCount > 1
      ? Math.max(0, Math.min(1, (lineInBlock - 1) / (lineCount - 1)))
      : 0.18;
  const targetOffset = element.offsetTop + element.offsetHeight * blockRatio - editor.clientHeight * 0.38;
  editor.scrollTo({
    top: Math.max(0, targetOffset),
    behavior: "auto"
  });
}

function findUnlockableProtectedSpan(state: EditorState) {
  const text = state.doc.toString();
  const selection = state.selection.main;
  return (
    findProtectedSpanCoveringSelection(text, selection.from, selection.to) ??
    findProtectedSpanAtPosition(text, selection.head)
  );
}

function createLockId(): string {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `lock_${stamp}_${suffix}`;
}

function markdownLanguage() {
  return markdown();
}

const blockEditorSetup = [
  codeFolding({
    placeholderText: "…"
  }),
  foldGutter({
    openText: "⌄",
    closedText: "›"
  }),
  lineNumbers(),
  highlightActiveLineGutter(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  rectangularSelection(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab, ...lintKeymap])
];

const lockSpanBodyDecoration = Decoration.mark({ class: "cm-lockSpanBody" });
const lockSpanBoundaryDecoration = Decoration.line({ class: "cm-lockSpanBoundary" });

const protectedSpanHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildProtectedSpanDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildProtectedSpanDecorations(update.view);
      }
    }
  },
  {
    decorations: (value) => value.decorations
  }
);

function buildProtectedSpanDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const visibleFrom = view.visibleRanges[0]?.from ?? 0;
  const visibleTo = view.visibleRanges.at(-1)?.to ?? view.state.doc.length;

  for (const span of findProtectedSpanRanges(view.state.doc.toString())) {
    if (span.to < visibleFrom || span.from > visibleTo) {
      continue;
    }

    const startLine = view.state.doc.lineAt(span.from);
    const endLine = view.state.doc.lineAt(span.to);
    builder.add(startLine.from, startLine.from, lockSpanBoundaryDecoration);
    if (span.contentFrom < span.contentTo) {
      builder.add(span.contentFrom, span.contentTo, lockSpanBodyDecoration);
    }
    if (endLine.from > startLine.from) {
      builder.add(endLine.from, endLine.from, lockSpanBoundaryDecoration);
    }
  }

  return builder.finish();
}

const setLocatedLineEffect = StateEffect.define<number | null>();

const locatedLineHighlighter = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, transaction) {
    let nextDecorations = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setLocatedLineEffect)) {
        continue;
      }

      const lineNumber = effect.value;
      if (!lineNumber || lineNumber < 1) {
        nextDecorations = Decoration.none;
        continue;
      }

      const targetLine = transaction.state.doc.line(Math.min(lineNumber, transaction.state.doc.lines));
      nextDecorations = Decoration.set([
        Decoration.line({
          class: "cm-previewLocatedLine"
        }).range(targetLine.from)
      ]);
    }
    return nextDecorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});

const blockEditorTheme = EditorView.theme({
  "&": {
    height: "auto",
    color: "#2f2f2b",
    backgroundColor: "transparent",
    fontSize: "var(--source-font-size, 13px)"
  },
  ".cm-scroller": {
    overflow: "visible",
    fontFamily: "var(--source-font-family)",
    lineHeight: "1.72"
  },
  ".cm-content": {
    padding: "2px 10px 6px 0",
    minHeight: "30px"
  },
  ".cm-line, .cm-line *": {
    fontSize: "inherit"
  },
  ".cm-gutters": {
    backgroundColor: "rgba(31, 32, 29, 0.025)",
    color: "#aaa59c",
    borderRight: "1px solid rgba(31, 32, 29, 0.06)"
  },
  ".cm-foldGutter": {
    width: "20px"
  },
  ".cm-foldGutter .cm-gutterElement": {
    display: "grid",
    placeItems: "center",
    color: "#9c978e",
    cursor: "pointer",
    fontSize: "calc(var(--source-font-size, 13px) * 0.9)"
  },
  ".cm-foldPlaceholder": {
    border: "1px solid rgba(31, 32, 29, 0.08)",
    borderRadius: "6px",
    background: "rgba(38, 122, 90, 0.08)",
    color: "#5f6f66",
    padding: "0 7px"
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(38, 122, 90, 0.06)"
  },
  ".cm-previewLocatedLine": {
    backgroundColor: "rgba(243, 182, 75, 0.18)",
    boxShadow: "inset 3px 0 0 rgba(243, 182, 75, 0.62)"
  },
  ".cm-activeLineGutter": {
    backgroundColor: "rgba(38, 122, 90, 0.08)"
  },
  ".cm-selectionBackground": {
    backgroundColor: "rgba(38, 122, 90, 0.18) !important"
  },
  ".cm-lockSpanBody": {
    backgroundColor: "rgba(218, 154, 44, 0.16)",
    borderBottom: "1px solid rgba(218, 154, 44, 0.32)"
  },
  ".cm-lockSpanBoundary": {
    color: "#b98224",
    backgroundColor: "rgba(218, 154, 44, 0.08)",
    fontWeight: "650"
  },
  ".cm-lockSpanBoundary *": {
    color: "inherit !important"
  },
});
