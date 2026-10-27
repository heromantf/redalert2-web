# frames: result (2026-10-25)

## Frames in the module

`wasmframes.py out/gen.wasm` (the module of `../compile/RESULT.md`), 25,005
functions. The engine-stack figure is the Liftoff estimate (every parameter and
local a slot of 8 bytes, 16 for a v128, plus 64): an upper bound for TurboFan,
and the figure for a function that never tiers up. The shadow-stack frame is
the function's own `__stack_pointer` decrement (address-taken locals), which
lives in linear memory, not on the engine stack.

| | median | p90 | p99 | max |
|---|---|---|---|---|
| locals | 13 | 19 | 32 | 1,198 |
| Liftoff frame (bytes) | 168 | 240 | 328 | 9,664 |
| shadow frame (bytes) | 0 | 80 | 592 | 4,976 |

The native arm64 frames of the same lifted functions are 80-192 bytes
(`objdump` of the prologues on a sampled chain): a typical lifted frame is
about the same size in wasm as natively. The large ones are the huge bodies:
`sub_00618C58` and its three alias copies (~9.5 KB each, 1,100-1,200 locals),
`sub_0046DFD0` (8.4 KB), `sub_00481A00` (8.0 KB).

## The deepest lifted nesting, native against wasm

`compare.py out/frames.json out/stackmark/lifted-*.txt`: each lifted frame of
the chains in `../stackmark/RESULT.md` with its wasm frame.

| Chain | Lifted frames | Native | wasm engine stack | wasm shadow stack |
|---|---|---|---|---|
| `skirmish-loop` | 77 | 11.0 KB | 14.6 KB (1.3x) | 8.2 KB |
| `skirmish-forcefire` | 39 | 5.6 KB | 8.1 KB | 5.8 KB |
| `skirmish-build` | 26 | 3.8 KB | 6.1 KB | 7.1 KB |
| `campaign-soviet` | 26 | 3.6 KB | 6.1 KB | 4.9 KB |

The game's deepest nesting seen takes ~15 KB of a Chrome worker's engine
stack, which is ~0.5 MB on this Mac (`../stacklimit`; ~1 MB was nfsu2-web's
figure). The recursive `sub_0056CB90` is 176 B of engine stack and 64 B of
shadow stack a level: ~2,900 levels to 0.5 MB.

The estimate is Liftoff's frame layout taken as one slot a local; V8's real
frames add its operand-stack spills and a few words, and TurboFan's are
smaller. It is the right size, not an exact figure: a run in a browser is
what will say exactly.
