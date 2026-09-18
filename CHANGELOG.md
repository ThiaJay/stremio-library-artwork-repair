# Changelog

## 1.1.0 — 2026-09-18

- Preserves AIOMetadata decorated rating/quality/age posters when the wrapper media type and IMDb ID exactly match the LibraryItem and the canonical fallback is safe.
- Rejects mismatched wrapper IDs/types, unsafe fallbacks and unapproved decorated-poster hosts.
- Adds bounded post-write readback retries only when Stremio returns the exact stale pre-write record; unrelated state changes still fail immediately.
- Keeps all existing account binding, whole-record hash, second pre-write read, backup and post-write verification gates.

## 1.0.1 — 2026-09-18

- Documentation-only setup/placeholder clarification.

## 1.0.0 — 2026-09-18

- Initial bounded artwork-only maintenance release.
