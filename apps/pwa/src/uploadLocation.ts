import type { CachedAsset, CachedSession, UploadTask } from "./domain";

export function locateUploadInSession(session: CachedSession, task: UploadTask, assets: readonly CachedAsset[]): { anchor: string; notice: string } {
  if (session.profileId !== task.profileId || session.notebookId !== task.notebookId || session.sessionId !== task.sessionId || !task.transcriptBlockId) throw new Error("识别记录与当前笔记不一致。");
  const parsed = new DOMParser().parseFromString(session.html, "text/html");
  const block = Array.from(parsed.querySelectorAll("section[data-block-id]")).find(node => node.getAttribute("data-block-id") === task.transcriptBlockId);
  if (!block || !/^[A-Za-z0-9._:-]+$/.test(task.transcriptBlockId)) throw new Error("这次识别对应的正文块已不存在，请刷新笔记后重试。");
  const blockAnchor = `mathnotes-block-${task.transcriptBlockId}`;
  const asset = session.assets.find(item => item.path === task.assetPath);
  const cached = asset && assets.some(item => item.assetId === asset.id && item.bytes.size > 0);
  const image = asset && Array.from(block.querySelectorAll("img")).find(node => node.getAttribute("data-companion-asset-id") === asset.id && !node.closest(".mathnotes-image-full"));
  if (image?.id && cached) return { anchor: image.id, notice: "" };
  return { anchor: blockAnchor, notice: image && !cached ? "图片尚未同步，已定位对应的转写内容。" : "已定位这次识别的转写内容。" };
}
