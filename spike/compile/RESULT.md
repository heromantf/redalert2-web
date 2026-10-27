# compile: result (2026-10-25)

`build.sh` with wasi-sdk 34 (clang 23.1.0), `wasm32-wasip1-threads`, `-O2`,
8 jobs, on the M-series Mac with 10 cores and 16 GB (swap already 9.5 GB in
use when it ran, so the times are, if anything, high). The lift is the one the
native build uses: `../redalert2-recomp/src/recomp/gen`, 63 files plus
`recomp_dispatch.c`, 272 MB of C.

## It builds

- **64 of 64 files compile, no errors**, with nfsu2-web's flags. The one
  thing the flags are needed for: `recomp_types.h` includes `<setjmp.h>`, which
  wasi-libc refuses without wasm exceptions (`-mexception-handling -mllvm
  -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false`). The RA2 lift has no
  EH landing pads (`RECOMP_EH_ENTER`: 0), so nothing actually uses it.
- 176 s wall for all of them; 1,098 s summed over files. The slowest:
  `recomp_0033.c` 106 s, `recomp_0055.c` 74 s, `recomp_0047.c` 56 s.
- Objects: 175 MB.
- Linked alone (`wasm-ld --no-entry --allow-undefined`, the dispatch table
  exported so nothing is dropped; no runtime yet) into `out/gen.wasm`:

| | Bytes |
|---|---|
| module | 123,828,289 (124 MB) |
| gzip -9 | 17,758,757 (17.8 MB) |
| brotli -q 9 | 12,143,032 (12.1 MB) |

For scale: the native arm64 `__text` is 106 MB, so wasm code is about 16%
larger than arm64 code for the same lift. NFSU2's 35 MB module came from a
lifter with JTSWITCH (see below); "RA2 ≈ 70 MB" in the handoff was a guess and
was wrong.

## Where the size is: entries inside other functions

`../redalert2-recomp/work/functions.json` lists 24,926 functions: 18,751 start
entries and 6,175 `alias` entries. 6,046 of the aliases start inside another
function's range, and each is lifted as a function of its own: a copy of the
parent's body from that entry on. Their wasm bodies are **58.8 MB of the
122.9 MB of code (48%)**. The largest: four entries into `sub_00618C58`
(350-375 KB each), several into `sub_0045FE50` (170-177 KB each).

This is the duplication nfsu2-web removed with JTSWITCH (a switch's targets
became cases inside their function; 3,821 copies from 477 tables there). The
native build carries the same copies. Removing them is a lifter change
(`run_lift.py` / pcrecomp's generate), worth doing for both builds, not a
condition for the web one: 124 MB is inside V8's limits
(`src/wasm/wasm-limits.h`: a module up to 1 GiB, a function body up to
7,654,321 bytes, 50,000 locals, 1,000,000 defined functions; here the largest
body is 375 KB, the most locals 1,198, the functions 25,005).

Frames in the module: `../frames/RESULT.md`.
