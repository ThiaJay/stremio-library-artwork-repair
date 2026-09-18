import {spawnSync} from "node:child_process";
for (const file of ["src/core.js", "src/cli.js", "src/worker.js", "scripts/hosted-backups.mjs"]) {
  const result = spawnSync(process.execPath, ["--check", file], {stdio:"inherit"});
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log("PASS: source syntax checks");
