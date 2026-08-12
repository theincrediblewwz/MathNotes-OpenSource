import { Check, Image, Scissors, LassoSelect, ScanLine, Brush, ArrowUpRight, RotateCw, RotateCcw, Trash2, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { normalizeImageTransformOperations, type ImageAnnotationObject, type NormalizedPoint } from "@mathnotes/shared";
import type { AnnotatedImageOperation } from "../../types/mathNotesApi";
import {
  buildImageEditOperations,
  isBase64PngDataUrl,
  renderImageEditsToPngDataUrl,
  type ImageCropRect,
  type PerspectiveCorners
} from "../../core/imageAnnotationTransforms";

export type ImageAnnotationDraft = {
  fileName: string;
  sourcePath: string;
  previewDataUrl: string;
};

export type ImageAnnotationConfirmInput = {
  fileName: string;
  sourcePath: string;
  pngDataUrl: string;
  operations: AnnotatedImageOperation[];
  annotations: ImageAnnotationObject[];
};

type ImageAnnotationEditorProps = {
  draft: ImageAnnotationDraft;
  onCancel(): void;
  onConfirm(input: ImageAnnotationConfirmInput): void | Promise<void>;
};

type CropPoint = {
  x: number;
  y: number;
};

type CropHandle = "nw" | "ne" | "sw" | "se";

type CropResizeState = {
  handle: CropHandle;
  rect: ImageCropRect;
};

type LassoDragState =
  | { mode: "draw" }
  | { mode: "move"; start: NormalizedPoint; original: NormalizedPoint[] };

type AnnotationDragState =
  | { mode: "draw-pen"; id: string }
  | { mode: "draw-arrow"; id: string }
  | { mode: "move"; id: string; start: NormalizedPoint; original: ImageAnnotationObject };

type CommittedEditSnapshot = {
  previewDataUrl: string;
  operations: AnnotatedImageOperation[];
  annotations: ImageAnnotationObject[];
};

export function ImageAnnotationEditor({ draft, onCancel, onConfirm }: ImageAnnotationEditorProps) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const annotationDragRef = useRef<AnnotationDragState | null>(null);
  const [basePreviewDataUrl, setBasePreviewDataUrl] = useState(draft.previewDataUrl);
  const [committedOperations, setCommittedOperations] = useState<AnnotatedImageOperation[]>([]);
  const [committedAnnotations, setCommittedAnnotations] = useState<ImageAnnotationObject[]>([]);
  const [committedHistory, setCommittedHistory] = useState<CommittedEditSnapshot[]>([]);
  const [applying, setApplying] = useState(false);
  const [activeTool, setActiveTool] = useState<"perspective" | "crop" | "lasso" | "pen" | "arrow" | null>(null);
  const [rotationDegrees, setRotationDegrees] = useState(0);
  const [cropStart, setCropStart] = useState<CropPoint | null>(null);
  const [cropCurrent, setCropCurrent] = useState<CropPoint | null>(null);
  const [cropRect, setCropRect] = useState<ImageCropRect | null>(null);
  const [cropHistory, setCropHistory] = useState<ImageCropRect[]>([]);
  const [cropResize, setCropResize] = useState<CropResizeState | null>(null);
  const [lassoPoints, setLassoPoints] = useState<NormalizedPoint[]>([]);
  const [lassoHistory, setLassoHistory] = useState<NormalizedPoint[][]>([]);
  const [lassoDrag, setLassoDrag] = useState<LassoDragState | null>(null);
  const [perspectiveCorners, setPerspectiveCorners] = useState<PerspectiveCorners>(DEFAULT_PERSPECTIVE_CORNERS);
  const [perspectiveHistory, setPerspectiveHistory] = useState<PerspectiveCorners[]>([]);
  const [perspectiveCornerDrag, setPerspectiveCornerDrag] = useState<number | null>(null);
  const [perspectiveEnabled, setPerspectiveEnabled] = useState(false);
  const [annotations, setAnnotations] = useState<ImageAnnotationObject[]>([]);
  const [annotationHistory, setAnnotationHistory] = useState<ImageAnnotationObject[][]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [annotationColor, setAnnotationColor] = useState<(typeof ANNOTATION_COLORS)[number]>(ANNOTATION_COLORS[0]);
  const [annotationWidth, setAnnotationWidth] = useState(ANNOTATION_WIDTH);

  function pendingOperations() {
    const image = imageRef.current;
    const swapsAxes = normalizeQuarterTurn(rotationDegrees) % 2 === 1;
    return buildImageEditOperations(cropRect, rotationDegrees, {
      width: swapsAxes ? image?.naturalHeight || 1 : image?.naturalWidth || 1,
      height: swapsAxes ? image?.naturalWidth || 1 : image?.naturalHeight || 1
    }, lassoPoints, perspectiveEnabled ? perspectiveCorners : null);
  }

  async function renderPendingEdits() {
    return renderImageEditsToPngDataUrl({
      dataUrl: basePreviewDataUrl,
      cropRect,
      lassoPoints,
      perspectiveCorners: perspectiveEnabled ? perspectiveCorners : null,
      rotationDegrees,
      currentImage: imageRef.current,
      annotations
    });
  }

  function resetPendingEdits() {
    setRotationDegrees(0);
    setCropStart(null);
    setCropCurrent(null);
    setCropRect(null);
    setCropHistory([]);
    setCropResize(null);
    setLassoPoints([]);
    setLassoHistory([]);
    setLassoDrag(null);
    setPerspectiveCorners(DEFAULT_PERSPECTIVE_CORNERS);
    setPerspectiveHistory([]);
    setPerspectiveCornerDrag(null);
    setPerspectiveEnabled(false);
    setAnnotations([]);
    setAnnotationHistory([]);
    annotationDragRef.current = null;
    setSelectedAnnotationId(null);
  }

  async function applyCurrentOperation() {
    if (!hasPendingEdits || applying) return;
    setApplying(true);
    try {
      const operations = pendingOperations();
      const pngDataUrl = await renderPendingEdits();
      setCommittedHistory((history) => [...history, {
        previewDataUrl: basePreviewDataUrl,
        operations: committedOperations,
        annotations: committedAnnotations
      }]);
      setCommittedOperations((current) => normalizeImageTransformOperations([...current, ...operations]));
      setCommittedAnnotations((current) => [...current, ...annotations]);
      setBasePreviewDataUrl(pngDataUrl);
      resetPendingEdits();
    } finally {
      setApplying(false);
    }
  }

  async function confirmCurrentImage() {
    const operations = normalizeImageTransformOperations([...committedOperations, ...pendingOperations()]);
    const pngDataUrl = hasPendingEdits || !isBase64PngDataUrl(basePreviewDataUrl)
      ? await renderPendingEdits()
      : basePreviewDataUrl.trim();
    await onConfirm({
      fileName: draft.fileName,
      sourcePath: draft.sourcePath,
      pngDataUrl,
      operations,
      annotations: [...committedAnnotations, ...annotations]
    });
  }

  function beginAnnotation(event: React.PointerEvent<HTMLImageElement>) {
    if (activeTool !== "pen" && activeTool !== "arrow") return;
    event.preventDefault();
    capturePointer(event.currentTarget, event.pointerId);
    const point = normalizedPointFromPointer(event.currentTarget, event.clientX, event.clientY);
    setAnnotationHistory((history) => [...history, annotations]);
    const hit = [...annotations].reverse().find((annotation) => annotationHitTest(annotation, point));
    if (hit) {
      setSelectedAnnotationId(hit.id);
      const drag: AnnotationDragState = { mode: "move", id: hit.id, start: point, original: hit };
      annotationDragRef.current = drag;
      return;
    }
    const id = createAnnotationId();
    setSelectedAnnotationId(id);
    if (activeTool === "pen") {
      setAnnotations((current) => [...current, { id, type: "pen", points: [point, point], color: annotationColor, width: annotationWidth }]);
      const drag: AnnotationDragState = { mode: "draw-pen", id };
      annotationDragRef.current = drag;
    } else {
      setAnnotations((current) => [...current, { id, type: "arrow", start: point, end: point, color: annotationColor, width: annotationWidth }]);
      const drag: AnnotationDragState = { mode: "draw-arrow", id };
      annotationDragRef.current = drag;
    }
  }

  const updateAnnotationFromPointer = useCallback((clientX: number, clientY: number) => {
    const drag = annotationDragRef.current;
    if (!drag || !imageRef.current) return;
    const point = normalizedPointFromPointer(imageRef.current, clientX, clientY);
    setAnnotations((current) => current.map((annotation) => {
      if (annotation.id !== drag.id) return annotation;
      if (drag.mode === "draw-pen" && annotation.type === "pen") {
        const previous = annotation.points[annotation.points.length - 1];
        return pointDistance(previous, point) >= MIN_LASSO_DISTANCE
          ? { ...annotation, points: [...annotation.points, point] }
          : annotation;
      }
      if (drag.mode === "draw-arrow" && annotation.type === "arrow") return { ...annotation, end: point };
      if (drag.mode === "move") {
        return translateAnnotation(
          drag.original,
          point.x - drag.start.x,
          point.y - drag.start.y
        );
      }
      return annotation;
    }));
  }, []);

  const finishAnnotation = useCallback(() => {
    const drag = annotationDragRef.current;
    if (!drag) return;
    setAnnotations((current) => current.filter((annotation) => {
      if (annotation.id !== drag.id) return true;
      if (annotation.type === "pen") return annotation.points.some((point, index) => index > 0 && pointDistance(annotation.points[index - 1], point) >= 0.002);
      return pointDistance(annotation.start, annotation.end) >= 0.002;
    }));
    annotationDragRef.current = null;
  }, []);

  useEffect(() => {
    const moveAnnotation = (event: PointerEvent) => {
      if (!annotationDragRef.current) return;
      updateAnnotationFromPointer(event.clientX, event.clientY);
    };
    const endAnnotation = () => {
      if (!annotationDragRef.current) return;
      finishAnnotation();
    };
    window.addEventListener("pointermove", moveAnnotation);
    window.addEventListener("pointerup", endAnnotation);
    window.addEventListener("pointercancel", endAnnotation);
    return () => {
      window.removeEventListener("pointermove", moveAnnotation);
      window.removeEventListener("pointerup", endAnnotation);
      window.removeEventListener("pointercancel", endAnnotation);
    };
  }, [finishAnnotation, updateAnnotationFromPointer]);

  function beginCrop(event: React.PointerEvent<HTMLImageElement>) {
    if (activeTool !== "crop") {
      return;
    }
    event.preventDefault();
    capturePointer(event.currentTarget, event.pointerId);
    const point = cropPointFromPointer(event.currentTarget, event.clientX, event.clientY);
    setLassoPoints([]);
    setLassoHistory([]);
    setLassoDrag(null);
    if (cropRect) {
      setCropHistory((history) => [...history, cropRect]);
    }
    setCropStart(point);
    setCropCurrent(point);
    setCropRect(null);
  }

  function beginPerspectiveCorner(event: React.PointerEvent<SVGCircleElement>, index: number) {
    if (activeTool !== "perspective") return;
    event.preventDefault();
    event.stopPropagation();
    capturePointer(event.currentTarget, event.pointerId);
    setPerspectiveHistory((history) => [...history, perspectiveCorners]);
    setPerspectiveCornerDrag(index);
  }

  function updatePerspectiveFromPointer(clientX: number, clientY: number) {
    if (perspectiveCornerDrag === null || activeTool !== "perspective" || !imageRef.current) return;
    const point = normalizedPointFromPointer(imageRef.current, clientX, clientY);
    const next = [...perspectiveCorners] as PerspectiveCorners;
    next[perspectiveCornerDrag] = point;
    if (validPerspectiveCorners(next)) {
      setPerspectiveCorners(next);
      setPerspectiveEnabled(true);
    }
  }

  function finishPerspective() {
    setPerspectiveCornerDrag(null);
  }

  function beginLasso(event: React.PointerEvent<HTMLImageElement>) {
    if (activeTool !== "lasso") {
      return;
    }
    event.preventDefault();
    capturePointer(event.currentTarget, event.pointerId);
    const point = normalizedPointFromPointer(event.currentTarget, event.clientX, event.clientY);
    setCropRect(null);
    setCropHistory([]);
    setCropStart(null);
    setCropCurrent(null);
    setCropResize(null);
    setLassoHistory((history) => [...history, lassoPoints]);
    if (lassoPoints.length >= 3 && pointInPolygon(point, lassoPoints)) {
      setLassoDrag({ mode: "move", start: point, original: lassoPoints });
    } else {
      setLassoPoints([point]);
      setLassoDrag({ mode: "draw" });
    }
  }

  function updateLassoFromPointer(clientX: number, clientY: number) {
    if (!lassoDrag || activeTool !== "lasso" || !imageRef.current) {
      return;
    }
    const point = normalizedPointFromPointer(imageRef.current, clientX, clientY);
    if (lassoDrag.mode === "move") {
      setLassoPoints(translateLassoPoints(
        lassoDrag.original,
        point.x - lassoDrag.start.x,
        point.y - lassoDrag.start.y
      ));
      return;
    }
    setLassoPoints((current) => {
      const previous = current[current.length - 1];
      return !previous || pointDistance(previous, point) >= MIN_LASSO_DISTANCE ? [...current, point] : current;
    });
  }

  function finishLasso() {
    if (!lassoDrag) {
      return;
    }
    setLassoPoints((current) => current.length >= 3 ? current : []);
    setLassoDrag(null);
  }

  function updateCropFromPointer(clientX: number, clientY: number) {
    if (!cropStart || activeTool !== "crop") {
      return;
    }
    const image = imageRef.current;
    if (!image) {
      return;
    }
    setCropCurrent(cropPointFromPointer(image, clientX, clientY));
  }

  function finishCropFromPointer(clientX: number, clientY: number) {
    if (!cropStart || !cropCurrent || activeTool !== "crop") {
      return;
    }
    const image = imageRef.current;
    if (!image) {
      return;
    }
    const rect = rectFromPoints(cropStart, cropPointFromPointer(image, clientX, clientY));
    setCropStart(null);
    setCropCurrent(null);
    if (rect.width >= 2 && rect.height >= 2) {
      setCropRect(rect);
    }
  }

  function beginCropResize(event: React.PointerEvent<HTMLButtonElement>, handle: CropHandle) {
    if (!cropRect || activeTool !== "crop") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    capturePointer(event.currentTarget, event.pointerId);
    setCropHistory((history) => [...history, cropRect]);
    setCropResize({ handle, rect: cropRect });
  }

  function updateCropResizeFromPointer(clientX: number, clientY: number) {
    if (!cropResize || !imageRef.current) {
      return;
    }
    const point = cropPointFromPointer(imageRef.current, clientX, clientY);
    setCropRect(rectFromHandle(cropResize.rect, cropResize.handle, point));
  }

  function finishCropResize() {
    if (!cropResize) {
      return;
    }
    setCropResize(null);
  }

  function undoCrop() {
    setCropHistory((history) => {
      const next = [...history];
      setCropRect(next.pop() ?? null);
      return next;
    });
    setCropStart(null);
    setCropCurrent(null);
    setCropResize(null);
  }

  function resetCrop() {
    setCropRect(null);
    setCropHistory([]);
    setCropStart(null);
    setCropCurrent(null);
    setCropResize(null);
  }

  function undoLasso() {
    setLassoHistory((history) => {
      const next = [...history];
      setLassoPoints(next.pop() ?? []);
      return next;
    });
    setLassoDrag(null);
  }

  function resetLasso() {
    setLassoPoints([]);
    setLassoHistory([]);
    setLassoDrag(null);
  }

  function undoPerspective() {
    setPerspectiveHistory((history) => {
      const next = [...history];
      const previous = next.pop();
      if (previous) setPerspectiveCorners(previous);
      if (next.length === 0 && previous === DEFAULT_PERSPECTIVE_CORNERS) setPerspectiveEnabled(false);
      return next;
    });
    setPerspectiveCornerDrag(null);
  }

  function resetPerspective() {
    setPerspectiveCorners(DEFAULT_PERSPECTIVE_CORNERS);
    setPerspectiveHistory([]);
    setPerspectiveCornerDrag(null);
    setPerspectiveEnabled(false);
  }

  function undoAnnotation() {
    setAnnotationHistory((history) => {
      const next = [...history];
      setAnnotations(next.pop() ?? []);
      return next;
    });
    annotationDragRef.current = null;
    setSelectedAnnotationId(null);
  }

  function resetAnnotations() {
    if (annotations.length) setAnnotationHistory((history) => [...history, annotations]);
    setAnnotations([]);
    annotationDragRef.current = null;
    setSelectedAnnotationId(null);
  }

  function deleteSelectedAnnotation() {
    if (!selectedAnnotationId) return;
    setAnnotationHistory((history) => [...history, annotations]);
    setAnnotations((current) => current.filter((annotation) => annotation.id !== selectedAnnotationId));
    setSelectedAnnotationId(null);
  }

  function undoCurrentSelection() {
    if (canUndoPendingSelection) {
      if (activeTool === "pen" || activeTool === "arrow") undoAnnotation();
      else if (activeTool === "perspective") undoPerspective();
      else if (activeTool === "lasso") undoLasso();
      else undoCrop();
      return;
    }
    setCommittedHistory((history) => {
      const next = [...history];
      const previous = next.pop();
      if (previous) {
        setBasePreviewDataUrl(previous.previewDataUrl);
        setCommittedOperations(previous.operations);
        setCommittedAnnotations(previous.annotations);
        resetPendingEdits();
      }
      return next;
    });
  }

  function resetCurrentSelection() {
    if (activeTool === "pen" || activeTool === "arrow") resetAnnotations();
    else if (activeTool === "perspective") resetPerspective();
    else if (activeTool === "lasso") resetLasso();
    else resetCrop();
  }

  function rotateClockwise() {
    resetCrop();
    resetLasso();
    resetPerspective();
    setAnnotations([]);
    setAnnotationHistory([]);
    annotationDragRef.current = null;
    setSelectedAnnotationId(null);
    setRotationDegrees((degrees) => (degrees + 90) % 360);
  }

  const visibleCropRect = cropStart && cropCurrent ? rectFromPoints(cropStart, cropCurrent) : cropRect;
  const naturalWidth = imageRef.current?.naturalWidth || 1;
  const naturalHeight = imageRef.current?.naturalHeight || 1;
  const hasCrop = Boolean(cropRect || cropStart);
  const canUndoCrop = cropHistory.length > 0 || Boolean(cropRect);
  const hasLasso = lassoPoints.length >= 3;
  const canUndoLasso = lassoHistory.length > 0 || lassoPoints.length > 0;
  const canUndoPendingSelection = activeTool === "pen" || activeTool === "arrow"
    ? annotationHistory.length > 0
    : activeTool === "perspective"
    ? perspectiveHistory.length > 0
    : activeTool === "lasso" ? canUndoLasso : canUndoCrop;
  const canUndoSelection = canUndoPendingSelection || committedHistory.length > 0;
  const undoLabel = canUndoPendingSelection
    ? activeTool === "pen" || activeTool === "arrow"
      ? "撤销标注"
      : activeTool === "perspective"
        ? "撤销透视"
        : activeTool === "lasso"
          ? "撤销套索"
          : "撤销裁剪"
    : "撤销上一步";
  const hasSelection = activeTool === "pen" || activeTool === "arrow"
    ? annotations.length > 0
    : activeTool === "perspective" ? perspectiveEnabled : activeTool === "lasso" ? hasLasso : hasCrop;
  const showCropHandles = Boolean(cropRect && !cropStart);
  const hasPendingEdits = rotationDegrees !== 0 || hasCrop || hasLasso || perspectiveEnabled || annotations.length > 0;

  useEffect(() => {
    if (!cropStart && !cropResize && !lassoDrag && perspectiveCornerDrag === null) {
      return;
    }

    function handlePointerMove(event: PointerEvent) {
      event.preventDefault();
      updateCropFromPointer(event.clientX, event.clientY);
      updateCropResizeFromPointer(event.clientX, event.clientY);
      updateLassoFromPointer(event.clientX, event.clientY);
      updatePerspectiveFromPointer(event.clientX, event.clientY);
    }

    function handlePointerEnd(event: PointerEvent) {
      event.preventDefault();
      finishCropFromPointer(event.clientX, event.clientY);
      finishCropResize();
      finishLasso();
      finishPerspective();
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [activeTool, cropCurrent, cropResize, cropStart, lassoDrag, perspectiveCornerDrag, perspectiveCorners]);

  return (
    <div className="annotation-modal-layer open" data-testid="image-annotation-modal">
      <section aria-label="图片编辑" className="annotation-modal" role="dialog">
        <header className="annotation-modal-head">
          <div>
            <span className="annotation-kicker">IMAGE ANNOTATION</span>
            <h2>{draft.fileName}</h2>
          </div>
          <button aria-label="关闭图片编辑" className="annotation-close" onClick={onCancel} type="button">
            <X size={18} />
          </button>
        </header>

        <div className="annotation-toolbar" aria-label="图片编辑工具">
          <button
            aria-pressed={activeTool === "perspective"}
            className={activeTool === "perspective" ? "active" : ""}
            onClick={() => setActiveTool(activeTool === "perspective" ? null : "perspective")}
            type="button"
          >
            <ScanLine size={16} />
            透视
          </button>
          <button
            aria-pressed={activeTool === "crop"}
            className={activeTool === "crop" ? "active" : ""}
            onClick={() => setActiveTool(activeTool === "crop" ? null : "crop")}
            type="button"
          >
            <Scissors size={16} />
            裁剪
          </button>
          <button
            aria-pressed={activeTool === "lasso"}
            className={activeTool === "lasso" ? "active" : ""}
            onClick={() => setActiveTool(activeTool === "lasso" ? null : "lasso")}
            type="button"
          >
            <LassoSelect size={16} />
            套索
          </button>
          <button disabled={!canUndoSelection} onClick={undoCurrentSelection} type="button">
            <Undo2 size={16} />
            {undoLabel}
          </button>
          <button disabled={!hasSelection} onClick={resetCurrentSelection} type="button">
            <RotateCcw size={16} />
            {activeTool === "pen" || activeTool === "arrow" ? "清空标注" : activeTool === "perspective" ? "重置透视" : activeTool === "lasso" ? "重置套索" : "重置裁剪"}
          </button>
          <button onClick={rotateClockwise} type="button">
            <RotateCw size={16} />
            旋转
          </button>
          <button
            aria-pressed={activeTool === "pen"}
            className={activeTool === "pen" ? "active" : ""}
            onClick={() => setActiveTool(activeTool === "pen" ? null : "pen")}
            type="button"
          >
            <Brush size={16} />
            画笔
          </button>
          <button
            aria-pressed={activeTool === "arrow"}
            className={activeTool === "arrow" ? "active" : ""}
            onClick={() => setActiveTool(activeTool === "arrow" ? null : "arrow")}
            type="button"
          >
            <ArrowUpRight size={16} />
            箭头
          </button>
          <button disabled={!selectedAnnotationId} onClick={deleteSelectedAnnotation} type="button">
            <Trash2 size={16} />
            删除标注
          </button>
          <div aria-label="标注颜色" className="annotation-color-palette" role="group">
            {ANNOTATION_COLORS.map((color) => (
              <button
                aria-label={`标注颜色 ${color}`}
                aria-pressed={annotationColor === color}
                className={annotationColor === color ? "selected" : ""}
                key={color}
                onClick={() => setAnnotationColor(color)}
                style={{ "--annotation-color": color } as CSSProperties}
                type="button"
              />
            ))}
          </div>
          <label className="annotation-width-control">
            <span>粗细</span>
            <input
              aria-label="画笔和箭头粗细"
              max="18"
              min="2"
              onChange={(event) => setAnnotationWidth(Number(event.currentTarget.value) / 1000)}
              step="1"
              type="range"
              value={Math.round(annotationWidth * 1000)}
            />
            <strong>{Math.round(annotationWidth * 1000)}</strong>
          </label>
        </div>

        <div className={`annotation-stage ${activeTool === "crop" ? "cropping" : activeTool === "lasso" ? "lassoing" : activeTool === "perspective" ? "perspective-editing" : activeTool === "pen" ? "drawing" : activeTool === "arrow" ? "arrowing" : ""}`}>
          <div className="annotation-image-frame">
            <img
              alt="待插入图片"
              onPointerDown={(event) => {
                beginCrop(event);
                beginLasso(event);
                beginAnnotation(event);
              }}
              ref={imageRef}
              src={basePreviewDataUrl}
              style={{ transform: rotationDegrees ? `rotate(${rotationDegrees}deg)` : undefined }}
            />
            {visibleCropRect ? (
              <div
                className="crop-selection"
                data-testid="crop-selection"
                style={{
                  left: `${(visibleCropRect.x / naturalWidth) * 100}%`,
                  top: `${(visibleCropRect.y / naturalHeight) * 100}%`,
                  width: `${(visibleCropRect.width / naturalWidth) * 100}%`,
                  height: `${(visibleCropRect.height / naturalHeight) * 100}%`
                }}
              >
                {showCropHandles
                  ? cropHandles.map((handle) => (
                      <button
                        aria-label={`调整裁剪框 ${handle}`}
                        className={`crop-handle ${handle}`}
                        data-testid={`crop-handle-${handle}`}
                        key={handle}
                        onPointerDown={(event) => beginCropResize(event, handle)}
                        type="button"
                      />
                    ))
                  : null}
              </div>
            ) : null}
            {lassoPoints.length ? (
              <svg className="lasso-selection" data-testid="lasso-selection" preserveAspectRatio="none" viewBox="0 0 1 1">
                <polygon points={lassoPoints.map((point) => `${point.x},${point.y}`).join(" ")} />
              </svg>
            ) : null}
            {activeTool === "perspective" ? (
              <svg className="perspective-selection" data-testid="perspective-selection" preserveAspectRatio="none" viewBox="0 0 1 1">
                <polygon points={perspectiveCorners.map((point) => `${point.x},${point.y}`).join(" ")} />
                {perspectiveCorners.map((point, index) => (
                  <circle
                    aria-label={`透视角点 ${index + 1}`}
                    cx={point.x}
                    cy={point.y}
                    key={index}
                    onPointerDown={(event) => beginPerspectiveCorner(event, index)}
                    r="0.014"
                    role="button"
                    tabIndex={0}
                  />
                ))}
              </svg>
            ) : null}
            {annotations.length ? (
              <svg className="object-annotation-layer" data-testid="object-annotation-layer" preserveAspectRatio="none" viewBox="0 0 1 1">
                {annotations.map((annotation) => annotation.type === "pen" ? (
                  <polyline
                    className={annotation.id === selectedAnnotationId ? "selected" : ""}
                    fill="none"
                    key={annotation.id}
                    points={annotation.points.map((point) => `${point.x},${point.y}`).join(" ")}
                    stroke={annotation.color}
                    strokeWidth={annotation.width}
                  />
                ) : (
                  <g className={annotation.id === selectedAnnotationId ? "selected" : ""} key={annotation.id}>
                    <line x1={annotation.start.x} x2={annotation.end.x} y1={annotation.start.y} y2={annotation.end.y} stroke={annotation.color} strokeWidth={annotation.width} />
                    {arrowHeadSegments(annotation).map((segment, index) => (
                      <line key={index} x1={annotation.end.x} x2={segment.x} y1={annotation.end.y} y2={segment.y} stroke={annotation.color} strokeWidth={annotation.width} />
                    ))}
                  </g>
                ))}
              </svg>
            ) : null}
          </div>
        </div>

        <footer className="annotation-actions">
          <span>
            <Image size={15} />
            {activeTool === "perspective"
              ? "拖动四个角对齐纸张或黑板边缘；角点不会越过形成交叉。"
              : activeTool === "crop"
              ? "拖拽选择矩形区域；框内拖动可整体移动。"
              : activeTool === "lasso"
                ? "沿目标轮廓拖动；闭合后从轮廓内部拖动可整体移动。"
                : activeTool === "pen"
                  ? "拖动绘制笔迹；按住已有笔迹可整体移动，选中后可删除。"
                  : activeTool === "arrow"
                    ? "拖动绘制箭头；按住已有箭头可整体移动，选中后可删除。"
                : "可先裁剪或旋转图片，确认后会生成白底派生 PNG。"}
          </span>
          <div>
            <button className="secondary-button" onClick={onCancel} type="button">
              取消
            </button>
            <button className="secondary-button" disabled={!hasPendingEdits || applying} onClick={() => void applyCurrentOperation()} type="button">
              <Check size={16} />
              {applying ? "正在应用…" : "应用当前操作"}
            </button>
            <button
              className="primary-button"
              disabled={applying}
              onClick={() => void confirmCurrentImage()}
              type="button"
            >
              插入图片
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function capturePointer(element: Element, pointerId: number) {
  if ("setPointerCapture" in element && typeof element.setPointerCapture === "function") {
    element.setPointerCapture(pointerId);
  }
}

function cropPointFromPointer(image: HTMLImageElement, clientX: number, clientY: number): CropPoint {
  const bounds = image.getBoundingClientRect();
  const naturalWidth = image.naturalWidth || bounds.width || 1;
  const naturalHeight = image.naturalHeight || bounds.height || 1;
  const x = clamp(((clientX - bounds.left) / Math.max(bounds.width, 1)) * naturalWidth, 0, naturalWidth);
  const y = clamp(((clientY - bounds.top) / Math.max(bounds.height, 1)) * naturalHeight, 0, naturalHeight);
  return {
    x: Math.round(x),
    y: Math.round(y)
  };
}

function normalizedPointFromPointer(image: HTMLImageElement, clientX: number, clientY: number): NormalizedPoint {
  const bounds = image.getBoundingClientRect();
  return {
    x: clamp((clientX - bounds.left) / Math.max(bounds.width, 1), 0, 1),
    y: clamp((clientY - bounds.top) / Math.max(bounds.height, 1), 0, 1)
  };
}

function translateLassoPoints(points: NormalizedPoint[], requestedDx: number, requestedDy: number): NormalizedPoint[] {
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const dx = clamp(requestedDx, -minX, 1 - maxX);
  const dy = clamp(requestedDy, -minY, 1 - maxY);
  return points.map((point) => ({ x: point.x + dx, y: point.y + dy }));
}

function pointInPolygon(point: NormalizedPoint, polygon: NormalizedPoint[]): boolean {
  let inside = false;
  let previous = polygon[polygon.length - 1];
  for (const current of polygon) {
    const denominator = Math.abs(previous.y - current.y) < 1e-9 ? 1e-9 : previous.y - current.y;
    const crosses = (current.y > point.y) !== (previous.y > point.y) &&
      point.x < ((previous.x - current.x) * (point.y - current.y)) / denominator + current.x;
    if (crosses) inside = !inside;
    previous = current;
  }
  return inside;
}

function pointDistance(first: NormalizedPoint, second: NormalizedPoint): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function annotationHitTest(annotation: ImageAnnotationObject, point: NormalizedPoint): boolean {
  const threshold = Math.max(0.018, annotation.width * 2.5);
  if (annotation.type === "arrow") return distanceToSegment(point, annotation.start, annotation.end) <= threshold;
  return annotation.points.slice(1).some((end, index) => distanceToSegment(point, annotation.points[index], end) <= threshold);
}

function distanceToSegment(point: NormalizedPoint, start: NormalizedPoint, end: NormalizedPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) return pointDistance(point, start);
  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
  return pointDistance(point, { x: start.x + t * dx, y: start.y + t * dy });
}

function translateAnnotation(annotation: ImageAnnotationObject, requestedDx: number, requestedDy: number): ImageAnnotationObject {
  const points = annotation.type === "pen" ? annotation.points : [annotation.start, annotation.end];
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const dx = clamp(requestedDx, -minX, 1 - maxX);
  const dy = clamp(requestedDy, -minY, 1 - maxY);
  const move = (point: NormalizedPoint): NormalizedPoint => ({ x: point.x + dx, y: point.y + dy });
  return annotation.type === "pen"
    ? { ...annotation, points: annotation.points.map(move) }
    : { ...annotation, start: move(annotation.start), end: move(annotation.end) };
}

function arrowHeadSegments(annotation: Extract<ImageAnnotationObject, { type: "arrow" }>): NormalizedPoint[] {
  const angle = Math.atan2(annotation.end.y - annotation.start.y, annotation.end.x - annotation.start.x);
  const length = Math.max(annotation.width * 4, 0.025);
  const spread = Math.PI / 7;
  return [angle - spread, angle + spread].map((headAngle) => ({
    x: annotation.end.x - length * Math.cos(headAngle),
    y: annotation.end.y - length * Math.sin(headAngle)
  }));
}

function createAnnotationId(): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `annotation-${suffix}`;
}

function rectFromPoints(start: CropPoint, end: CropPoint): ImageCropRect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  };
}

