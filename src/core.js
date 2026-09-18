import crypto from "node:crypto";

export const STREMIO_API = "https://api.strem.io/api";
export const DEFAULT_IMAGE_HOSTS = Object.freeze([
  "image.tmdb.org",
  "artworks.thetvdb.com",
  "images.metahub.space"
]);

export class RepairError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "RepairError";
    this.code = code;
  }
}

export function assert(condition, code, message = code) {
  if (!condition) throw new RepairError(code, message);
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function recordHash(value) {
  return sha256(JSON.stringify(value));
}

function isIpLiteral(host) {
  return /^\d+(?:\.\d+){3}$/.test(host) || /^\[.*\]$/.test(host) || host.includes(":");
}

export function validateSourceRoot(raw) {
  let url;
  try { url = new URL(String(raw || "").trim()); } catch { throw new RepairError("INVALID_METADATA_ROOT"); }
  const host = url.hostname.toLowerCase();
  assert(url.protocol === "https:", "METADATA_ROOT_REQUIRES_HTTPS");
  assert(!url.username && !url.password && !url.hash && !url.search, "METADATA_ROOT_CREDENTIALS_OR_QUERY_BLOCKED");
  assert(!url.port || url.port === "443", "METADATA_ROOT_NONSTANDARD_PORT_BLOCKED");
  assert(!["localhost", "127.0.0.1", "::1"].includes(host) && !host.endsWith(".local") && !isIpLiteral(host), "METADATA_ROOT_LOCAL_OR_IP_BLOCKED");
  url.pathname = url.pathname.replace(/\/manifest\.json$/i, "").replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function safePoster(raw, allowedHosts = DEFAULT_IMAGE_HOSTS) {
  if (typeof raw !== "string" || raw.length < 8 || raw.length > 4096) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    return u.protocol === "https:" && !u.username && !u.password && !u.hash &&
      (!u.port || u.port === "443") && allowedHosts.map(x => x.toLowerCase()).includes(host);
  } catch { return false; }
}

export function canonicalPoster(raw, allowedHosts = DEFAULT_IMAGE_HOSTS) {
  if (typeof raw !== "string") return raw;
  try {
    const u = new URL(raw);
    if (!/^\/(?:poster-cache\/proxy\/)?poster\/(?:movie|series)\/tt\d{5,12}$/i.test(u.pathname)) return raw;
    const fallback = u.searchParams.get("fallback");
    if (!fallback || !safePoster(fallback, allowedHosts)) return raw;
    const f = new URL(fallback);
    if (/\/missing_poster\.(?:png|jpe?g|webp)$/i.test(f.pathname)) return raw;
    return f.toString();
  } catch { return raw; }
}

const AIOMETA_POSTER_HOST = /^[a-z0-9-]+-aiometadata\.elfhosted\.com$/i;

export function decoratedPoster(raw, type, id, allowedHosts = DEFAULT_IMAGE_HOSTS) {
  if (typeof raw !== "string" || !["movie","series"].includes(type) || !/^tt\d{5,12}$/.test(id)) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.hash || (u.port && u.port !== "443")) return null;
    if (!AIOMETA_POSTER_HOST.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/(?:poster-cache\/proxy\/)?poster\/(movie|series)\/(tt\d{5,12})$/i);
    if (!m || m[1].toLowerCase() !== type || m[2] !== id) return null;
    const key = u.searchParams.get("key") || "";
    if (!key || key.length > 256) return null;
    const fallback = u.searchParams.get("fallback");
    if (!fallback || !safePoster(fallback, allowedHosts)) return null;
    const f = new URL(fallback);
    if (/\/missing_poster\.(?:png|jpe?g|webp)$/i.test(f.pathname)) return null;
    return {url:u.toString(),fallback:f.toString(),host:u.hostname.toLowerCase()};
  } catch { return null; }
}

export function safePosterForItem(raw, type, id, allowedHosts = DEFAULT_IMAGE_HOSTS) {
  return safePoster(raw, allowedHosts) || !!decoratedPoster(raw, type, id, allowedHosts);
}

export function sameExceptArtworkAndMtime(before, after) {
  const a = structuredClone(before);
  const b = structuredClone(after);
  delete a.poster; delete b.poster;
  delete a.posterShape; delete b.posterShape;
  delete a._mtime; delete b._mtime;
  return JSON.stringify(a) === JSON.stringify(b);
}

async function boundedJson(response, limit = 12_000_000) {
  const size = Number(response.headers.get("content-length") || 0);
  assert(!size || size <= limit, "RESPONSE_TOO_LARGE");
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(bytes.byteLength <= limit, "RESPONSE_TOO_LARGE");
  let data;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new RepairError("INVALID_JSON_RESPONSE"); }
  return data;
}

