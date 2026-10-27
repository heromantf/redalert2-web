# The WASI build

How the game came to run as WebAssembly: what decided whether it was worth
doing (phase 0), and the game on WASI, headless under Node (phase 1a). Moved here from README.md as it was written at the time;
the experiments behind it are in `spike/`.

## Phase 0: what decides whether this is worth doing

1. **Stack depth.** Lifted calls nest as host calls (`recomp32/recomp_types.h`'s `RECOMP_CALL`
   and `RECOMP_ITAIL` are both real calls), and a Chrome worker's engine stack
   cannot be raised: about 1 MB by nfsu2-web's `docs/web/DESIGN.md`, about
   0.5 MB measured on this Mac (`spike/stacklimit`).
   `spike/stackmark`: how deep the native game thread's stack goes.
   **Done (2026-10-25): 88 KB at most** over eight playtest cases, a 12-minute
   skirmish included, and most of it is ffmpeg decoding a Bink frame, not the
   game. The game's own deepest nesting: 77 lifted frames, 11 KB, 62 of them
   one recursive function, `sub_0056CB90` (`spike/stackmark/RESULT.md`).
2. **Compile.** Do the 63 generated files (272 MB of C) build for
   `wasm32-wasip1-threads`, how long does that take, and how big is the
   module?
   **Done (2026-10-25): all 64 files compile** with wasi-sdk 34 (176 s, 8
   jobs); the module is 124 MB, 12.1 MB brotli. 48% of its code is copies of
   function bodies lifted again from entries inside them (`alias` entries), a
   lifter-side saving for native and web alike (`spike/compile/RESULT.md`).
3. **Frames in wasm.** The stack frame of each lifted function in the module,
   the largest ones above all, against step 1's depth.
   **Done (2026-10-25):** a lifted frame is about as big in wasm as natively
   (Liftoff estimate: median 168 B); the deepest nesting seen is ~15 KB of a
   Chrome worker's ~0.5 MB engine stack. `sub_0056CB90` would need ~2,900
   levels to fill it; how deep it goes on big maps is the open question
   (`spike/frames/RESULT.md`).

**Phase 0 verdict: nothing found that rules the browser out.** The game
compiles for wasm unchanged, the module is big but within limits, and the
stack fits with room to spare. Open: one recursion's worst case, and
everything a running build will show (speed in V8, startup, memory), which
needs phase 1: the lifted game on win32hle for WASI, booted headless to the
main menu.

Each answer is written down with how it was measured: here, in the spike's
own folder, and in the workspace handoff (`RA2_PROJECT.md`, kept outside the
repositories).

## Phase 1a: the game on WASI, headless (done 2026-10-26)

- **Builds unchanged.** Every runtime and host file of the native build
  compiles for `wasm32-wasip1-threads` with `wasi/compat/compat.h` forced in;
  three are replaced: `screen.c` (headless display), `bink.c` (below),
  `present.c` (not RA2's). The module links with no unresolved symbol.
- **What WASI lacks** (`wasi/compat.c`): `mmap` over the guest's part of
  linear memory (`[64 KB, 0x28000000)`, the image at 0x00400000 as natively),
  `pthread_exit` (a setjmp in each thread's start), `realpath`, signals
  (accepted, never delivered), and sockets that fail (Winsock initialises; no
  network). SDL's part (`wasi/sdl.c`): an audio device that is a thread
  running the mixer in real time, silently; no fonts yet.
- **The host** (`host/`): V8 through Node, shaped like the browser's: one
  shared memory, a pool of game-thread workers (thread-spawn), an I/O worker
  for every file call (node:fs here, HTTP and OPFS in the browser), 0.7 MB of
  engine stack per worker, which gives 97% of a Chrome 155 worker's depth
  (`spike/stacklimit`; Node's own default, 4 MB, gives about 8x). wasmtime 50 no longer runs
  wasi-threads modules (`-S threads`: "no longer supported").
- **Results**, on the copy of the Traditional Chinese game data:
  - V8 compiles the 124 MB module in ~100 ms (lazily) and starts 16 threads
    in ~80 ms. The PE maps at 0x00400000 with all 371 imports bound.
  - The main menu opens (dialogs 0xC6, 0xE2), and its first frame has the
    native build's checksum (`C5727BA3`, at the same sample); the menu is
    drawn right, Chinese labels included (`work/runs/dump`).
  - The scripted skirmish (`spike/perf/skirmish.sh` then, `tools/perf-skirmish.sh` now) gets into the game. At
    the game's own speed both builds wait in its frame pacing (6.4-6.7 ms
    between frames, `Sleep`). Uncapped (`FAST=1`), the same phase of the game:
    native 0.45-0.70 ms a frame, wasm 0.61-1.06 ms, **wasm about 1.4x the
    native time** (1.2x-1.6x over 15 paired samples of 2,000 frames).
- **A native bug found on the way:** without ffmpeg, win32hle's `bink.c`
  fails `BinkOpen`, and the game then reads through a null pointer after the
  main menu's background movie. The native host without ffmpeg
  (WITH_FFMPEG=OFF) faults there (`spike/perf/native-nomovie.sh`: SIGBUS at
  guest address 0); in wasm, where address 0 is memory, the game spun with its
  menu dead instead. `wasi/bink.c` plays movies as black at their own size,
  length and rate; linked natively in its place, the native host without
  ffmpeg gets into the skirmish too (`native-nomovie.sh black`).
- **The lesson in that:** wasm does not fault on a guest null pointer. A hang
  or a wrong behaviour seen only in wasm is checked against the native build
  (which does fault) before anything else.
