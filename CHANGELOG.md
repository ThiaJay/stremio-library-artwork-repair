# Changelog

## 1.2.0 — 2026-09-18

- Makes automatic hosted maintenance the normal operating model instead of manual invocation.
- Adds a private Cloudflare Cron Worker running every 10 minutes with deterministic 10-item library rotation and a hard cap of 2 writes per run.
- Adds account fingerprint binding, second immediate pre-write reads and fail-closed concurrency checks.
- Adds AES-256-GCM encrypted pre-write backups in a dedicated D1 database; backup persistence is mandatory before mutation.
- Adds ambiguous-write resolution by readback with at most one retry when the exact old record remains.
- Uses only the internal Poster Safety service binding for metadata and exposes no public maintenance endpoint.
- Adds hosted backup list/export recovery tooling and schema-2 backup support in the existing guarded restore path.
- Moves hosted backup persistence away from Workers KV to avoid the much lower KV free-tier write ceiling.
- Keeps the local CLI as admin/recovery tooling rather than the normal maintenance mechanism.
- Adds adversarial hosted-worker coverage alongside the existing manual repair tests.

## 1.1.1 — 2026-09-18

- Gives restore/rollback the same second-pre-write concurrency check as apply.
- Adds bounded exact-stale readback handling after restore while rejecting unrelated drift immediately.
- Validates explicit LibraryItem ID lists before network access: max 500, IMDb format only, no duplicates.
- Adds Linux, Windows and macOS CI with dependency audit.

## 1.1.0 — 2026-09-18

- Preserves identity-bound decorated rating/quality/age posters when safe.
- Rejects mismatched wrapper IDs/types, unsafe fallbacks and unapproved decorated-poster hosts.

## 1.0.1 — 2026-09-18

- Documentation-only setup/placeholder clarification.

## 1.0.0 — 2026-09-18

- Initial bounded artwork-only maintenance release.
