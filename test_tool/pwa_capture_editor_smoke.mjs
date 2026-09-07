import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const url = process.env.PWA_CAPTURE_QA_URL || "http://127.0.0.1:4176";
const output = process.env.PWA_CAPTURE_QA_OUTPUT || path.join(tmpdir(), "mathnotes-pwa-capture-qa");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
function check(value, message) { if (!value) throw new Error(message); }
try {
  await page.goto(url);
  await page.locator("body").waitFor();
  const pixels = await page.evaluate(async () => {
    const editing = await import("/src/captureEditing.ts");
    const source = document.createElement("canvas"); source.width = 800; source.height = 600;
    const context = source.getContext("2d");
    context.fillStyle="#fff";context.fillRect(0,0,800,600);
    context.fillStyle="#e02020";context.fillRect(0,0,200,600);
    context.fillStyle="#20b040";context.fillRect(200,0,200,600);
    context.fillStyle="#2060e0";context.fillRect(400,0,200,600);
    context.fillStyle="#f0c020";context.fillRect(600,0,200,600);
    context.fillStyle="#fff";context.font="42px sans-serif";context.fillText("PRIVATE 123",220,310);
    const file=new File([await new Promise(resolve=>source.toBlob(resolve,"image/png"))],"board.png",{type:"image/png"});
    window.qaFile=file;
    async function inspect(file, positions) {
      const bitmap=await createImageBitmap(file);const c=document.createElement("canvas");c.width=bitmap.width;c.height=bitmap.height;
      const ctx=c.getContext("2d");ctx.drawImage(bitmap,0,0);bitmap.close();
      return {width:c.width,height:c.height,pixels:positions.map(([x,y])=>[...ctx.getImageData(x,y,1,1).data])};
    }
    const cropped=await editing.applyCaptureEdit(file,{rotation:0,crop:"original",cropRect:{x:.25,y:0,width:.5,height:1}});
    const redacted=await editing.applyCaptureEdit(file,{rotation:0,crop:"original",marks:[
      {type:"redaction",points:[{x:.25,y:.5},{x:.75,y:.5}],width:.1},
      {type:"pen",points:[{x:.25,y:.5},{x:.75,y:.5}],width:.01}
    ]});
    const rotated=await editing.applyCaptureEdit(file,editing.rotateCapture({rotation:0,crop:"original",marks:[{type:"redaction",points:[{x:.25,y:.5},{x:.75,y:.5}],width:.1}]},"right"));
    const rectangleEdit={rotation:0,crop:"original",marks:[{type:"rectangleRedaction",points:[{x:.25,y:.4},{x:.75,y:.6}],width:.007},{type:"pen",points:[{x:.25,y:.5},{x:.75,y:.5}],width:.02}]};
    const whiteRectangle=await editing.applyCaptureEdit(file,rectangleEdit);
    const whiteRotated=await editing.applyCaptureEdit(file,editing.rotateCapture(rectangleEdit,"right"));
    const whiteCropped=await editing.applyCaptureEdit(file,{...rectangleEdit,cropRect:{x:.25,y:.25,width:.75,height:.75}});
    const whitePerspective=await editing.applyCapturePerspective(file,rectangleEdit,[{x:.1,y:.1},{x:.9,y:.08},{x:.88,y:.92},{x:.12,y:.9}]);
    const lasso=await editing.applyCaptureEdit(file,{rotation:0,crop:"original",lasso:[{x:0,y:0},{x:1,y:0},{x:.5,y:1}]});
    const perspective=await editing.applyCapturePerspective(file,{rotation:0,crop:"original"},[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}]);
    const encoded=new Uint8Array(await new Promise(resolve=>source.toBlob(async blob=>resolve(await blob.arrayBuffer()),"image/jpeg")));
    const exif=new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0]);
    const oriented=new File([encoded.slice(0,2),exif,encoded.slice(2)],"orientation6.jpg",{type:"image/jpeg"});
    const exifImage=await editing.acquireCaptureImage(oriented);
    const large=document.createElement("canvas");large.width=8000;large.height=2000;const largeContext=large.getContext("2d");
    largeContext.fillStyle="#fff";largeContext.fillRect(0,0,8000,2000);largeContext.fillStyle="#000";
    for(let x=3000;x<4000;x+=2) largeContext.fillRect(x,700,1,600);
    const largeFile=new File([await new Promise(resolve=>large.toBlob(resolve,"image/png"))],"8k-small-text.png",{type:"image/png"});
    const selection={x:.375,y:.35,width:.125,height:.3};
    const largeCrop=await editing.applyCaptureEdit(largeFile,{rotation:0,crop:"original",cropRect:selection});
    const largePerspective=await editing.applyCapturePerspective(largeFile,{rotation:0,crop:"original"},editing.rectPoints(selection));
    const results={crop:await inspect(cropped,[[0,30],[399,30]]),redaction:await inspect(redacted,[[400,300],[400,275]]),rotation:await inspect(rotated,[[300,400]]),lasso:await inspect(lasso,[[5,590],[400,500]]),perspective:await inspect(perspective,[[10,10],[790,590]]),exif:{width:exifImage.width,height:exifImage.height},largeCrop:await inspect(largeCrop,[[0,30],[1,30],[998,30],[999,30]]),largePerspective:await inspect(largePerspective,[[0,30],[1,30]])};
    results.whiteRectangle=await inspect(whiteRectangle,[[400,300],[200,240],[199,240]]);
    results.whiteRotated=await inspect(whiteRotated,[[300,400]]);
    results.whiteCropped=await inspect(whiteCropped,[[200,150]]);
    results.whitePerspective=await inspect(whitePerspective,[[300,250]]);
    editing.releaseCaptureImage(oriented);return results;
  });
  check(pixels.crop.width===400 && pixels.crop.height===600,"crop output dimensions differ from selected green border");
  check(pixels.crop.pixels[0].join() === "32,176,64,255" && pixels.crop.pixels[1].join() === "32,96,224,255","crop selected wrong edges");
  check(pixels.redaction.pixels.every(pixel=>pixel.join()==="0,0,0,255"),"redaction leaked source or later pen");
  check(pixels.rotation.width===600 && pixels.rotation.height===800 && pixels.rotation.pixels[0].join()==="0,0,0,255","rotation lost privacy mask");
  check(pixels.lasso.pixels[0].join()==="255,255,255,255","lasso outside was not flattened white");
  check(pixels.perspective.width===800 && pixels.perspective.height===600,"identity perspective changed dimensions");
  check(pixels.exif.width===600 && pixels.exif.height===800,"EXIF orientation was ignored or applied twice");
  check(pixels.largeCrop.width===1000 && pixels.largeCrop.height===600 && pixels.largeCrop.pixels.map(p=>p[0]).join()==="0,255,0,255","8K small crop lost original text pixels before cropping");
  check(pixels.largePerspective.width===1000 && pixels.largePerspective.height===600 && pixels.largePerspective.pixels.map(p=>p[0]).join()==="0,255","8K perspective selection lost source detail before correction");
  for(const result of [pixels.whiteRotated,pixels.whiteCropped,pixels.whitePerspective]) check(result.pixels[0].join()==="255,255,255,255","white rectangle leaked after transform");
  check(pixels.whiteRectangle.pixels[0].join()==="255,255,255,255"&&pixels.whiteRectangle.pixels[1].join()==="255,255,255,255"&&pixels.whiteRectangle.pixels[2].join()!=="255,255,255,255","white rectangle boundary differed from selected region");
  await page.evaluate(async () => {
    const reactModule=await import("/node_modules/.vite/deps/react.js"),clientModule=await import("/node_modules/.vite/deps/react-dom_client.js"),{CaptureBatchEditor}=await import("/src/App.tsx");
    const React=reactModule.default??reactModule,{createRoot}=clientModule.default??clientModule;
    const originalDecode=window.createImageBitmap.bind(window);window.qaDecodeCalls=0;
    window.createImageBitmap=(...args)=>{window.qaDecodeCalls++;return originalDecode(...args);};
    const host=document.createElement("div");document.body.replaceChildren(host);
    function Harness() {
      const [drafts,setDrafts]=React.useState([{id:"fixture",file:window.qaFile,edit:{rotation:0,crop:"original"}}]);
      window.qaEdit=drafts[0].edit;
      return React.createElement(CaptureBatchEditor,{drafts,activeIndex:0,target:{notebookId:"qa",notebookTitle:"论文阅读",sessionId:"board",title:"黑板笔记"},error:"",isPreparing:false,
        onActiveIndex(){},onEdit(id,edit){setDrafts(rows=>rows.map(row=>row.id===id?{...row,edit}:row));},onReplaceFile(id,file){setDrafts([{id,file,edit:{rotation:0,crop:"original"}}]);},onDelete(){},onCaptureMore(){},onCancel(){},
        async onConfirm(){const {applyCaptureEdit}=await import("/src/captureEditing.ts");window.qaUploaded=await applyCaptureEdit(drafts[0].file,drafts[0].edit);}});
    }
    createRoot(host).render(React.createElement(Harness));
  });
  await page.getByRole("dialog",{name:"素材预览与拍后编辑"}).waitFor();
  await page.waitForFunction(()=>!document.body.textContent.includes("正在打开照片"));
  const canvas=page.getByLabel("照片编辑画布，拖动四角裁剪");const bounds=await canvas.boundingBox();
  const rect=await page.evaluate(async ({width,height})=>(await import("/src/captureEditing.ts")).fittedCaptureRect(width,height,800,600),bounds);
  check(rect.x>=27 && rect.y>=27,"crop handles are not inset from all canvas edges");
  await page.mouse.move(bounds.x+rect.x,bounds.y+rect.y);await page.mouse.down();
  await page.mouse.move(bounds.x+rect.x+rect.width*.25,bounds.y+rect.y+rect.height*.25,{steps:8});await page.mouse.up();
  const crop=await page.evaluate(()=>window.qaEdit.cropRect);
  check(Math.abs(crop.x-.25)<.01 && Math.abs(crop.y-.25)<.01,"drag handle coordinates diverged from displayed image");
  check(await page.getByRole("button",{name:"马赛克",exact:true}).count()===0,"mosaic is not nested in the pen menu");
  await page.getByRole("button",{name:"画笔",exact:true}).click();
  await page.getByRole("group",{name:"画笔选项"}).getByRole("button",{name:"马赛克",exact:true}).click();
  async function drawRectangle(){
    await canvas.scrollIntoViewIfNeeded();
    const currentBounds=await canvas.boundingBox();
    const currentRect=await page.evaluate(async({width,height})=>(await import("/src/captureEditing.ts")).fittedCaptureRect(width,height,800,600),currentBounds);
    await page.mouse.move(currentBounds.x+currentRect.x+currentRect.width*.35,currentBounds.y+currentRect.y+currentRect.height*.42);await page.mouse.down();
    await page.mouse.move(currentBounds.x+currentRect.x+currentRect.width*.65,currentBounds.y+currentRect.y+currentRect.height*.58,{steps:12});await page.mouse.up();
  }
  await drawRectangle();
  check(await page.evaluate(()=>window.qaEdit.marks.some(mark=>mark.type==="rectangleRedaction")),"rectangle redaction gesture did not persist");
  await page.getByRole("button",{name:"撤销",exact:true}).click();
  check(await page.evaluate(()=>!window.qaEdit.marks?.length),"undo did not restore pre-mask edit");
  await drawRectangle();
  await page.waitForTimeout(80);
  const previewPixel=await canvas.evaluate(canvas=>[...canvas.getContext("2d").getImageData(Math.floor(canvas.width*.5),Math.floor(canvas.height*.5),1,1).data]);
  check(previewPixel.join()==="255,255,255,255","displayed rectangle did not use opaque white");
  const editingDecodeCalls=await page.evaluate(()=>window.qaDecodeCalls);
  check(editingDecodeCalls===1,"dragging and drawing decoded the full image again");
  await page.screenshot({path:path.join(output,"pwa-capture-mobile.png")});
  await page.getByRole("button",{name:"确认上传 1 张"}).click();
  await page.waitForFunction(()=>window.qaUploaded instanceof File);
  const uploaded=await page.evaluate(async()=>{const bitmap=await createImageBitmap(window.qaUploaded);const result={width:bitmap.width,height:bitmap.height,type:window.qaUploaded.type};bitmap.close();return result;});
  check(Math.abs(uploaded.width-600)<=1 && Math.abs(uploaded.height-450)<=1 && uploaded.type==="image/png","UI confirmation failed to flatten exact crop to upload file");
  await page.getByRole("button",{name:"透视",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('button[aria-pressed="true"]')?.textContent==="透视" && !document.body.textContent.includes("正在打开照片"));
  await page.getByRole("button",{name:"应用透视",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('button[aria-pressed="true"]')?.textContent==="矩形裁剪" && !document.body.textContent.includes("正在打开照片"));
  await page.evaluate(()=>{window.qaUploaded=null;});
  await page.getByRole("button",{name:"确认上传 1 张"}).click();await page.waitForFunction(()=>window.qaUploaded instanceof File);
  const afterPerspective=await page.evaluate(async()=>{const bitmap=await createImageBitmap(window.qaUploaded);const size=[bitmap.width,bitmap.height];bitmap.close();return size;});
  check(afterPerspective.join()==="600,450","switching to perspective discarded the previously selected crop");
  await page.setViewportSize({width:1180,height:820});await page.screenshot({path:path.join(output,"pwa-capture-desktop.png")});
  check(!await page.locator("vite-error-overlay").count(),"Vite error overlay present");
  check(!errors.length,`browser errors: ${errors.join(" | ")}`);
  const report={url,title:await page.title(),pixels,previewPixel,uploaded,afterPerspective,editingDecodeCalls,penSubmenu:true,undo:true,errors,mobileScreenshot:path.join(output,"pwa-capture-mobile.png"),desktopScreenshot:path.join(output,"pwa-capture-desktop.png")};
  await writeFile(path.join(output,"result.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {await browser.close();}
