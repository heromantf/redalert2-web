# Working on redalert2-web

What to know before changing anything, for a person or a coding agent. How
each part was built and measured is in `docs/`; the experiments, each with its
result, in `spike/`; what came from where in `NOTICE.md`.

## Never commit

- The game's files (`work/`), the lift (`out/lift`: a derivative of the game's
  executable, made from your copy), build output (`out/`), what
  `tools/deps.sh` fetches (`deps/`), caches (`.cache/`, `.venv/`). They are in
  `.gitignore`; look at `git status` before a commit.
- Credentials, accounts, recordings of play.

## Rules

- **The generated C is never edited.** Change `lift/run_lift.py` (its
  patches) or `win32hle/`, then `tools/lift.sh` and `wasi/build.sh`. A patch
  says what it fixes and where it was checked.
- **Source `tools/env.sh`** before a one-off command (`node tools/chrome.mjs`
  needs it); the scripts source it themselves. Nothing goes to the home folder
  or the system's temporary folder: caches in `.cache/`, test profiles in
  `work/`.
- **Builds stay reproducible.** `tools/lift.sh` fixes `PYTHONHASHSEED`
  (otherwise functions several classes share are named differently each
  lift), `wasi/build.sh` fixes `LC_COLLATE` (otherwise the link order follows
  the locale). The module's SHA-256 is the relay's version: two builds of one
  commit must be the same bytes, or their players do not meet.
- **What came from upstream** (pcrecomp, redalert2-recomp) is listed in
  `NOTICE.md` with the commit it was copied at. Upstream is not followed: a
  change of theirs is read, and taken, one at a time, and the table kept
  right.
- **No GPL code.** CnCNet's yrpp-spawner and yr-patches (GPL-3.0) are read for
  what they found (an address, a condition); the fix is written anew here.
  Their code, or any other GPL code, is not copied in. FFmpeg is LGPL only as
  `wasi/ffmpeg.sh` builds it (no `--enable-gpl`).
- **The web build is the game as shipped**, plus what the Steam release's two
  wrappers (DDrawCompat, cnc-ddraw) give it; none of the remaster's additions
  (HD vehicles, modern controls, mods).
- **Chrome is the browser it is judged by.** A limit kept only for Safari,
  Firefox or Edge is not kept; where a choice is made for Chrome, say so.
- **A claim is backed by a measurement or by the code.** An experiment goes in
  `spike/NAME/` with a `RESULT.md`; a number in a comment says where it comes
  from. A cause guessed is checked before it is fixed.
- **Commits by feature or fix**, each saying what changed and how it was
  checked.

## After a change, run

| Changed | Run |
|---|---|
| `lift/run_lift.py`, `lift/` | `tools/lift.sh`, `wasi/build.sh`, `tools/playtest.py --jobs 3` (37 cases, ~30 min) |
| `win32hle/`, `wasi/`, `recomp32/` | `wasi/build.sh` (`FULL=1` after a header change: the build does not follow headers), `tools/playtest.py` |
| the page (`web/`: presenter, input, full screen, settings) | a scripted run in Chrome (`node tools/chrome.mjs --page play ...`), `tests/cache`, `tests/store` |
| the game data (`data-cache.js`, `http-backend.js`, `block-fetch.js`, the download ahead) | `tests/cache`, `tests/predownload` (lossy, README), `tools/predownload-loop.sh 8` |
| online (`wasi/net.c`, `host/core/net.mjs`, `web/online.js`, `relay/`) | `node relay/test.mjs` against a running relay, `tools/lan/pair.sh 300 chrome`, `tools/lan/two-rooms.sh 8` |
| the game's network timing (`protocol_zero_patches`, `wasi/protocol_zero.c`) | the same, `tools/lan/room.sh 8 420`, `tools/lan/two-games.sh`, `spike/protocol-zero/run.sh` against its RESULT.md |
| `tools/env.sh`, `tools/deps.sh`, `wasi/build.sh` | the same, and a copy of the committed files elsewhere built from nothing (`deps.sh`, `lift.sh`, `build.sh`): the module must come out the same bytes |

A test that opens a Chrome window stays headless unless asked: `tools/chrome.mjs`
runs headless with its own profile.

## Things that bit before

- **wasm does not fault on a guest null pointer**: guest address 0 is memory.
  A hang or a wrong behaviour seen only in wasm is checked against the code
  (and, where it helps, the native build) before anything else.
- **The web build has a network only on a relay** (`wasi/net.c`): without one
  the game's IPX socket fails and the Network screens do not open.
  `tools/playtest.py` starts a relay for those cases.
- **A lift's names come from RTTI**; a function shared by several classes is
  named after one of them. Compare lifts with the seed fixed.
- **One writer per site for the game data's cache** (a Web Lock): a second tab
  reads from the server only. Chrome has lost an OPFS handle asked for while
  others were being closed (`spike/opfs-handles`).
- **The machine's proxy**: a clean environment for a test still needs the
  proxy variables to reach the internet; `tools/env.sh` keeps 127.0.0.1 off
  the proxy (`no_proxy`).
- **zsh**: an unmatched glob is an error there; scripts are bash, and
  `tools/env.sh` avoids globs.
