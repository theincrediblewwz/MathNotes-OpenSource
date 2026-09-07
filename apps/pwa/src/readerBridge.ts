/** The only script permitted in the opaque reader. Never interpolate note content into this source. */
export const READER_BRIDGE_SCRIPT = String.raw`(() => {
  const own = document.currentScript;
  const channel = own.dataset.channel;
  const anchor = own.dataset.anchor;
  const send = (kind, found) => parent.postMessage(found === undefined ? {type:'mathnotes-reader',channel,kind} : {type:'mathnotes-reader',channel,kind,found}, '*');
  let gesture = null;
  let tapTimer = 0;
  const outline = document.querySelector('.mathnotes-reader-outline');
  const closeOutline = () => { if (outline) outline.open = false; gesture = null; clearTimeout(tapTimer); tapTimer = 0; };
  const interactive = target => target instanceof Element && !!target.closest('a,button,input,textarea,select,label,details,summary,img,svg,video,audio,[role="button"],[role="dialog"],[contenteditable]');
  document.addEventListener('pointerdown', event => {
    if (outline && outline.open && !outline.contains(event.target)) { closeOutline(); return; }
    if (tapTimer) { clearTimeout(tapTimer); tapTimer = 0; gesture = null; return; }
    if (!event.isPrimary || event.button !== 0 || interactive(event.target) || String(getSelection() || '').trim()) { gesture = null; return; }
    gesture = {id:event.pointerId,x:event.clientX,y:event.clientY,time:performance.now(),scroll:window.scrollY};
  }, {passive:true});
  document.addEventListener('pointermove', event => { if (gesture && (Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)>8 || !event.isPrimary)) gesture = null; }, {passive:true});
  document.addEventListener('pointercancel', () => { gesture = null; }, {passive:true});
  document.addEventListener('scroll', () => { gesture = null; clearTimeout(tapTimer); tapTimer = 0; }, {passive:true,capture:true});
  document.addEventListener('selectionchange', () => { if (String(getSelection() || '').trim()) { clearTimeout(tapTimer); tapTimer = 0; } });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && outline && outline.open) { event.preventDefault(); closeOutline(); outline.querySelector('summary').focus({preventScroll:true}); }
  });
  window.addEventListener('blur', closeOutline);
  document.addEventListener('pointerup', event => {
    const start = gesture; gesture = null;
    if (!start || event.pointerId !== start.id || performance.now()-start.time > 450 || Math.hypot(event.clientX-start.x,event.clientY-start.y)>8 || window.scrollY !== start.scroll || interactive(event.target)) return;
    tapTimer = setTimeout(() => { tapTimer = 0; if (!String(getSelection() || '').trim()) send('toggle'); },280);
  }, {passive:true});
  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a') : null;
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute('href') || '';
    if (!/^#mathnotes-[a-zA-Z0-9._:-]+$/.test(href)) return;
    const target = document.getElementById(href.slice(1));
    if (!target) return;
    if (link.closest('.mathnotes-reader-outline')) closeOutline();
    target.scrollIntoView({block:'start'});
  });
  const ready = async () => {
    await Promise.all(Array.from(document.images, image => image.decode ? image.decode().catch(() => {}) : Promise.resolve()));
    if (document.fonts) await document.fonts.ready;
    send('ready');
    if (!anchor) return;
    const target = document.getElementById(anchor);
    if (target) { target.scrollIntoView({block:'start'}); target.classList.add('mathnotes-reader-located'); }
    send('located', !!target);
  };
  if (document.readyState === 'complete') void ready(); else window.addEventListener('load', () => void ready(), {once:true});
})();`;

export type ReaderBridgeMessage = { type: "mathnotes-reader"; channel: string; kind: "toggle" | "ready" } | { type: "mathnotes-reader"; channel: string; kind: "located"; found: boolean };
export function parseReaderBridgeMessage(event: Pick<MessageEvent, "origin" | "source" | "data">, frame: Window | null | undefined, channel: string): ReaderBridgeMessage | undefined {
  if (!frame || event.source !== frame || event.origin !== "null" || !channel || !event.data || typeof event.data !== "object") return;
  const data = event.data as Record<string, unknown>;
  if (data.type !== "mathnotes-reader" || data.channel !== channel) return;
  const expected = data.kind === "located" ? ["channel", "found", "kind", "type"] : ["channel", "kind", "type"];
  if (Object.keys(data).sort().join() !== expected.join()) return;
  if (data.kind === "located" && typeof data.found === "boolean") return data as ReaderBridgeMessage;
  if (data.kind === "toggle" || data.kind === "ready") return data as ReaderBridgeMessage;
}

export async function readerBridgeHash(): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(READER_BRIDGE_SCRIPT));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}
