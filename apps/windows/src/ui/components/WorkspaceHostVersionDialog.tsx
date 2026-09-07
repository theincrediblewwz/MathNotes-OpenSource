import { useEffect, useRef } from "react";

export function WorkspaceHostVersionDialog({ sourceText, onClose }: { sourceText: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    // Native modal top layer avoids source toolbars intercepting the close button.
    if (dialog && typeof dialog.showModal === "function") dialog.showModal();
    else dialog?.setAttribute("open", "");
    return () => { if (dialog?.open && typeof dialog.close === "function") dialog.close(); };
  }, []);
  return <dialog ref={ref} className="workspace-host-version" aria-label="当前主机版本" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header>
      <div><strong>当前主机版本</strong><p>只读预览。你的草稿仍保留，可复制需要的内容后继续合并。</p></div>
      <button autoFocus type="button" onClick={onClose}>关闭预览</button>
    </header>
    <pre>{sourceText}</pre>
  </dialog>;
}
