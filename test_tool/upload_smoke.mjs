import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;

if (!npmCli) {
  console.error("Cannot locate npm CLI from npm_execpath.");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [npmCli, "run", "test", "--workspace", "@mathnotes/windows", "--", "ingestServer"],
  {
    cwd: process.cwd(),
    stdio: "inherit"
  }
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log("upload smoke passed");
