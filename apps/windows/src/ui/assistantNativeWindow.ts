export const assistantWindowName = "mathnotes-assistant";
export const assistantPortalRootId = "mathnotes-assistant-root";

export type AssistantNativeWindow = Readonly<{
  window: Window;
  root: HTMLElement;
}>;

export function openAssistantNativeWindow(opener: Window = window): AssistantNativeWindow | null {
  const assistantWindow = opener.open(
    "",
    assistantWindowName,
    "width=560,height=760,resizable=yes,scrollbars=no"
  );
  if (!assistantWindow) return null;
  const root = prepareAssistantWindowDocument(opener.document, assistantWindow.document);
  assistantWindow.focus();
  return { window: assistantWindow, root };
}

export function prepareAssistantWindowDocument(source: Document, target: Document): HTMLElement {
  target.title = "MathNotes · 与笔记对话";
  target.documentElement.lang = "zh-CN";
  target.documentElement.classList.add("mathnotes-assistant-document");
  const theme = source.documentElement.getAttribute("data-theme");
  if (theme) target.documentElement.setAttribute("data-theme", theme);
  else target.documentElement.removeAttribute("data-theme");

  let viewport = target.head.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!viewport) {
    viewport = target.createElement("meta");
    viewport.name = "viewport";
    target.head.append(viewport);
  }
  viewport.content = "width=device-width, initial-scale=1";

  target.head.querySelectorAll("[data-mathnotes-assistant-style]").forEach((node) => node.remove());
  source.head.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style').forEach((node) => {
    const clone = node.cloneNode(true) as HTMLLinkElement | HTMLStyleElement;
    clone.dataset.mathnotesAssistantStyle = "true";
    if (node.tagName === "LINK") clone.setAttribute("href", (node as HTMLLinkElement).href);
    target.head.append(clone);
  });

  const existingRoot = target.getElementById(assistantPortalRootId);
  const root = existingRoot ?? target.createElement("div");
  root.id = assistantPortalRootId;
  target.body.className = "mathnotes-assistant-window";
  if (!existingRoot) target.body.replaceChildren(root);
  return root;
}