export async function fetchJson(url, init = {}, fetchImpl = fetch, limit = 12_000_000) {
  const response = await fetchImpl(url, {
    ...init,
    redirect: "error",
    signal: init.signal || AbortSignal.timeout(15000)
  });
  assert(response.ok, "UPSTREAM_HTTP_" + response.status);
  return boundedJson(response, limit);
}

export async function stremioCall(authKey, endpoint, args = {}, fetchImpl = fetch) {
  assert(typeof authKey === "string" && authKey.length >= 8, "STREMIO_AUTH_REQUIRED");
  assert(["getUser", "datastoreGet", "datastorePut"].includes(endpoint), "STREMIO_ENDPOINT_BLOCKED");
  return (await fetchJson(`${STREMIO_API}/${endpoint}`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({...args, authKey})
  }, fetchImpl)).result;
}

export async function accountFingerprint(authKey, fetchImpl = fetch) {
  const user = await stremioCall(authKey, "getUser", {}, fetchImpl);
  const id = user?._id ?? user?.id;
  assert(typeof id === "string" && id.length > 0, "STREMIO_ACCOUNT_ID_MISSING");
  return sha256("stremio:" + id);
}

export async function library(authKey, ids = [], fetchImpl = fetch) {
  assert(Array.isArray(ids) && ids.length <= 500, "INVALID_LIBRARY_IDS");
  const seen = new Set();
  for (const id of ids) {
    assert(typeof id === "string" && /^tt\d{5,12}$/.test(id), "INVALID_LIBRARY_ID");
    assert(!seen.has(id), "DUPLICATE_LIBRARY_ID");
    seen.add(id);
  }
  const result = await stremioCall(authKey, "datastoreGet", {
    collection: "libraryItem",
    ids,
    all: ids.length === 0
  }, fetchImpl);
  assert(Array.isArray(result), "INVALID_STREMIO_LIBRARY");
  assert(result.length <= 20000, "LIBRARY_LIMIT");
  return result;
}

export async function metadata(root, type, id, fetchImpl = fetch) {
  assert(["movie", "series"].includes(type), "INVALID_MEDIA_TYPE");
  assert(/^tt\d{5,12}$/.test(id), "INVALID_IMDB_ID");
  const base = validateSourceRoot(root);
  const data = await fetchJson(`${base}/meta/${type}/${encodeURIComponent(id)}.json`, {}, fetchImpl, 6_000_000);
  assert(data?.meta?.id === id && data.meta.type === type, "METADATA_IDENTITY_MISMATCH");
  return data.meta;
}

export function operationFor(item, meta, allowedHosts = DEFAULT_IMAGE_HOSTS) {
  if (!item || !["movie", "series"].includes(item.type) || !/^tt\d{5,12}$/.test(item._id)) return null;
  if (item.removed && !item.temp) return null;
  assert(meta?.id === item._id && meta?.type === item.type, "METADATA_IDENTITY_MISMATCH");
  const decorated = decoratedPoster(meta.poster, item.type, item._id, allowedHosts);
  const nextPoster = decorated ? decorated.url : canonicalPoster(meta.poster, allowedHosts);
  if (!safePosterForItem(nextPoster, item.type, item._id, allowedHosts) || item.poster === nextPoster) return null;
  return {
    id: item._id,
    type: item.type,
    beforeHash: recordHash(item),
    before: structuredClone(item),
    nextPoster,
    sourcePoster: meta.poster,
    reason: decorated ? "identity-bound-decorated-current" : nextPoster !== meta.poster ? "canonical-fallback" : "metadata-current"
  };
}

export async function createPlan({authKey, metadataRoot, allowedHosts = DEFAULT_IMAGE_HOSTS, maxChanges = 10, ids = [], fetchImpl = fetch}) {
  assert(Number.isInteger(maxChanges) && maxChanges >= 1 && maxChanges <= 100, "INVALID_MAX_CHANGES");
  const [account, items] = await Promise.all([
    accountFingerprint(authKey, fetchImpl),
    library(authKey, ids, fetchImpl)
  ]);
  const operations = [], skipped = [];
  for (const item of items) {
    if (operations.length >= maxChanges) break;
    if (!item || !["movie", "series"].includes(item.type) || !/^tt\d{5,12}$/.test(item._id) || (item.removed && !item.temp)) continue;
    try {
      const meta = await metadata(metadataRoot, item.type, item._id, fetchImpl);
      const op = operationFor(item, meta, allowedHosts);
      if (op) operations.push(op);
    } catch (error) {
      skipped.push({id: item._id, code: error?.code || "METADATA_UNAVAILABLE"});
    }
  }
  return {
    schema: 1,
    kind: "stremio-library-artwork-repair",
    createdAt: new Date().toISOString(),
    account,
    metadataRoot: validateSourceRoot(metadataRoot),
    allowedHosts: [...allowedHosts],
    maxChanges,
    checked: items.length,
    operations,
    skipped
  };
}

