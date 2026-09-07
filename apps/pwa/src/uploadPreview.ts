import { CompanionApiClient, CompanionApiError, type UploadMaterialResult } from "./apiClient";
import type { DeviceCredential, UploadTask } from "./domain";
import type { UploadTaskRepository } from "./uploadQueue";

export class UploadPreviewUnavailableError extends Error {
  constructor(message: string, readonly task: UploadTask) { super(message); this.name = "UploadPreviewUnavailableError"; }
}

export async function uploadBlobSha256(bytes: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await bytes.arrayBuffer());
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

export function verifyPreviewReceipt(task: UploadTask, receipt: UploadMaterialResult): void {
  if (receipt.uploadId !== task.uploadId || receipt.notebookId !== task.notebookId || receipt.sessionId !== task.sessionId) {
    throw new Error("上传回执与这份笔记不一致，无法打开成品。");
  }
  if (!receipt.assetPath || !/^[a-f0-9]{64}$/i.test(receipt.sha256 ?? "") || !receipt.mimeType) {
    throw new Error("电脑返回的成品信息不完整，请更新电脑端后重试。");
  }
  if (task.sha256 && task.sha256.toLowerCase() !== receipt.sha256!.toLowerCase()) throw new Error("上传回执的 SHA-256 与这条队列记录不同，已停止读取。");
  // Paths are used only by the authenticated companion asset endpoint, never as URLs.
  if (/^(?:[a-z]+:|[\\/])/i.test(receipt.assetPath) || receipt.assetPath.split(/[\\/]/).includes("..")) {
    throw new Error("电脑返回的素材地址无效。");
  }
}

export async function loadUploadPreview(task: UploadTask, options: {
  credential?: DeviceCredential;
  online: boolean;
  repository: UploadTaskRepository;
  api?: Pick<CompanionApiClient, "fetchUploadStatus" | "fetchAsset">;
}): Promise<{ task: UploadTask; bytes: Blob; notice?: string }> {
  // Queue cards can predate a preview that already cached the full accepted file.
  const persisted = await options.repository.loadUploadTask(task.id);
  if (persisted?.profileId === task.profileId) task = persisted;
  const local = task.uploadedBytes ?? task.bytes;
  const credential = options.credential;
  if (local) {
    if (task.sha256 && await uploadBlobSha256(local) !== task.sha256.toLowerCase()) throw new Error("本机成品校验失败，请重新读取电脑上的素材。");
    let notice: string | undefined;
    if (task.status === "succeeded" && task.uploadId && options.online && credential?.deviceId === task.profileId) {
      const api = options.api ?? new CompanionApiClient(credential.origin);
      let receipt: UploadMaterialResult | undefined;
      try { receipt = await api.fetchUploadStatus(credential.token, task.uploadId, task); }
      catch (error) {
        if (error instanceof CompanionApiError && ["upload_target_mismatch", "invalid_upload_status"].includes(error.code)) throw error;
        notice = "已显示本机成品，电脑上的识别状态暂时无法更新。";
      }
      if (receipt) {
        verifyPreviewReceipt(task, receipt);
        if (await uploadBlobSha256(local) !== receipt.sha256) throw new Error("本机文件与上传回执不同，无法将它作为上传成品。");
        task = { ...task, ...receipt };
        if (await options.repository.loadUploadTask(task.id)) await options.repository.saveUploadTask(task);
      }
    }
    return { task, bytes: local, notice };
  }
  // Never upscale the thumbnail or reopen the capture draft: neither is the upload product.
  if (!options.online || !credential || credential.deviceId !== task.profileId) throw new Error("此成品尚未缓存在本机，请连接原电脑后重试。");
  if (!task.uploadId || task.status !== "succeeded") throw new Error("本机素材已清理，且没有可用的上传回执。");
  const api = options.api ?? new CompanionApiClient(credential.origin);
  let receipt: UploadMaterialResult;
  try { receipt = await api.fetchUploadStatus(credential.token, task.uploadId, task); }
  catch (error) {
    if (error instanceof CompanionApiError && error.status === 404) throw new Error("电脑上的上传记录或目标笔记已不存在。");
    throw error;
  }
  verifyPreviewReceipt(task, receipt);
  let bytes: Blob;
  try { bytes = await api.fetchAsset(credential.token, { notebookId: task.notebookId, sessionId: task.sessionId, title: task.sessionTitle }, receipt.assetPath!); }
  catch (error) {
    if (error instanceof CompanionApiError && error.status === 404) throw new UploadPreviewUnavailableError("这张上传成品已不在电脑上，仍可尝试查看对应的转写笔记。", { ...task, ...receipt });
    throw error;
  }
  if (await uploadBlobSha256(bytes) !== receipt.sha256!.toLowerCase()) throw new Error("成品校验失败，读取到的文件与上传回执不同。");
  const updated: UploadTask = { ...task, ...receipt, uploadedBytes: bytes, updatedAt: new Date().toISOString() };
  const current = await options.repository.loadUploadTask(task.id);
  if (current?.profileId === task.profileId) await options.repository.saveUploadTask({ ...current, ...receipt, uploadedBytes: bytes });
  return { task: updated, bytes };
}
