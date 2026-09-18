# Library Artwork Repair for Stremio

> **Advanced on-demand maintenance tool — not an addon, live metadata service or background process.**

A bounded, cross-platform maintenance tool for **stale artwork already stored in Stremio LibraryItems**.

**v1.1.1** hardens rollback symmetry and explicit-library-ID boundaries without expanding the tool's scope.

This is intentionally separate from live metadata correction, Story Order and watched-state/Trakt reconciliation.

## What it does

1. **audit** — reads the Stremio library and the selected metadata source and reports artwork candidates. No writes. Identity-bound AIOMetadata decorated posters are preserved so rating, quality and age badges are not discarded.
2. **plan** — creates a private, bounded plan containing the exact before-state hash for each candidate. No writes.
3. **apply** — requires `--ack-account-write`, verifies the same Stremio account and exact unchanged LibraryItem immediately before each write, writes only the poster field, reads it back and stops if any unrelated field changed.
4. **restore** — requires the same acknowledgement, verifies that the item still matches the applied candidate, performs a second immediate pre-write read, restores the private backup and verifies the result with bounded exact-stale readback handling.

Plans and backups are written under `.private/`, which is excluded from Git.

## What it does not do

- No autorun, scheduler, service or daemon.
- No watched/unwatched or Trakt changes.
- No episode ordering.
- No live metadata proxying.
- No streaming/debrid work.
- No silent writes.

Live poster correction belongs to **Poster Safety**. Episode ordering belongs to **Story Order**. Watched-state reconciliation semantics belong to **Stremio Watch State Reference**, with permanent production ownership in Stremio Core/account integration.

## Requirements

- Node.js 22.14 or newer.
- A Stremio AuthKey supplied only for the current run through `STREMIO_AUTHKEY` or `--auth-stdin`.
- An HTTPS Stremio metadata root supplied with `--metadata-root` or `METADATA_ROOT`.

The tool does not persist the AuthKey.

See [`SETUP.md`](SETUP.md) before using the CLI. It lists every documentation placeholder, what must replace it and which values are secrets. In particular, all `example.invalid` URLs are deliberately non-functional examples.

## Usage

Read-only audit:

```text
node src/cli.js audit --metadata-root https://metadata.example.invalid/stremio/YOUR_CONFIG --ids tt1234567 --auth-stdin
```

Create a private bounded plan:

```text
node src/cli.js plan --metadata-root https://metadata.example.invalid/stremio/YOUR_CONFIG --ids tt1234567,tt2345678 --max 10 --auth-stdin
```

`--ids` is strongly preferred for real account maintenance so only the reviewed LibraryItems are queried and eligible to enter the plan.

Apply an already-reviewed plan:

```text
node src/cli.js apply .private/plan-....json --ack-account-write --auth-stdin
```

Restore one verified backup:

```text
node src/cli.js restore .private/backup-....json --ack-account-write --auth-stdin
```

## Safety model

The write path is deliberately one-item-at-a-time and fail-closed. It binds every proposed change to the account fingerprint and SHA-256 of the complete LibraryItem, re-reads immediately before writing, permits only an HTTPS allowlisted poster, stores the original item first, verifies the write by readback and rejects any unrelated state change.

The default canonical-image allowlist is deliberately narrow: TMDB, TVDB artwork and MetaHub. AIOMetadata decorated poster wrappers are accepted separately only when the wrapper host matches the AIOMetadata service pattern, its media type and IMDb ID exactly match the LibraryItem and its `fallback=` points to a safe canonical image. The wrapper host therefore does not need to be added to `--image-hosts`.

## Cross-platform

The implementation is standard Node.js with no OS-specific runtime dependency. It can run on Windows, macOS or Linux. It is a one-time maintenance tool, not permanent product infrastructure.
