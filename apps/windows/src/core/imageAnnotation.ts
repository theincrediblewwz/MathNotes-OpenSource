export function decodePngDataUrl(dataUrl: string): Buffer {
  const match = /^data:image\/png;base64,([a-zA-Z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!match) {
    throw new Error("Expected a PNG data URL.");
  }
  return Buffer.from(match[1], "base64");
}

export function markdownForEmbeddedAsset(assetPath: string): string {
  return `![图](../${assetPath.replace(/\\/g, "/")})`;
}
