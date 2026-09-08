/** Strip URL query/fragment syntax before decoding once: %23/%25 are filename characters. */
export function sessionAssetPathFromMarkdown(target: string): string | undefined {
  let path: string;
  try { path = decodeURIComponent(target.split(/[?#]/, 1)[0]); } catch { return undefined; }
  if (path.startsWith("../assets/")) path = path.slice(3);
  else if (path.startsWith("./assets/")) path = path.slice(2);
  if (!path.startsWith("assets/") || path.length > 4096 || path.split("/").some(part =>
    !part || part === "." || part === ".." || /[\\/\x00-\x1f\x7f<>:\"|?*]/.test(part) ||
    /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return undefined;
  return path;
}

/** Encode segments, including parentheses, so Markdown cannot truncate the destination. */
export function encodeMarkdownAssetPath(path: string): string {
  return path.split("/").map(part => encodeURIComponent(part).replace(/[!'()*]/g,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
}
