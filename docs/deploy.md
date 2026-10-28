# Serving it to others

Two parts, on one machine or two: the site (the page, the game module and the
game data: `web/server.mjs --public`, behind Cloudflare here) and the relay
(online play: `relay/`, reached by `wss://` with a certificate, by a name or an
IP address). `game.example.com` and `203.0.113.7` below stand for
yours. Not yet tried between real machines; each step was checked on this Mac
(2026-10-28).

The site hands the game's files to whoever opens the page: your copy of the
game. Keep it to your friends (Cloudflare Access below, the origin open to
Cloudflare alone).

## The site

What it needs: Node 22 or later (the blocks go zstd-compressed from Node
22.15 / 23.8, brotli before), and of this checkout `web/`, `host/` and
`out/ra2.wasm` (`wasi/build.sh`), with the game folder (`work/game`, or
anywhere: `--data`).

```bash
rsync -a web host /srv/ra2web/ && mkdir -p /srv/ra2web/out && cp out/ra2.wasm /srv/ra2web/out/
rsync -a work/game/ /srv/ra2web/game/
node /srv/ra2web/web/server.mjs --public --host 127.0.0.1 --port 8780 --data /srv/ra2web/game \
  --relay wss://203.0.113.7:8790/net
```

`https://game.example.com/` takes a player to the game's page
(`/web/play.html`), `--relay`'s address filled in for its relay (where the link
gives none of its own), the link's other parameters kept: the address to give
your friends is the site's, nothing more. Online or not is still the player's:
the start panel's "开启联机", off until turned on (off, the game plays alone).

`--public` serves what a player's page needs and nothing else of the
checkout (`web/` but its tests, `host/`, `out/ra2.wasm`; not the lift, the
objects or `spike/`), and marks what never changes cacheable for a year
(`public, max-age=31536000, immutable`): a run of the game data's blocks asked
with its file's size and mtime (`/blocks/FILE?b=&n=&s=&m=`), the module asked
with its version (`/out/ra2.wasm?v=`, the page asks `/out/ra2.wasm.version`
first). The rest is `no-cache` (the pages, revalidated) or `no-store` (the
manifest, the version, errors). Every answer is cross-origin isolated
(COOP/COEP: the game's SharedArrayBuffer needs it, and HTTPS).

In front of it nginx on 443, with Cloudflare's origin certificate (SSL/TLS
→ Origin Server → Create Certificate; the SSL/TLS mode Full (strict)),
passing everything to the server as it is: its headers (COOP/COEP, the
caching) and its compression (nginx's own gzip off). `http2 on;` is nginx
1.25.1's; before it, `listen 443 ssl http2;`.

```nginx
# /etc/nginx/conf.d/ra2web.conf
server {
    listen 443 ssl;
    http2 on;
    server_name game.example.com;
    ssl_certificate     /etc/ssl/cloudflare/game.example.com.pem;   # Cloudflare's origin certificate
    ssl_certificate_key /etc/ssl/cloudflare/game.example.com.key;
    include /etc/nginx/cloudflare-allow.conf;                       # Cloudflare's addresses alone
    gzip off;                                                       # the server compresses what pays
    location / {
        proxy_pass http://127.0.0.1:8780;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_read_timeout 300s;
    }
}
```

The origin is open to Cloudflare alone, or Access (below) is no lock: the
list from Cloudflare (again when it changes, now and then), with the
firewall's own on 443 as well if you like:

```bash
{ curl -s https://www.cloudflare.com/ips-v4; echo; curl -s https://www.cloudflare.com/ips-v6; echo; } \
  | sed -n 's/^\([0-9a-f.:]*\/[0-9]*\)$/allow \1;/p' > /etc/nginx/cloudflare-allow.conf
echo 'deny all;' >> /etc/nginx/cloudflare-allow.conf
nginx -t && systemctl reload nginx
```


Cloudflare, for `game.example.com` (proxied):

- **Cache Rule**: `starts_with(http.request.uri.path, "/blocks/") or
  http.request.uri.path eq "/out/ra2.wasm"`: eligible for cache, the edge TTL
  the origin's Cache-Control, the query string kept in the cache key (the
  default: `b n s m`, `v`). The blocks are 16 MiB at most, the module 13 MB
  compressed, under the free plan's 512 MB.
- **Rocket Loader off** (it rewrites the page's scripts).
- **Access** (Zero Trust): an application for `game.example.com`, your
  friends' addresses allowed (a one-time PIN by mail).

A new build: copy `out/ra2.wasm` over; its version changes with it, pages
fetch the new URL (a reload), and players of different builds do not meet
(the relay keeps builds apart). Game data changed: its blocks' URLs change
with the files' size and mtime.

## The relay

```bash
cd relay && GOOS=linux GOARCH=amd64 go build -o relay-linux-amd64 .   # arm64: GOARCH=arm64
scp relay-linux-amd64 SERVER:/opt/ra2web/relay
```

A certificate for the relay's name or its IP address, from your ACME client;
its renewal's hook tells the relay (`pkill -HUP -x relay`: SIGHUP), which
reads the certificate again and goes on (`relay/README.md`): no page drops.

Started by hand (in tmux or the like), the TCP port open:

```bash
/opt/ra2web/relay -addr :8790 -origins game.example.com -tls-cert /path/fullchain.pem -tls-key /path/privkey.pem
```

`-origins game.example.com`: only the pages of the site join.
`-max-clients 128` (the default) bounds the pages; its README says what that
asks of the link.

## The players

Chrome on a computer. The link is the site's, `https://game.example.com/`.
Alone, the game reads the data as it goes. Online: the start panel's
"开启联机" on, each a name of their own (letters, digits, space, `_`, `-`),
and first all the game data but the movies (~814 MB) downloaded into the
browser (the panel's download, it says how far); the relay is filled in
(`--relay`).

## Checked here

- `web/server.mjs --public`: the tests, `spike/`, the lift and the relay's
  binary not served; the module by its version and the blocks by size and
  mtime cacheable for a year, a wrong version or no size not, a changed file
  409, COOP/COEP on every answer; the play page in Chrome through it, the
  module fetched by its version (`/out/ra2.wasm?v=...`, brotli 13.1 MB), the
  main menu reached. Without `--public` as before. `/` to the play page with
  `--relay`'s address (the link's own relay and other parameters kept), and in
  Chrome the start panel's relay filled in from it.
- nginx in front (the configuration above, a self-signed certificate for
  Cloudflare's, without the address list): nginx 1.30.6 in Docker over HTTPS
  and HTTP/2, and 1.28.0 over HTTP: every answer's status, COOP/COEP, caching
  and compression as the server's, the module and a 16 MiB run of blocks the
  same bytes, a revalidation 304.
- The relay on `wss://` (`relay/test-tls.sh`): a certificate replaced and
  SIGHUP, the next handshake has the new one, a page joined before stays and
  is answered, one that does not load leaves the last.
