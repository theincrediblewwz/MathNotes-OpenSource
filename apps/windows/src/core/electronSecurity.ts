import path from "node:path";
import { fileURLToPath } from "node:url";

export function isTrustedRendererUrl(args: {
  candidateUrl: string;
  devServerUrl?: string;
  distRootDir: string;
}): boolean {
  let candidate: URL;
  try {
    candidate = new URL(args.candidateUrl);
  } catch {
    return false;
  }

  if (args.devServerUrl) {
    try {
      if (candidate.origin === new URL(args.devServerUrl).origin) return true;
    } catch {
      return false;
    }
  }

  if (candidate.protocol !== "file:") return false;
  const candidatePath = path.resolve(fileURLToPath(candidate));
  const distRootDir = path.resolve(args.distRootDir);
  const relative = path.relative(distRootDir, candidatePath);
  return relative === "index.html" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