function rectFromHandle(rect: ImageCropRect, handle: CropHandle, point: CropPoint): ImageCropRect {
  const left = rect.x;
  const top = rect.y;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;

  switch (handle) {
    case "nw":
      return rectFromPoints(point, { x: right, y: bottom });
    case "ne":
      return rectFromPoints({ x: left, y: bottom }, point);
    case "sw":
      return rectFromPoints({ x: right, y: top }, point);
    case "se":
      return rectFromPoints({ x: left, y: top }, point);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const cropHandles: CropHandle[] = ["nw", "ne", "sw", "se"];
const MIN_LASSO_DISTANCE = 0.006;
const ANNOTATION_WIDTH = 0.006;
const ANNOTATION_COLORS = ["#187857", "#d84b3e", "#2563a8", "#1f201d", "#f0b429"] as const;
const DEFAULT_PERSPECTIVE_CORNERS: PerspectiveCorners = [
  { x: 0.02, y: 0.02 },
  { x: 0.98, y: 0.02 },
  { x: 0.98, y: 0.98 },
  { x: 0.02, y: 0.98 }
];

function validPerspectiveCorners(corners: PerspectiveCorners): boolean {
  const crossProducts = corners.map((point, index) => {
    const next = corners[(index + 1) % corners.length];
    const after = corners[(index + 2) % corners.length];
    return (next.x - point.x) * (after.y - next.y) - (next.y - point.y) * (after.x - next.x);
  });
  const direction = Math.sign(crossProducts.find((value) => Math.abs(value) > 1e-6) ?? 0);
  return direction !== 0 && crossProducts.every((value) => Math.sign(value) === direction && Math.abs(value) > 1e-6);
}

function normalizeQuarterTurn(degrees: number): number {
  return (((degrees % 360) + 360) % 360) / 90;
}
