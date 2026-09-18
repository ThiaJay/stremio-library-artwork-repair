# Library Artwork Repair for Stremio

Automatic, cross-platform maintenance for **artwork already persisted in Stremio LibraryItems**, with a separate local CLI for audit, explicit repair and recovery.

## Normal operating mode

The normal mode is now **automatic hosted maintenance**.

A private Cloudflare Worker runs every 10 minutes. It does not require a PC, startup task, tray process or home server to remain online. Each invocation reads the shared Stremio library, chooses one deterministic 10-item batch and compares those items with the current Poster Safety metadata. With the current library size this rotates through the whole eligible library in roughly 24 hours.

It can make at most **7 account writes per invocation** from the 10-item scan batch. Production qualification found that seven consecutive writes complete reliably while an eighth immediate write is rejected by the remote path, so the cap stops before that boundary. Every item still receives its own account/concurrency checks, encrypted pre-write backup and verified readback. There is no public control endpoint.

The CLI remains available for administration and recovery; it is no longer the normal way artwork stays correct.

## Separation of responsibility

This project owns **stored LibraryItem artwork**.

- **Poster Safety** prevents/repairs bad poster fields in live metadata.
- **Library Artwork Repair** automatically reconciles artwork already saved in the Stremio account.
- **Story Order** owns episode/special ordering.
- **Stremio Watch State Reference** owns watched-state semantics.

The two artwork layers are complementary, not duplicates: prevention does not guarantee that previously persisted artwork changes automatically.

## Automatic safety model

Every scheduled run is bounded and fail-closed:

1. Verify the Stremio credential still belongs to the expected account fingerprint.
2. Read the current library and select one deterministic batch of at most 20 eligible IMDb-backed movie/series items.
3. Read current metadata through the **internal Poster Safety service binding**.
4. Require exact media type and IMDb identity.
5. Preserve a decorated AIOMetadata poster only when the wrapper identity matches and its canonical fallback is safe.
6. Build a candidate only when the current stored poster differs.
7. Re-read the exact LibraryItem and bind the operation to a hash of the complete record.
8. Re-read immediately again before any write.
9. Encrypt the complete pre-write record with AES-256-GCM and persist it to a private D1 backup database. If backup persistence fails, **do not write**.
10. Write one LibraryItem.
11. Read it back and prove that only artwork plus Stremio's modification timestamp changed.
12. Treat ambiguous writes by readback: if the desired state already committed, accept it; if the exact old state remains, one retry is allowed; any other state fails closed.

A run stops on the first uncertain mutation. Metadata failures for individual items are skipped rather than turning missing information into a destructive decision.

### Hard bounds

- 10 metadata checks per scheduled batch.
- 7 writes maximum per invocation, below the 10-item scan batch and below the observed remote eighth-write failure boundary.
- 20,000 LibraryItems maximum accepted from Stremio.
- 500 explicit IDs maximum in the local CLI.
- 6 MB metadata response limit.
- 12 MB Stremio response limit.
- 14-day encrypted hosted-backup retention.
- No public Worker endpoint.
- No watched/progress mutation.

## Hosted privacy/security

The hosted service stores these only as Cloudflare secrets:

- `STREMIO_AUTHKEY`
- `EXPECTED_ACCOUNT_FINGERPRINT`
- `BACKUP_ENCRYPTION_KEY`

The production D1 database ID lives only in the ignored local Wrangler config. Hosted backups are encrypted before being written to D1. Backup keys use a truncated hash of the IMDb ID rather than the title or raw ID.

The Worker logs aggregate counts and error codes only. It does not log the AuthKey, account ID, titles, poster URLs, private metadata routes or backup plaintext.

`workers_dev = false`, so the scheduled maintenance Worker has no public Workers.dev URL.

## Local admin/recovery CLI

The original CLI remains for explicit audit, plan/apply and restore operations:

```text
node src/cli.js audit --metadata-root https://metadata.example.invalid/stremio/YOUR_CONFIG --ids tt1234567 --auth-stdin
node src/cli.js plan --metadata-root https://metadata.example.invalid/stremio/YOUR_CONFIG --ids tt1234567 --max 10 --auth-stdin
node src/cli.js apply .private/plan-....json --ack-account-write --auth-stdin
node src/cli.js restore .private/backup-....json --ack-account-write --auth-stdin
```

Hosted encrypted backups can be listed/exported for recovery:

```text
npm run hosted-backups -- list
npm run hosted-backups -- export <kv-backup-key>
```

The export is decrypted only into `.private/`, then can be passed to the existing `restore` command. Hosted schema-2 backups and local schema-1 backups share the same guarded restore path.

## Self-hosting

Start with [`SETUP.md`](SETUP.md) and `wrangler.example.toml`.

The public template contains placeholders only. Production resource IDs, account identifiers, configured metadata URLs and credentials must remain outside Git.

## Tests

```text
npm test
npm run check
npm audit --omit=dev
```

The suite covers both the local/manual engine and the scheduled hosted engine, including concurrency, encrypted backup gating, ambiguous writes, stale readback, wrong-account protection, batch coverage, hard write limits, metadata identity and public-surface closure.

## Cross-platform

The persistent authority is the hosted Worker plus the Stremio account, so normal operation is device-independent. The admin CLI is standard Node.js and remains tested on Linux, Windows and macOS.
