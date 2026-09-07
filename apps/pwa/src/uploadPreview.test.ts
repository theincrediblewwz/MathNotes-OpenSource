import { describe, expect, it, vi } from "vitest";
import { loadUploadPreview, uploadBlobSha256, verifyPreviewReceipt } from "./uploadPreview";
import { createUploadTask } from "./uploadQueue";
import type { UploadTask } from "./domain";
import { CompanionApiClient } from "./apiClient";

const credential = { id:"active",version:1,origin:"https://notes.test",token:"test",deviceId:"phone",deviceLabel:"test",verifiedAt:"now" } as const;
const task: UploadTask = { ...createUploadTask({profileId:"phone",kind:"image",file:new File(["processed"],"photo.png",{type:"image/png"}),target:{notebookId:"book",sessionId:"note",title:"课"}}),status:"succeeded",uploadId:"upload",bytes:undefined,previewBytes:new Blob(["thumbnail"])};
const repository = () => { let stored=task; return {loadUploadTask:vi.fn(async()=>stored),saveUploadTask:vi.fn(async(value:UploadTask)=>{stored=value;}),loadUploadTasks:vi.fn(async()=>[stored]),deleteUploadTask:vi.fn(async()=>{})}; };
const receipt = async () => ({uploadId:"upload",notebookId:"book",sessionId:"note",duplicate:false,assetPath:"assets/photo.png",sha256:await uploadBlobSha256(new Blob(["processed"])),mimeType:"image/png"});

describe("accepted upload products", () => {
  it("reads authenticated target-scoped content, verifies SHA and caches the full product", async () => {
    const store=repository(),api={fetchUploadStatus:vi.fn(async()=>receipt()),fetchAsset:vi.fn(async()=>new Blob(["processed"]))};
    const result=await loadUploadPreview(task,{credential,online:true,repository:store,api});
    expect(await result.bytes.text()).toBe("processed");
    expect(api.fetchUploadStatus).toHaveBeenCalledWith("test","upload",task);
    expect(store.saveUploadTask.mock.calls[0]?.[0]).toMatchObject({uploadedBytes:result.bytes});
    await expect(loadUploadPreview(result.task,{online:false,repository:store})).resolves.toMatchObject({bytes:result.bytes});
  });
  it("does not use thumbnails offline, accept cross-target receipts, or cache mismatched bytes", async () => {
    const store=repository(),valid=await receipt();
    await expect(loadUploadPreview(task,{online:false,repository:store})).rejects.toThrow("尚未缓存");
    expect(()=>verifyPreviewReceipt(task,{...valid,sessionId:"other"})).toThrow("不一致");
    const api={fetchUploadStatus:vi.fn(async()=>valid),fetchAsset:vi.fn(async()=>new Blob(["original secret"]))};
    await expect(loadUploadPreview(task,{credential,online:true,repository:store,api})).rejects.toThrow("校验失败");
    expect(store.saveUploadTask).not.toHaveBeenCalled();
  });
  it("rejects incomplete receipts and URL/path escapes", async () => {
    const valid=await receipt();
    for (const assetPath of ["https://other/secret", "../secret", "/secret", "C:\\secret"]) expect(()=>verifyPreviewReceipt(task,{...valid,assetPath})).toThrow("地址无效");
    expect(()=>verifyPreviewReceipt(task,{...valid,sha256:undefined})).toThrow("信息不完整");
    expect(()=>verifyPreviewReceipt({...task,sha256:"a".repeat(64)},valid)).toThrow("队列记录不同");
  });
  it("refreshes completed recognition for an old queue with a local full file", async () => {
    const store=repository();await store.saveUploadTask({...task,bytes:new Blob(["processed"]),recognitionStatus:undefined});
    const api={fetchUploadStatus:vi.fn(async()=>({...await receipt(),recognitionStatus:"succeeded" as const,transcriptBlockId:"actual-text"})),fetchAsset:vi.fn()};
    const result=await loadUploadPreview(task,{credential,online:true,repository:store,api});
    expect(result.task.recognitionStatus).toBe("succeeded");expect(result.task.transcriptBlockId).toBe("actual-text");expect(api.fetchAsset).not.toHaveBeenCalled();
  });
  it("scopes status requests and rejects an unrelated returned upload", async () => {
    const request=vi.fn<typeof fetch>().mockResolvedValue(Response.json({...await receipt(),uploadId:"other"}));
    const api=new CompanionApiClient("https://notes.test",request);
    await expect(api.fetchUploadStatus("test","upload",task)).rejects.toThrow("上传状态");
    expect(String(request.mock.calls[0]?.[0])).toContain("uploadId=upload&notebookId=book&sessionId=note");
  });
});
