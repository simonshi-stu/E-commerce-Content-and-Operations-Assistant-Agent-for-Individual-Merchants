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
parent directory. The credential indicator describes the existing text
provider configuration only; it does not verify an account or submit work.
