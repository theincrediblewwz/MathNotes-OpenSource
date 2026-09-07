import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

// An exported source tree can sit inside another repository. Never label that
// export with the enclosing repository's commit.
export function macosBuildRevision(root, now = new Date()) {
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const top = git("rev-parse", "--show-toplevel");
  if (top.status === 0 && realpathSync(top.stdout.trim()) === realpathSync(root)) {
    const head = git("rev-parse", "--short=12", "HEAD");
    const status = git("status", "--porcelain", "--untracked-files=normal");
    if (head.status === 0 && /^[a-f0-9]{12,40}$/.test(head.stdout.trim()) && status.status === 0) {
      return `${head.stdout.trim()}${status.stdout.trim() ? "-modified" : ""}`;
    }
  }
  return `local-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
}
