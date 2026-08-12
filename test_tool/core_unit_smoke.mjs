import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;

if (!npmCli) {
  console.error("Cannot locate npm CLI from npm_execpath.");
  process.exit(1);
}

const testCommands = [
  ["test", "--workspace", "@mathnotes/windows", "--", "--run", "--maxWorkers=1"],
  ["test", "--workspace", "@mathnotes/shared", "--", "--run", "--maxWorkers=1"]
];

for (const args of testCommands) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: process.cwd(),
    stdio: "inherit"
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("core unit smoke passed");
