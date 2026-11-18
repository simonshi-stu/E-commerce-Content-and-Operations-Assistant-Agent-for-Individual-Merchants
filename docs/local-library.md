# Local media library

The video workbench links to `/library.html`. To run the library alone without
starting any queues or providers, use `node scripts/local-library.js` and open
the printed loopback URL. Only the numeric loopback host is accepted.

Create `private/local-library.json` locally (ignored by Git). `roots` maps
operator-assigned names to absolute, read-only media directories; `entries`
is an explicit allowlist, not a directory browser. Each entry has `root`,
`file` (relative to that root), `product`, `group`, `kind`, and an optional
`task` string from a verified receipt. Keep entries when a file disappears so
the interface can report missing media. Restart the companion after editing
the manifest. Do not put credentials, provider responses, or prompts in it.

Preview and download support MP4, JPEG and PNG. Opening a file uses a browser
media tab. On Windows the separate folder action asks Explorer to open its
parent directory. Both entry points use the same Ark video status adapter.
Configuration presence and protocol model names are not proof of connectivity.
Only an explicit status lookup on a file with a matching download receipt,
task ID, byte count and digest can send one authenticated GET. No create,
retry or media retrieval operation is exposed.

Product rankings aggregate available catalog files by product, separately
counting the verified-final and asset categories and distinct receipt-bound
tasks. Commercial columns remain unknown without verified commercial data.

### New, individually authorized video orders

`/studio/` is separate from the read-only catalog. It uses its own SQLite
ledger and never imports old tasks or budget grants. Use Node with built-in
`node:sqlite`. An estimate sends nothing to Ark. The user reviews one text-only
payload, selects the unchecked consent box and confirms that quote within two
minutes. Changing the prompt or duration invalidates the offer.

Only Seedance 2.0, 480p portrait, 4–15 seconds, no audio is offered. Estimate:
seconds × 496 × 864 × 24 / 1024 tokens at CNY 46 per million, rounded **up**
to cents. Source: [Ark model pricing](https://www.volcengine.com/docs/ark/model-pricing),
no-video-input tariff reviewed 2026-11-02. This is not a spending ceiling or a
settled bill. The cumulative figure sums quotes in this ledger, not account
charges. `completion_tokens` is reported only if returned by a status query.

The confirmed quote and submission-unknown placeholder commit together before
the single create call. Identical payloads cannot be resubmitted in this
ledger. An ambiguous result blocks further creates; retain the ledger and use
the local order ID and timestamp for manual reconciliation. Do not clear it
or change the prompt to retry. Status and result retrieval are manual actions;
only the order's bound task is queried. Result downloads accept HTTPS provider
media, no redirects, MP4 only, up to 128 MiB, without a bearer token.
