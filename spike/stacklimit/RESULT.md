# stacklimit: result (2026-10-26)

`run.sh`: `probe.js`'s wasm recursion (a small frame, and one with 16 i64
locals live across the call), the deepest depth that does not overflow, three
rounds each (`result-2026-10-26.txt`). The first round is V8's baseline tier
(Liftoff), the larger frames, the case that matters.

| Where | small (round 1) | 16 locals (round 1) |
|---|---|---|
| Node 24 worker, `stackSizeMb` 4 (Node's default) | 65,535 | 24,575 |
| Node 24 worker, `stackSizeMb` 1 (host/run.mjs until now) | 12,635 | 4,211 |
| Node 24 worker, `stackSizeMb` 0.7 (host/run.mjs now) | 7,720 | 2,572 |
| **Chrome 155 dedicated worker** (this Mac, headless) | **7,934** | **2,644** |
| Chrome 155 page, Node 24 main thread | 123,293 / 123,413 (optimised) | 20,548 / 20,568 (optimised) |

- The engines count the same: Chrome's page and Node's main thread give the
  same depths. Node is a fair stand-in for V8's frames.
- A Chrome worker here has about 0.5 MB for wasm (7,934 baseline frames of
  ~64 B), not the ~1 MB nfsu2-web's `docs/web/DESIGN.md` gives (perhaps
  another platform). Node's worker at 1 MB allowed 1.6x Chrome's depth, and
  Node's default of 4 MB about 8x.
- `stackSizeMb` 0.7 gives 97% of Chrome's depth with either frame (Node keeps
  ~192 KB of a worker's stack in reserve): host/run.mjs's default since. The
  scripted skirmish (`spike/perf/skirmish.sh wasm`) boots and gets into the
  game with it, no stack overflow.
- Chrome's worker did not tier the probe up in three rounds; Node's did (the
  third "small" round). The baseline round is the one to compare.
- For RA2: the deepest lifted nesting seen, ~15 KB of engine stack
  (`../frames`), is ~3% of 0.5 MB. The recursive `sub_0056CB90` (~176 B a
  level) would fill it at ~2,900 levels, not the ~5,900 a 1 MB stack gave.
