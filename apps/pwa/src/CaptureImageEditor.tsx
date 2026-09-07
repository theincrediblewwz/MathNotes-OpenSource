import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import {
  acquireCaptureImage, captureCropRect, capturePointInRect, drawCaptureMarks,
  fittedCaptureRect, FULL_CAPTURE_RECT, moveCaptureCropCorner, rectPoints,
  releaseCaptureImage, renderCaptureSurface, rotateCapture,
  type CaptureEdit, type CaptureMark, type CapturePoint, type CaptureQuad, type DecodedImage
} from "./captureEditing";

type Tool = "crop" | "pen" | "arrow" | "redaction" | "lasso" | "perspective";
type Gesture = { pointer: number; corner: number; points: CapturePoint[]; before: CaptureEdit };

export function CaptureImageEditor({ file, edit, disabled, onEdit, onPerspective, onBake }: {
  file: File; edit: CaptureEdit; disabled: boolean;
  onEdit(edit: CaptureEdit): void;
  onPerspective(corners: CaptureQuad): Promise<void>;
  onBake(): Promise<boolean>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<DecodedImage | null>(null);
  const [loadError, setLoadError] = useState("");
  const [size, setSize] = useState({ width: 640, height: 420 });
  const [tool, setTool] = useState<Tool>("crop");
  const [brushWidth, setBrushWidth] = useState(.05);
  const [quad, setQuad] = useState<CaptureQuad>(rectPoints(FULL_CAPTURE_RECT));
  const [history, setHistory] = useState<CaptureEdit[]>([]);
  const gesture = useRef<Gesture | null>(null);
  const pendingTool = useRef<Tool | null>(null);
  const quarter = edit.rotation === 90 || edit.rotation === 270;
  const imageWidth = image ? quarter ? image.height : image.width : 1;
  const imageHeight = image ? quarter ? image.width : image.height : 1;
  const fitted = fittedCaptureRect(size.width, size.height, imageWidth, imageHeight);
  const crop = captureCropRect(imageWidth, imageHeight, edit);
  const base = useMemo(() => image ? renderCaptureSurface(image, { rotation: edit.rotation, crop: "original" }, Math.max(fitted.width, fitted.height) * Math.min(window.devicePixelRatio || 1, 2)) : null,
    [image, edit.rotation, size.width, size.height]);

  useEffect(() => {
    let disposed = false;
    setImage(null); setLoadError(""); setHistory([]); setTool(pendingTool.current ?? "crop"); pendingTool.current = null; setQuad(rectPoints(FULL_CAPTURE_RECT));
    void acquireCaptureImage(file).then(value => { if (!disposed) setImage(value); }, error => { if (!disposed) setLoadError(String(error?.message ?? "照片无法读取")); });
    return () => { disposed = true; releaseCaptureImage(file); };
  }, [file]);

  useEffect(() => {
    const element = container.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element); return () => observer.disconnect();
  }, []);

  // Decode once and redraw the small display canvas; full-resolution encoding only happens on apply.
  useEffect(() => {
    const element = canvas.current;
    if (!element || !image || !base) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    element.width = Math.round(size.width * ratio); element.height = Math.round(size.height * ratio);
    const context = element.getContext("2d"); if (!context) return;
    context.scale(ratio, ratio); context.fillStyle = "#20221f"; context.fillRect(0, 0, size.width, size.height);
    context.drawImage(base, fitted.x, fitted.y, fitted.width, fitted.height);
    context.save(); context.translate(fitted.x, fitted.y);
    context.beginPath(); context.rect(0, 0, fitted.width, fitted.height); context.clip();
    drawCaptureMarks(context, edit.marks ?? [], fitted.width, fitted.height); context.restore();
    const points = tool === "perspective" ? quad : edit.lasso?.length ? edit.lasso : rectPoints(crop);
    if (points.length > 1) {
      context.fillStyle = "#00000070"; context.beginPath();
      context.rect(fitted.x, fitted.y, fitted.width, fitted.height);
      points.forEach((p, i) => { const x = fitted.x + p.x * fitted.width, y = fitted.y + p.y * fitted.height; if (i === 0) context.moveTo(x, y); else context.lineTo(x, y); });
      context.closePath(); context.fill("evenodd");
      context.beginPath(); points.forEach((p, i) => { const x = fitted.x + p.x * fitted.width, y = fitted.y + p.y * fitted.height; if (i === 0) context.moveTo(x, y); else context.lineTo(x, y); });
      context.closePath(); context.strokeStyle = "#72d5a7"; context.lineWidth = 2; context.stroke();
    }
    if (tool === "crop" || tool === "perspective") {
      for (const p of tool === "perspective" ? quad : rectPoints(crop)) {
        context.beginPath(); context.arc(fitted.x + p.x * fitted.width, fitted.y + p.y * fitted.height, 9, 0, Math.PI * 2);
        context.fillStyle = "#ffffff"; context.fill(); context.strokeStyle = "#267a5a"; context.lineWidth = 3; context.stroke();
      }
    }
  }, [image, base, edit, size, tool, quad]);

  const change = (next: CaptureEdit) => { setHistory(items => [...items.slice(-29), edit]); onEdit(next); };
  const location = (event: PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const start = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!image || disabled || gesture.current) return;
    const position = location(event), point = capturePointInRect(position.x, position.y, fitted);
    let corner = -1;
    if (tool === "crop" || tool === "perspective") {
      const points = tool === "perspective" ? quad : rectPoints(crop);
      let distance = Infinity;
      points.forEach((p, index) => {
        const value = Math.hypot(position.x - fitted.x - p.x * fitted.width, position.y - fitted.y - p.y * fitted.height);
        if (value < distance) { corner = index; distance = value; }
      });
      if (distance > 38) return;
    } else if (position.x < fitted.x || position.x > fitted.x + fitted.width || position.y < fitted.y || position.y > fitted.y + fitted.height) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { pointer: event.pointerId, corner, points: [point], before: edit };
    if (tool !== "perspective") setHistory(items => [...items.slice(-29), edit]);
    update(point);
  };
  const update = (point: CapturePoint) => {
    const active = gesture.current; if (!active) return;
    if (tool === "crop") onEdit({ ...active.before, crop: "original", cropRect: moveCaptureCropCorner(crop, active.corner, point), lasso: undefined });
    else if (tool === "perspective") setQuad(current => current.map((p, index) => index === active.corner ? point : p) as unknown as CaptureQuad);
    else {
      if (Math.hypot(point.x - active.points[active.points.length - 1].x, point.y - active.points[active.points.length - 1].y) > .001) active.points.push(point);
      if (tool === "lasso") onEdit({ ...active.before, lasso: [...active.points] });
      else {
        const mark: CaptureMark = { type: tool, points: [...active.points], width: tool === "redaction" ? brushWidth : .007 };
        onEdit({ ...active.before, marks: [...(active.before.marks ?? []), mark] });
      }
    }
  };
  const move = (event: PointerEvent<HTMLCanvasElement>) => {
    if (gesture.current?.pointer !== event.pointerId || disabled) return;
    const p = location(event); update(capturePointInRect(p.x, p.y, fitted));
  };
  const end = (event: PointerEvent<HTMLCanvasElement>) => {
    if (gesture.current?.pointer !== event.pointerId) return;
    if (event.type === "pointercancel") onEdit(gesture.current.before);
    else if (tool === "lasso" && gesture.current.points.length < 3) onEdit(gesture.current.before);
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <>
    <div className="capture-edit-canvas-stage" ref={container}>
      <canvas ref={canvas} aria-label="照片编辑画布，拖动四角裁剪" onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
      {!image && <p className="capture-canvas-message">{loadError || "正在打开照片…"}</p>}
    </div>
    <div className="capture-editor-tools" aria-label="照片编辑工具">
      {([['crop','矩形裁剪'],['perspective','透视'],['lasso','套索'],['pen','画笔'],['arrow','箭头'],['redaction','马赛克']] as const).map(([value, label]) =>
        <button key={value} type="button" disabled={disabled} className={tool === value ? "active" : ""} aria-pressed={tool === value} onClick={() => {
          if (value === "perspective" && (edit.crop !== "original" || edit.cropRect || edit.lasso?.length)) {
            pendingTool.current = "perspective";
            void onBake().then(applied => { if (!applied) pendingTool.current = null; });
          } else setTool(value);
          if (value === "crop" && edit.lasso) change({ ...edit, lasso: undefined });
        }}>{label}</button>)}
      <button type="button" disabled={disabled} onClick={() => { change(rotateCapture(edit, "left")); setQuad(rectPoints(FULL_CAPTURE_RECT)); }}>左转</button>
      <button type="button" disabled={disabled} onClick={() => { change(rotateCapture(edit, "right")); setQuad(rectPoints(FULL_CAPTURE_RECT)); }}>右转</button>
      {(["original", "4:3", "square"] as const).map(value => <button key={value} type="button" disabled={disabled} onClick={() => { change({ ...edit, crop: value, cropRect: undefined, lasso: undefined }); setTool("crop"); }}>{value === "original" ? "原图" : value === "square" ? "方形" : value}</button>)}
      <button type="button" disabled={disabled || !history.length} onClick={() => { const previous = history[history.length - 1]; setHistory(items => items.slice(0,-1)); onEdit(previous); }}>撤销</button>
    </div>
    <div className="capture-edit-hint">
      {tool === "redaction" ? <><span>遮盖区域会替换成纯黑后再上传</span><label>粗细 <input aria-label="马赛克粗细" type="range" min="0.02" max="0.1" step="0.01" value={brushWidth} onChange={event => setBrushWidth(Number(event.target.value))} disabled={disabled} /></label></>
        : tool === "perspective" ? <><span>四角对齐纸张边缘，应用后继续裁剪或标注。</span><button type="button" disabled={disabled || !image} onClick={() => void onPerspective(quad)}>应用透视</button></>
        : <span>{tool === "crop" ? "拖动四角调整范围，绿色边框就是保留范围。" : tool === "lasso" ? "圈出要保留的区域，圈外会变为白色。" : "在照片上拖动即可标注；可撤销上一步。"}</span>}
    </div>
  </>;
}
