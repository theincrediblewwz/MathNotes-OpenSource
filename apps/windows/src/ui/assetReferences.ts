export type AssetPreviewReference = {
  absolutePath: string;
  assetPath: string;
  label: string;
  mediaType: "image" | "pdf";
  previewUrl: string;
  pageNumber?: number;
};

export type MarkdownImageReference = {
  from: number;
  to: number;
  target: string;
};

const markdownImagePattern = /!\[[^\]]*]\((?<target>[^)\n]+)\)/g;

export function resolveSessionAssetPreview(args: {
  sessionDir?: string;
  target?: string;
  pageNumber?: number;
}): AssetPreviewReference | null {
  if (!args.sessionDir || !args.target) {
    return null;
  }

  const assetPath = normalizeSessionAssetPath(args.target);
  if (!assetPath) {
    return null;
  }

  const absolutePath = joinSessionPath(args.sessionDir, assetPath);
  const label = assetPath.split("/").filter(Boolean).at(-1) ?? assetPath;
  return {
    absolutePath,
    assetPath,
    label,
    mediaType: label.toLowerCase().endsWith(".pdf") ? "pdf" : "image",
    previewUrl: toAssetProtocolUrl(absolutePath),
    pageNumber: args.pageNumber
  };
}

export function findMarkdownImageReferenceAtPosition(markdown: string, position: number): MarkdownImageReference | null {
  markdownImagePattern.lastIndex = 0;
  for (const match of markdown.matchAll(markdownImagePattern)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    if (position < from || position > to) {
      continue;
    }
    const target = match.groups?.target?.trim();
    if (!target) {
      continue;
    }
    return { from, to, target };
  }
  return null;
}

export function normalizeSessionAssetPath(target: string): string | null {
  const withoutAnchor = target.trim().split("#", 1)[0]?.split("?", 1)[0] ?? "";
  let decoded: string;
  try {
    // Markdown-it URL-encodes image destinations. Decode once, then validate
    // the resulting path before the local asset protocol encodes it again.
    decoded = decodeURIComponent(withoutAnchor);
  } catch {
    return null;
  }
  const normalized = decoded.replace(/\\/g, "/");
  const assetPath = normalized.startsWith("../assets/")
    ? normalized.slice(3)
    : normalized.startsWith("assets/")
      ? normalized
      : null;

  if (!assetPath || /[\u0000-\u001f\u007f:]/.test(assetPath)
    || assetPath.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  return assetPath;
}

export function toAssetProtocolUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const protocolPath = normalized
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
    .replace(/%3A/g, ":");
  return `mathnotes-asset://local/${protocolPath}`;
}

function joinSessionPath(sessionDir: string, assetPath: string): string {
  const separator = sessionDir.includes("\\") ? "\\" : "/";
  return `${sessionDir.replace(/[\\/]+$/g, "")}${separator}${assetPath.replace(/\//g, separator)}`;
}
