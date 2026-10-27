# timer: the game's pace on a coarse timer (2026-10-26)

Chrome on Windows wakes an `Atomics.wait` timeout on the OS timer, at 1 ms or
at 15.6 ms (nfsu2-web's `docs/web/DESIGN.md`: a 1 ms wait took 15.5 ms at the
median, Chrome 155). Every timed wait of this game comes to one place,
`host/core/thread.mjs` `sleepNs`: `Sleep` (win32hle `usleep`), and
`WaitForSingleObject`, which win32hle polls every 0.2 ms (`hle_wait`), and the
sound's pacing (`wasi/sdl.c` `nanosleep`). So a test can end every wait on
the 15.625 ms grid of the clock, as Windows would: `RA2WEB_TIMER_MS=15.625`.

## What the game sleeps

Native `--trace`, the scripted skirmish (about 25 s in the game): `Sleep`
3,986 calls, `WaitForSingleObject` 2,528, `timeGetTime` 12,287,
`QueryPerformanceCounter` 4,232; the menus and movies poll instead
(`PeekMessageA` 6 M, `_BinkWait` 1.75 M) and call `timeBeginPeriod` once (on
Windows the game asks for the 1 ms timer, which a page cannot).
`RA2WEB_SLEEP_STATS=1` in Chrome, per thread in 10 s of the game: the main
thread 3,900-9,000 sleeps under 2 ms (it paces itself a millisecond at a
time), threads 4 and 5 about 450 of 8-20 ms, others 100 ms and 1 s.

## Measured

The scripted skirmish in Chrome 155 (`spike/perf/skirmish.sh`'s script,
watchdog 120-150 s, the data from the site's OPFS cache), the game's frame
counter over each 3.33 s (`[record] ... game frame N`), the play page with
the sound on (its `[audio]` line counts short quanta):

| Timer | Short sleeps | Game frames per 3.33 s | Sound short | Spinning |
|---|---|---|---|---|
| fine (this Mac) | as asked | 201-209 | 0 | none |
| coarse (15.625 ms) | as asked | **184-197** | **8** | none |
| coarse | under 50 ms spun | 197-209 | 0 | 2.3 cores |
| coarse | **under 8 ms spun** | 197-209 | 0 | **0.9 core** (the main thread) |
| native (for comparison) | | 190-210 | | |

The load into the skirmish took 17.4-17.6 s in each. (An earlier reading of
"a few frames a second" on the coarse timer came from runs whose watchdog
left 10 s of game: one sample. Wrong.)

## What the host does (`host/core/timer-probe.mjs`, `thread.mjs`)

- A probe worker waits 1 ms every ~10 ms and keeps how late it woke: the
  timer is coarse when the latest second's median is later than 3 ms (this
  Mac: 0.3 ms, with single waits 12 ms late while a page loads, which the
  median ignores); then `ctl[CTL_TIMER_LATE]` is that second's worst, else 0.
- A sleep under 8 ms on a coarse timer waits for all but that lateness and
  spins on the clock for the rest. Longer sleeps wait as asked: spinning the
  16 ms sleeps too cost 1.4 cores more and changed nothing.
- On a fine timer nothing spins (the run above: 0 ms spun).

Rerun: `node tools/chrome.mjs --page play --port 8781 --env RA2WEB_SLEEP_STATS=1
--env RA2WEB_TIMER_MS=15.625 [--env RA2WEB_SPIN_UNDER_MS=0] -- <the skirmish's
arguments>`. Not measured on Windows itself (no Windows here).
