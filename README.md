# redalert2-web

*Command & Conquer: Yuri's Revenge* in the browser. The game's own executable
is lifted to C ahead of time (`lift/`), runs on an implemented Win32
(`win32hle/`) and is compiled to WebAssembly: no emulator, no Windows. A page
plays it, with its movies, sound, saves and online play. You need your own
copy of the game; nothing of it is in this repository.

## Status

- **Plays in Chrome** (the build is judged by Chrome; other browsers are not
  targeted for now): the menus, skirmishes and campaigns, the movies (FFmpeg's
  Bink decoder for wasm), sound (an AudioWorklet), saves and settings kept in
  the site's storage (OPFS; the saves out to a zip and back), the game data
  kept as it is read or downloaded ahead from the start panel, full screen
  with the mouse and keys locked, and the Steam release's two wrappers' screen
  filters (Shift+F11). The game as shipped, none of the remaster's additions,
  with bugs that CnCNet fixes fixed too (`docs/browser.md`: a map smaller
  than the screen, a big map's terrain, the loading screen's waits, the
  menus at 1280x720).
- **Online**: pages play each other through a relay (`relay/`), the game's own
  LAN lobby, any number of rooms; the original's desyncs and the crashes
  CnCNet's players met are fixed in the lift, and the latency follows the
  network as with CnCNet (its Protocol Zero: a click takes effect after ~90 ms
  on a near relay, the game's own ~375 ms at any distance). Checked on one
  Mac, under Node and in Chrome, with a relay delaying and losing datagrams;
  not yet between real machines or over the internet.
- **Headless** under Node too: the test suite (`tools/playtest.py`, every menu
  and game mode, 37 cases) runs there.
- **For others**: `docs/deploy.md` (the site behind Cloudflare, the relay by
  a name or an IP address alone); each step checked on this Mac, not yet
  between real machines. Not yet: Windows as a build machine.

## What it takes

- Your copy of Yuri's Revenge, the Steam or EA App release (the lift checks
  `gamemd.exe`'s build), copied to `work/game`.
- macOS on Apple silicon (built and tested there); macOS on Intel and Linux
  (x86-64, arm64) are provided for but not tested; Windows is not (bash; WSL
  untested).
- bash, curl, tar (with xz), git, Node 22 or later, Go 1.26 (the relay), uv
  (the lift's Python), Chrome or Chromium; about 5 GB free.

## Build and play

```bash
cp -R "/path/to/Red Alert 2" work/game   # once: your copy of the game (Yuri's Revenge's folder)
tools/deps.sh      # once: wasi-sdk 34 and FFmpeg 9.0.2 (checked by SHA-256), FFmpeg for wasm, node_modules
tools/lift.sh      # once: the game's code as C, from work/game/gamemd.exe -> out/lift (~5 min)
wasi/build.sh      # -> out/ra2.wasm (incremental; FULL=1 for all of it)
tools/play.sh      # the local server and a Chrome window of its own on the page
```

Everything a tool caches, downloads or writes on the side stays in the
checkout (`tools/env.sh`, which the scripts source): caches and temporaries in
`.cache/` (`RA2WEB_CACHE=DIR` elsewhere), the toolchains in `deps/`, the game
and Chrome's test profiles in `work/`, the build in `out/`. `RA2WEB_CHROME`
names the Chrome to start, `WASI` a wasi-sdk of your own. The same sources
build the same module byte for byte, wherever the checkout is.

## Tests

```bash
. tools/env.sh                                 # for the commands below
.venv/bin/python tools/playtest.py --jobs 3    # every menu and game mode under Node (~30 min)
node tools/chrome.mjs --page tests/cache       # the game data's OPFS cache
node tools/chrome.mjs --page tests/store       # the saves' OPFS store
node tools/chrome.mjs --page tests/saves       # the saves out to a zip and back
node tools/chrome.mjs --page tests/input       # the keys (Cmd too) and the wheel into the game
node tools/chrome.mjs --page tests/pointer-lock --mark ready --tap canvas@0.5   # the mouse's lock, raw input or not
node tools/chrome.mjs --page tests/predownload --query lossy \
  --server --throttle --server 3000,40 --server --drop --server 9   # the download ahead over a slow, lossy link
tools/lan/pair.sh 300 chrome                   # two players through a relay, one in Chrome, in sync
tools/lan/two-rooms.sh 8                       # two rooms at once, with a crowded lobby
tools/lan/room.sh 8 420                        # a game of eight (~6 GB, 8 cores)
spike/protocol-zero/run.sh                     # Protocol Zero against the game's timing, 0-200 ms (~55 min)
tools/perf-skirmish.sh wasm 150                # a scripted skirmish's frame times
```

## Online play

Run the relay (`relay/README.md`: locally, or on a server with a certificate),
turn on the start panel's "开启联机", put the relay's address and a player name
there, and pick Network in the game: everyone on the relay is in one LAN lobby.
A browser plays online once it has the game data (the start panel's download,
movies optional); with the switch off (the default) the game plays alone,
reading the data as it goes.

## Layout

| Path | What |
|---|---|
| `lift/` | the lifter, and the RA2 lift's configuration and patches (`run_lift.py`) |
| `win32hle/` | the runtime: Win32 answered here (kernel32, user32, gdi32, ddraw, dsound, winmm, wsock32, Bink, Miles) |
| `recomp32/` | the lifted code's registers, flags and memory (`recomp_types.h`) |
| `wasi/` | the WASI build (`build.sh`) and its C host: what WASI lacks, the display, movies, the LAN |
| `host/` | the JS host: the game threads, WASI, the file calls; Node's runner (`run.mjs`) |
| `web/` | the page: its server, the picture, input, sound, the data and its cache, the download ahead, online play, its tests |
| `relay/` | the online relay (Go): a virtual LAN |
| `tools/` | building, playing and testing (`env.sh`, `deps.sh`, `lift.sh`, `playtest.py`, `chrome.mjs`, `lan/`, ...) |
| `docs/` | how each part was built and measured: `wasi.md`, `browser.md`, `data.md`, `online.md` |
| `spike/` | the experiments, each with its result |

Not committed: the game (`work/`), the lift and the build (`out/`), the
toolchains (`deps/`), caches (`.cache/`, `.venv/`).

## Credits

This builds on others' work (what came from where, and the licenses: `NOTICE.md`):

- [pcrecomp](https://github.com/sp00nznet/pcrecomp) and
  [redalert2-recomp](https://github.com/sp00nznet/redalert2-recomp) by sp00nz:
  the lifter, win32hle and recomp32, and the Red Alert 2 lift's
  configuration, patches and play tests all started there.
- [nfsu2-web](https://github.com/th0mk/nfsu2-web) by th0mk (portions Talha
  Müderrisoğlu): the browser host's design (the process, the game's thread
  workers, the I/O protocol, the game data's block cache and download ahead).
- [CnCNet](https://github.com/CnCNet): what
  [yrpp-spawner](https://github.com/CnCNet/yrpp-spawner) and
  [yr-patches](https://github.com/CnCNet/yr-patches) found (the desync, crash
  and online fixes, Protocol Zero, the game's own bugs), written anew here;
  [YRpp](https://github.com/CnCNet/YRpp) for the game's structures and
  addresses.
- The Steam release's two wrappers,
  [DDrawCompat](https://github.com/narzoul/DDrawCompat) by narzoul and
  [cnc-ddraw](https://github.com/FunkyFr3sh/cnc-ddraw) by FunkyFr3sh: the
  screen filters (with MJP's Catmull-Rom and Hyllian's lanczos2 and xBR
  shaders, through cnc-ddraw), the settings and the stats.
- IPXEmu by Jelle Geerts: IPX over UDP, the same bytes on the wire.
- [FFmpeg](https://ffmpeg.org) (Bink and MP3),
  [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) and
  [coder/websocket](https://github.com/coder/websocket).

## More

- `AGENTS.md`: how to work on this: the rules, and what to run after which
  change.
- `docs/deploy.md`: serving it to your friends.
- `NOTICE.md`: what came from others (pcrecomp, redalert2-recomp, nfsu2-web,
  the wrappers' filters, FFmpeg...) and on what terms. *Red Alert 2* and
  *Yuri's Revenge* are © Westwood Studios / Electronic Arts.
