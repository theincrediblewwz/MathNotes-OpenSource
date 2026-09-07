// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { addReaderOutline } from "./readerDocument";
import { parseReaderBridgeMessage } from "./readerBridge";
import { locateUploadInSession } from "./uploadLocation";
import type { CachedAsset, CachedSession, UploadTask } from "./domain";

describe("isolated reader navigation", () => {
  it("accepts only the exact current opaque iframe and a closed message schema", () => {
    const frame={} as Window;
    const event={origin:"null",source:frame,data:{type:"mathnotes-reader",channel:"random",kind:"toggle"}};
    expect(parseReaderBridgeMessage(event,frame,"random")?.kind).toBe("toggle");
    for (const changed of [{source:{} as Window},{origin:"https://notes.test"},{data:{...event.data,channel:"forged"}},{data:{...event.data,url:"https://evil"}},{data:{...event.data,kind:"execute"}},{data:{...event.data,kind:"located",found:"yes"}}]) expect(parseReaderBridgeMessage({...event,...changed},frame,"random")).toBeUndefined();
  });
  it("creates a collapsed hierarchical outline and anchors older block snapshots", () => {
    const document=new DOMParser().parseFromString(addReaderOutline('<section data-block-id="transcript"><h2>大标题</h2><h3>小标题</h3></section>'),"text/html");
    expect(document.querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(document.querySelector("section")?.id).toBe("mathnotes-block-transcript");
    expect(document.querySelectorAll("nav a")).toHaveLength(2);
    expect(document.querySelectorAll("nav a")[1].getAttribute("style")).toContain("28px");
  });
  it("chooses the actual transcript image, falls back to its text, and refuses deleted blocks", () => {
    const session:CachedSession={key:"phone",version:1,title:"test",revision:"r1",updatedAt:"now",blockCount:1,markdown:"",syncedAt:"now",profileId:"phone",notebookId:"book",sessionId:"note",assets:[{id:"asset",path:"assets/a.png",mimeType:"image/png"}],html:'<section id="mathnotes-block-text" data-block-id="text"><p>context</p><img id="mathnotes-block-text-asset-asset" data-companion-asset-id="asset"></section>'};
    const task={profileId:"phone",notebookId:"book",sessionId:"note",transcriptBlockId:"text",imageBlockId:"hidden",assetPath:"assets/a.png"} as UploadTask;
    const assets=[{assetId:"asset",bytes:new Blob(["photo"])}] as CachedAsset[];
    expect(locateUploadInSession(session,task,assets).anchor).toBe("mathnotes-block-text-asset-asset");
    expect(locateUploadInSession(session,task,[])).toEqual({anchor:"mathnotes-block-text",notice:"图片尚未同步，已定位对应的转写内容。"});
    expect(()=>locateUploadInSession({...session,html:"<p>removed</p>"},task,assets)).toThrow("正文块已不存在");
  });
});
