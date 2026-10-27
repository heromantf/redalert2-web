# relay: the online play's server

Players' pages meet here: each page that plays online joins a virtual LAN
(10.47.0.0/16) by WebSocket, and the game's own LAN play (its Network lobby,
IPX carried as UDP the way IPXEmu carries it) goes through it. Whoever can
reach this server sees the games hosted on it in the game's lobby and plays
them. The protocol is in `main.go`'s header; the game's side is
`../wasi/net.c`, the page's `../host/core/net.mjs` (in a worker:
`../web/net-worker.js`, under Node `../host/node/net-worker.mjs`).

What it does: hands out an address per page (held 60 s for a reconnect with
its token), keeps names unique on a LAN, one page per browser, separate LANs
per build of the game module (lockstep needs the same code everywhere),
switches datagrams by address (a broadcast to every page, the sender too, as
Windows gives a host its own broadcasts), fills in the sender itself, drops
payloads over 1472 bytes and floods past 1000 datagrams or 1 MB a second, pings
every page each 15 s. `GET /status`: who is on which LAN.

## Build and run

```
. ../tools/env.sh                         # Go's caches on the external disk
go build -o ../out/relay .                # this Mac
../out/relay -addr 127.0.0.1:8791         # ws://127.0.0.1:8791/net
GOOS=linux GOARCH=amd64 go build -o ../out/relay-linux-amd64 .   # a Linux server (arm64: GOARCH=arm64)
```

`GET /status` also counts what each LAN dropped: past a page's rate, a page's
queue full, lost by `-test-loss`.

Options: `-addr :8790`, `-tls-cert FILE -tls-key FILE` (wss://: a page served
over HTTPS may only open wss://), `-origins` (the pages' hosts allowed, `*` by
default), `-max-clients 128` (pages on the server; 0: no limit) and `-max-lan 0` (pages
on one LAN: its lobby, where any number of rooms are hosted, 8 players each; 0:
no limit, the server's bounding it). The game has no limit. What bounds it is this server's bandwidth:
each page in the lobby broadcasts about 1.3 datagrams a second (~475 bytes) and
the relay hands each to every page, so N pages take about 0.64 x N^2 KB/s out
of it (a game in progress sends only to its own players: in a game of 8 with
Protocol Zero, ~330 datagrams a second a page at 45 fps, ~440 at 60, ~45 bytes
each; 66 with the game's own timing). Measured here, a
LAN game played meanwhile: 152 pages, 30,700 datagrams a second, 15 MB/s, 0.3
of a core; 302 pages, 121,000 a second, 58 MB/s (470 Mbit/s), 1.2 cores, and
the game's pages, 390 lobby datagrams a second each, dropped a few hundred in
the battle's first minute (the game sent them again: in sync). Set a limit for
what the server's link carries: 50 pages about 1.6 MB/s, 100 about 6.4 MB/s,
128 (the default) about 10.5 MB/s (84 Mbit/s).

On a server reachable from the internet: open the TCP port, run it under
systemd or the like, and give the players `ws://HOST:8790/net` (pages opened
over http, e.g. on 127.0.0.1) or `wss://HOST:8790/net` with a certificate for
HOST (pages opened over https). A server near every player keeps the game
responsive: lockstep play waits for the slowest round trip.

```
[Unit]
Description=ra2web relay
[Service]
ExecStart=/opt/ra2web/relay -addr :8790 -tls-cert /etc/letsencrypt/live/HOST/fullchain.pem -tls-key /etc/letsencrypt/live/HOST/privkey.pem
Restart=always
[Install]
WantedBy=multi-user.target
```

## Tests

- `node test.mjs ws://127.0.0.1:8791/net` against a running relay: joins, a
  broadcast back to its sender, a unicast, the refusals (a name taken, a
  second page of one browser, another build on a LAN in use), a reconnect
  with the token, the counts in `/status`; started with `-test-delay 150ms`,
  `node test.mjs URL 150`: a datagram held that long.
- For measuring the game over a path like the internet's, not for play:
  `-test-delay 50ms` holds each datagram to a page that long (a round trip
  between two pages is twice it), `-test-jitter 10ms` varies the hold by up
  to that either way (their order kept), `-test-loss 1` loses 1 % of them
  (`../spike/protocol-zero`).
- `../tools/lan/pair.sh 480` a LAN game of two players under Node through a
  relay on this Mac, both building; `pair.sh 480 chrome` with the joiner in a
  page in Chrome; `POKE=1 ... chrome` scrambles the joiner's random numbers in
  the battle, which the game's sync check must catch (dialog 0xCE);
  `RELAY="-test-delay 50ms"` the relay's test conditions.
- `../tools/lan/room.sh 8 420` a game of 8 under Node (about 0.7 GB and a core
  a player): the relay's load in a full game.
