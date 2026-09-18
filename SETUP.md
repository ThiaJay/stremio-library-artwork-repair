# Setup and placeholder guide

This is an advanced, on-demand maintenance tool. It is not a Stremio addon and nothing runs automatically.

## Values you must supply

| Documentation value | Replace with | How to obtain it | Secret? |
| --- | --- | --- | --- |
| `https://metadata.example.invalid/stremio/YOUR_CONFIG` | Your real HTTPS Stremio metadata addon root or manifest URL | Use the configured metadata addon's own manifest URL. The tool accepts either the base path or the same URL ending in `/manifest.json`. | The URL may contain private configuration identifiers. Treat it as private unless you know it is public. |
| `tt1234567,tt2345678` | The IMDb IDs of the exact LibraryItems you reviewed | Copy the IMDb IDs for the movie/series you intend to audit or repair. | No |
| `STREMIO_AUTHKEY` | A valid Stremio AuthKey for the account being maintained | Supply an AuthKey you already obtained through a legitimate Stremio account/session flow. This repository does not contain, discover or publish one for you. | **Yes** |

The `.invalid` hostname is deliberately non-routable. Commands containing it are examples only and will not work until you replace it.

## Safest way to supply the AuthKey

Prefer `--auth-stdin`. The tool prompts on standard input and does not persist the key.

```text
node src/cli.js audit --metadata-root https://metadata.example.invalid/stremio/YOUR_CONFIG --ids tt1234567 --auth-stdin
```

Replace the metadata URL and IMDb ID before running that command.

For automation, `STREMIO_AUTHKEY` is also supported as an environment variable. Do not put the AuthKey in source files, Git commits, screenshots, issue reports, release notes or command examples.

## Metadata root rules

The metadata source must:

- use HTTPS;
- use the standard HTTPS port;
- contain no embedded username/password, query string or fragment;
- not point to localhost, a private/local hostname or an IP literal;
- expose normal Stremio `/meta/<type>/<id>.json` responses below the supplied root.

If the metadata response uses an AIOMetadata decorated/rating poster, the tool keeps it only when the wrapper path carries the exact same media type and IMDb ID as the LibraryItem and its `fallback=` is an allowed safe canonical image. A mismatched or unsafe decorated wrapper is not accepted as a write candidate.

If you provide a URL ending in `/manifest.json`, the tool removes that suffix automatically.

## First run

1. Start with `audit`; it is read-only.
2. Use `--ids` to bound the exact reviewed items.
3. Inspect the proposed `from` and `to` poster URLs.
4. Only create a plan once the audit is correct.
5. Only run `apply` after reviewing that saved plan; account writes additionally require `--ack-account-write`.
6. Keep the generated `.private/` backup until you have independently verified the result.

Nothing in this guide is a live credential, account ID or private service URL.
