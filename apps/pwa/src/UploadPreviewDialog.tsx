import { useEffect, useState } from "react";
import { companionStorage } from "./appStorage";
import type { DeviceCredential, UploadTask } from "./domain";
import { loadUploadPreview, UploadPreviewUnavailableError } from "./uploadPreview";

export function UploadPreviewDialog({ task, credential, onClose, onJump }: {
  task: UploadTask; credential?: DeviceCredential; onClose(): void; onJump(task: UploadTask): Promise<void>;
}) {
  const [current, setCurrent] = useState(task);
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [jumping, setJumping] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true, objectUrl = "";
    setLoading(true); setMessage(""); setUrl("");
    void loadUploadPreview(task, { credential, online: navigator.onLine, repository: companionStorage }).then(result => {
      if (!active) return;
      objectUrl = URL.createObjectURL(result.bytes); setUrl(objectUrl); setCurrent(result.task); setMessage(result.notice ?? "");
    }, error => {
      if (!active) return;
      if (error instanceof UploadPreviewUnavailableError) setCurrent(error.task);
      setMessage(error instanceof Error ? error.message : "成品暂时无法读取。");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [task, credential, attempt]);
  return <div className="upload-product-layer">
    <section className="upload-product-dialog" role="dialog" aria-modal="true" aria-label="上传成品预览">
      <header><div><strong>上传成品</strong><small>{task.fileName}</small></div><button type="button" onClick={onClose} aria-label="关闭成品预览">关闭</button></header>
      <div className="upload-product-content">
        {loading ? <p role="status">正在读取并校验上传成品…</p> : url ? task.kind === "image"
          ? <img src={url} alt="实际上传的处理后照片" onError={() => { setMessage("成品文件已读取，但浏览器无法显示此图片格式。"); }} />
          : <a href={url} download={task.fileName}>打开已上传的 PDF 文件</a> : null}
        {message ? <div role="status"><p>{message}</p>{!jumping ? <button type="button" onClick={() => setAttempt(value => value + 1)}>重新读取成品</button> : null}</div> : null}
      </div>
      <footer><span>{task.notebookTitle} / {task.sessionTitle}</span><button type="button" disabled={jumping || current.recognitionStatus !== "succeeded" || !current.transcriptBlockId} onClick={() => {
        setJumping(true); setMessage("");
        void onJump(current).catch(error => setMessage(error instanceof Error ? error.message : "无法定位这次识别内容。")).finally(() => setJumping(false));
      }}>{jumping ? "正在定位识别内容…" : "跳转到所在笔记"}</button></footer>
    </section>
  </div>;
}
