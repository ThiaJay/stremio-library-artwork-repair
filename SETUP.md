# Setup and placeholder guide

The normal operating mode is automatic hosted maintenance. The local CLI remains for explicit administration and recovery.

## Hosted deployment

Copy `wrangler.example.toml` to `wrangler.local.toml`. The local file is ignored by Git.

Required resources and secrets:

| Value/binding | Purpose | Privacy |
| --- | --- | --- |
| `BACKUP_DB` | Dedicated D1 database containing encrypted pre-write backups | Keep the production database ID outside Git |
| `POSTER_SAFETY` | Internal service binding to Poster Safety | Internal Cloudflare topology |
| `STREMIO_AUTHKEY` | Stremio account credential | **Secret** |
| `EXPECTED_ACCOUNT_FINGERPRINT` | SHA-256 binding to the intended Stremio account | **Account-specific secret** |
| `BACKUP_ENCRYPTION_KEY` | Random 32-byte base64url AES-256 key | **Secret** |

The secrets must be installed with Wrangler secret bindings, never ordinary `[vars]`, source files, screenshots or release notes.

The production cron is `*/10 * * * *`. The Worker uses `workers_dev = false`, so there is no public Worker URL.

## Capacity model

Each run deterministically selects 10 eligible items and can write at most 2. With about 1,400 eligible items, the current library is revisited roughly once per day. The scan is stateless; there is no cursor database that can become a single point of failure.

Encrypted recovery records are stored in D1 because D1's free allowance is materially larger than Workers KV's write allowance. The service does not use KV.

## Backup recovery

Hosted backups are encrypted before storage and expire logically after 14 days; scheduled pruning removes expired rows.

List recovery records:

```text
npm run hosted-backups -- list
```

Export and decrypt one into `.private/`:

```text
npm run hosted-backups -- export <backup-key>
```

Then pass the exported file to the existing guarded restore path:

```text
node src/cli.js restore .private/hosted-backup-....json --ack-account-write --auth-stdin
```

Restore rechecks the account, current candidate state, immediate concurrency and post-write readback.

## Local CLI placeholders

| Documentation value | Replace with | Secret? |
| --- | --- | --- |
| `https://metadata.example.invalid/stremio/YOUR_CONFIG` | Real HTTPS metadata root/manifest used for a deliberate local audit | The real URL may contain private configuration |
| `tt1234567,tt2345678` | Exact IMDb IDs being deliberately inspected | No |
| `STREMIO_AUTHKEY` | Valid Stremio AuthKey supplied for the current local run | **Yes** |

`.invalid` is deliberately non-routable. Example commands require substitution.

## Never publish

- `wrangler.local.toml`
- `.private/*`
- AuthKeys
- account fingerprints
- backup encryption keys
- production D1 IDs
- personal configured metadata URLs
