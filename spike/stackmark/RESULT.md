# stackmark: result (2026-10-25)

The native host (`../redalert2-recomp/build-macos/ra2`, arm64, generated C at
`-O2`, `RECOMP_LOCAL_REGS`, with the `recomp_lookup` cache), under the
playtests, with `stackmark.dylib` injected (`run.sh`). Every case passed with
it injected.

## How deep: the painted high-water mark

| Case | Deepest |
|---|---|
| `skirmish-build` (MCV, build, produce x3, place x11) | 88 KB |
| `skirmish-loop` (12 min: the AI beats the idle player, score screen) | 87 KB |
| `skirmish-start`, `skirmish-forcefire` | 87 KB |
| `campaign-soviet`, `campaign-allied` (briefing movie, mission start) | 67-68 KB |
| `menu-options`, `menu-idle`, `movies-credits` | 67 KB |

Before the host runs, the stack is already 28 KB deep (dyld, the environment,
the frames that call `main`). The first run printed only every 16 KB of growth
and read up to 16 KB low (`result-2026-10-25.txt`); the exact figures are from
`result-2026-10-25-exact.txt` and later.

## With what: the sampled chains

Sampled every millisecond, frame-pointer chains, frames classed by where their
code is (`result-2026-10-25-chains.txt`, `result-2026-10-25-lifted.txt`;
frame-by-frame files in `out/stackmark/`).

- **The deepest chain is not the game's.** In every case it is a Bink movie
  frame: lifted code (7 frames, ~1.2 KB) calls the `BinkDoFrame` shim, and
  ffmpeg's decoder takes ~49 KB in one stretch (dladdr names it after a
  neighbouring export, `av_packet_side_data_to_frame` and the like; the image
  is libavcodec). The rest: `main` 6.3 KB, the environment and dyld ~9 KB.
  In wasm that decoder would be other code, and its arrays would sit in the
  shadow stack (linear memory), not on the engine stack.
- **The deepest lifted nesting** (the chain with the most lifted frames):

| Case | Lifted frames | Native bytes of them |
|---|---|---|
| `skirmish-loop` | 77 (62 of them `sub_0056CB90` recursing) | 11.0 KB |
| `skirmish-forcefire` | 39 (24 of them `sub_0056CB90`) | 5.6 KB |
| `skirmish-build`, `campaign-soviet`, `menu-idle` | 25-26 (file reads: `CCFileClass`, `Straw` chains) | 3.7-3.9 KB |

- The painted 87-88 KB in a skirmish is ~20 KB more than any sampled chain:
  a peak shorter than a millisecond, not caught. Whatever it is, it fits in
  the 88 KB.
- The guest's other threads (sound, timers) run lifted code natively on
  macOS's default 512 KB secondary-thread stacks (`kernel32_crt.c`,
  `winmm.c`: `pthread_create` with no attributes) and do not overflow them.

## What it says for the browser

- Stack depth is not a blocker. The game's own nesting is ~11 KB natively at
  its deepest here; in wasm that is ~15 KB of engine stack (`../frames`), of
  the ~0.5 MB a Chrome worker has on this Mac (`../stacklimit`, measured
  later; ~1 MB was nfsu2-web's figure).
- **The one thing to watch is `sub_0056CB90`**: a recursive search (a loop
  over 6 directions, a running maximum in the global `0xABDE8C`), 62 levels
  deep in a 12-minute skirmish on the default map. At ~176 B of engine stack a
  level in wasm, ~2,900 levels would fill a Chrome worker's ~0.5 MB
  (`../stacklimit`); natively (144 B, 8 MB) it could go ~55,000. How deep it goes on a large map or a late game is not
  known. nfsu2-web's fallback for a chain too deep, hopping to a fresh stack
  segment through JSPI (`docs/web/DESIGN.md`), is the known remedy.
- Not covered: long campaign missions, large late-game battles on big maps,
  network games.