export async function applyOperation({authKey, account, operation, allowedHosts = DEFAULT_IMAGE_HOSTS, fetchImpl = fetch}) {
  assert(await accountFingerprint(authKey, fetchImpl) === account, "ACCOUNT_CHANGED");
  assert(safePosterForItem(operation.nextPoster, operation.type, operation.id, allowedHosts), "POSTER_HOST_NOT_ALLOWED");
  const rows = await library(authKey, [operation.id], fetchImpl);
  assert(rows.length === 1 && rows[0]._id === operation.id && rows[0].type === operation.type, "STREMIO_ITEM_MISSING");
  const before = rows[0];
  assert(recordHash(before) === operation.beforeHash, "NEWER_ITEM_STATE_DETECTED");
  const candidate = structuredClone(before);
  candidate.poster = operation.nextPoster;
  candidate._mtime = new Date().toISOString();
  const confirmRows = await library(authKey, [operation.id], fetchImpl);
  assert(confirmRows.length === 1 && recordHash(confirmRows[0]) === recordHash(before), "NEWER_ITEM_STATE_DETECTED");
  const put = await stremioCall(authKey, "datastorePut", {collection: "libraryItem", changes: [candidate]}, fetchImpl);
  assert(put === true || put?.success === true, "STREMIO_WRITE_NOT_CONFIRMED");
  let after = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const afterRows = await library(authKey, [operation.id], fetchImpl);
    assert(afterRows.length === 1, "WRITE_READBACK_MISSING");
    after = afterRows[0];
    if (after.poster === operation.nextPoster) break;
    const isExactStaleBefore = recordHash(after) === recordHash(before);
    if (!isExactStaleBefore) {
      if (!sameExceptArtworkAndMtime(before, after)) throw new RepairError("UNEXPECTED_STATE_CHANGE");
      throw new RepairError("WRITE_READBACK_POSTER_MISMATCH");
    }
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 150 * (2 ** attempt)));
  }
  assert(after?.poster === operation.nextPoster, "WRITE_READBACK_POSTER_MISMATCH");
  assert(sameExceptArtworkAndMtime(before, after), "UNEXPECTED_STATE_CHANGE");
  return {before, candidate, after};
}

export async function restoreBackup({authKey, backup, fetchImpl = fetch}) {
  assert([1,2].includes(backup?.schema) && backup?.account && backup?.before && backup?.candidate, "BACKUP_INVALID");
  assert(typeof backup.before._id === "string" && /^tt\d{5,12}$/.test(backup.before._id), "BACKUP_INVALID");
  assert(backup.before._id === backup.candidate._id && backup.before.type === backup.candidate.type, "BACKUP_INVALID");
  assert(await accountFingerprint(authKey, fetchImpl) === backup.account, "ACCOUNT_CHANGED");
  const rows = await library(authKey, [backup.before._id], fetchImpl);
  assert(rows.length === 1, "STREMIO_ITEM_MISSING");
  const current = rows[0];
  assert(current.poster === backup.candidate.poster, "ARTWORK_CHANGED_SINCE_BACKUP");
  assert(sameExceptArtworkAndMtime(backup.candidate, current), "ITEM_CHANGED_SINCE_BACKUP");

  const confirmRows = await library(authKey, [backup.before._id], fetchImpl);
  assert(confirmRows.length === 1 && recordHash(confirmRows[0]) === recordHash(current), "ITEM_CHANGED_SINCE_BACKUP");

  const restored = structuredClone(backup.before);
  restored._mtime = new Date().toISOString();
  const put = await stremioCall(authKey, "datastorePut", {collection: "libraryItem", changes: [restored]}, fetchImpl);
  assert(put === true || put?.success === true, "STREMIO_WRITE_NOT_CONFIRMED");

  let after = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const afterRows = await library(authKey, [backup.before._id], fetchImpl);
    assert(afterRows.length === 1, "WRITE_READBACK_MISSING");
    after = afterRows[0];
    if (after.poster === backup.before.poster && sameExceptArtworkAndMtime(backup.before, after)) break;
    const isExactStaleCurrent = recordHash(after) === recordHash(current);
    if (!isExactStaleCurrent) {
      if (!sameExceptArtworkAndMtime(backup.before, after)) throw new RepairError("UNEXPECTED_STATE_CHANGE");
      throw new RepairError("RESTORE_READBACK_MISMATCH");
    }
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 150 * (2 ** attempt)));
  }
  assert(after?.poster === backup.before.poster, "RESTORE_READBACK_MISMATCH");
  assert(sameExceptArtworkAndMtime(backup.before, after), "UNEXPECTED_STATE_CHANGE");
  return after;
}
