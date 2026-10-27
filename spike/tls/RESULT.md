# tls: is a self-signed certificate enough? (2026-10-26)

`check.mjs`: `web/server.mjs` behind an HTTPS front, a self-signed certificate
(`CA:FALSE`, `serverAuth`, SAN `ra2.test` and `127.0.0.1`, 397 days; made by
`openssl req -x509` into `work/tls`, not committed), headless Chrome 155
opening it as a LAN address would be (`ra2.test` mapped to this machine, the
system's proxy bypassed). The certificate's error clicked through is
Playwright's `ignoreHTTPSErrors`; the certificate trusted is Chrome's
`--ignore-certificate-errors-spki-list` (what a friend who installed it gets,
without touching this Mac's keychain). The module fetched twice:

| Way | Secure context | Isolated | SharedArrayBuffer | OPFS | Web Locks | The module, then again |
|---|---|---|---|---|---|---|
| plain http (for comparison) | no | no | no | no | no | 18.76 MB (gzip), then from the cache |
| https, the error clicked through | yes | yes | yes | yes | yes | 13.07 MB (br), then **13.07 MB again** |
| https, the certificate trusted | yes | yes | yes | yes | yes | 13.07 MB (br), then from the cache |

- A self-signed certificate runs the game either way: the page with the
  error let pass is a secure context and isolated, with SharedArrayBuffer,
  OPFS and Web Locks.
- But with the error let pass Chrome keeps nothing in its HTTP cache: every
  load fetches the module (13 MB) again, and the warning comes back. Trusted
  (installed once), it is as any HTTPS site.
- Over plain http Chrome offers only gzip (no brotli, no zstd): the module is
  18.8 MB, not 13.1, and the data's blocks would go gzip 1 (the core archives
  at 44-46% instead of zstd's 38-40%: `../opfs/RESULT.md`).
- A certificate with `CA:FALSE` vouches for the names and addresses in it
  alone: trusting it lets it pass for nothing else, even with its key.
