import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import readline from "node:readline/promises";
import {
  DEFAULT_IMAGE_HOSTS, RepairError, createPlan, applyOperation, restoreBackup
} from "./core.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE = path.join(ROOT, ".private");
fs.mkdirSync(PRIVATE, {recursive: true});

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(name); }
function safeName(prefix) { return prefix + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json"; }
function writePrivate(name, data) {
  const file = path.join(PRIVATE, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", {encoding:"utf8", flag:"wx", mode:0o600});
  return file;
}
async function authKey() {
  if (process.env.STREMIO_AUTHKEY) return process.env.STREMIO_AUTHKEY.trim();
  if (!flag("--auth-stdin")) throw new RepairError("STREMIO_AUTH_REQUIRED", "Use STREMIO_AUTHKEY or --auth-stdin");
  const rl = readline.createInterface({input: process.stdin, output: process.stderr, terminal: false});
  const value = String(await rl.question("Stremio AuthKey: ")).trim();
  rl.close();
  return value;
}
function hosts() {
  const extra = String(arg("--image-hosts", "")).split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...DEFAULT_IMAGE_HOSTS, ...extra])];
}
function load(file) { return JSON.parse(fs.readFileSync(path.resolve(file), "utf8")); }

async function main() {
  const command = process.argv[2] || "help";
  if (command === "help") {
    console.log("Library Artwork Repair: audit|plan --metadata-root <https-url> [--ids tt...,tt...] [--max 10] [--auth-stdin] | apply <plan.json> --ack-account-write [--auth-stdin] | restore <backup.json> --ack-account-write [--auth-stdin]");
    return;
  }
  const key = await authKey();
  if (command === "audit" || command === "plan") {
    const metadataRoot = arg("--metadata-root", process.env.METADATA_ROOT);
    if (!metadataRoot) throw new RepairError("METADATA_ROOT_REQUIRED");
    const max = Number(arg("--max", "10"));
    const ids = String(arg("--ids", "")).split(",").map(x=>x.trim()).filter(Boolean);
    const plan = await createPlan({authKey:key, metadataRoot, allowedHosts:hosts(), maxChanges:max, ids});
    const summary = {checked:plan.checked, candidates:plan.operations.length, skipped:plan.skipped.length, changes:plan.operations.map(x=>({id:x.id,type:x.type,reason:x.reason,from:x.before.poster,to:x.nextPoster}))};
    if (command === "audit") { console.log(JSON.stringify(summary, null, 2)); return; }
    const file = writePrivate(safeName("plan"), plan);
    console.log(JSON.stringify({...summary, plan:file}, null, 2));
    return;
  }
  if (command === "apply") {
    if (!flag("--ack-account-write")) throw new RepairError("ACK_ACCOUNT_WRITE_REQUIRED");
    const planPath = process.argv[3];
    if (!planPath) throw new RepairError("PLAN_REQUIRED");
    const plan = load(planPath);
    if (plan?.schema !== 1 || plan?.kind !== "stremio-library-artwork-repair" || !Array.isArray(plan.operations)) throw new RepairError("PLAN_INVALID");
    const results = [];
    for (const op of plan.operations) {
      const backupPath = writePrivate(safeName("backup-" + op.id), {
        schema:1, createdAt:new Date().toISOString(), account:plan.account,
        operationId:op.id, before:op.before, candidate:{...op.before, poster:op.nextPoster}
      });
      try {
        await applyOperation({authKey:key, account:plan.account, operation:op, allowedHosts:plan.allowedHosts, fetchImpl:fetch});
        results.push({id:op.id,status:"VERIFIED",backup:backupPath});
      } catch (error) {
        results.push({id:op.id,status:"STOPPED",code:error?.code || "WRITE_FAILED",backup:backupPath});
        console.log(JSON.stringify({status:"STOPPED",results}, null, 2));
        process.exitCode = 1;
        return;
      }
    }
    console.log(JSON.stringify({status:"VERIFIED",results}, null, 2));
    return;
  }
  if (command === "restore") {
    if (!flag("--ack-account-write")) throw new RepairError("ACK_ACCOUNT_WRITE_REQUIRED");
    const backupPath = process.argv[3];
    if (!backupPath) throw new RepairError("BACKUP_REQUIRED");
    const backup = load(backupPath);
    await restoreBackup({authKey:key, backup});
    console.log(JSON.stringify({status:"RESTORED",id:backup.before._id}, null, 2));
    return;
  }
  throw new RepairError("UNKNOWN_COMMAND");
}

main().catch(error=>{
  console.error(JSON.stringify({error:error?.code || "COMMAND_FAILED", message:error?.message || String(error)}));
  process.exitCode=1;
});
