# Protocol Zero against the game's own timing (2026-10-27)

**What.** CnCNet's latency control (`lift/run_lift.py` `protocol_zero_patches`,
`wasi/protocol_zero.c`, docs/online.md) against the game as shipped
(`--protocol-zero off`), two players under Node through a relay on this Mac
whose test options hold each datagram (`-test-delay`: a round trip of twice
it), vary the hold (`-test-jitter`) and lose some (`-test-loss`). `run.sh`
plays the matrix with `tools/lan/pair.sh` (the lobby, then both build);
`summarize.py` reads the logs' `[net]`/`[pz]` lines (`--debuglog`), from frame
900 on, the start's switch over. The game speed is the LAN's saved one, 1:
45 frames a second at most.

- *input delay*: the player's own PROCESS_TIME events, made on a frame a
  multiple of 128 and carried as every command is, from the frame they are
  made to the one they execute; in ms at the frame rate measured.
- *waiting*: the time QueueAI_Multiplayer spends in Wait_For_Players (0x648710)
  for the other's packets; the longest such wait, and those over 50 ms (a
  hitch one sees) a minute. The faster machine spends there what its frame
  limiter would otherwise sleep: the frame rate held at 45 throughout, so the
  share waited is not a stall; the long waits are.
- *datagrams*: a page's, a second (the game's own, net.c's count).

## Two players, the round trip 0 to 200 ms

| round trip | timing | MaxAhead / FrameSendRate | input delay | longest wait | waits > 50 ms a minute | datagrams a second a page | in sync |
|---|---|---|---|---|---|---|---|
| ~0 | game's | 15 / 5 | 17 frames, 380 ms | 119 ms | 7.4, 0 | 9 | yes |
| ~0 | Protocol Zero | 4 / 1 (level 1) | 4 frames, 89 ms | 128 ms | 7.0, 0 | 47 | yes |
| 50 ms | game's | 15 / 5 | 17 frames, 374 ms | 1 ms | 0, 0 | 10 | yes |
| 50 ms | Protocol Zero | 4 / 1 (level 1) | 4 frames, 89 ms | 126 ms | 8.3, 0.6 | 47 | yes |
| 100 ms | game's | 15 / 5 | 17 frames, 374 ms | 108 ms | 1.4, 0 | 10 | yes |
| 100 ms | Protocol Zero | 12 / 3 (level 3) | 13 frames, 290 ms | 120 ms | 5.8, 0 | 17 | yes |
| 200 ms | game's | 15 / 5 | 17 frames, 375 ms | 92 ms | 1.4, 0.7 | 10 | yes |
| 200 ms | Protocol Zero | 16 / 4 (level 4) | 16 frames, 355 ms | 117 ms | 5.1, 0 | 13 | yes |
| 100 ms, ±10 ms, 1 % lost | game's | 15 / 5 | 17 frames, 377 ms | 290 ms | 3.0, 0 | 9 | yes (44 lost, sent again) |
| 100 ms, ±10 ms, 1 % lost | Protocol Zero | 12 / 3 (level 3) | 13 frames, 290 ms | 317 ms | 5.1, 5.7 | 17 | yes (75 lost, sent again) |

(The two players' waits, the host's first. `summarize.py`'s full table, both
players each: below.)

- **The game's own timing does not follow the network**: at the start
  MaxAhead from IPX's response time, at least 10 (0x5DC350), then the first
  live human's TIMING events, 15 frames and FrameSendRate 5 at every round
  trip here: ~375 ms from a click to its effect, on a LAN as across 200 ms.
- **Protocol Zero follows it**: the response time sent first (frame 243)
  sets the level everyone raises to at frame 256 (all machines the same
  frame), the first live human's TIMING takes it at 271. The level is the
  response time's (16 ms ticks): 0 and 3 ticks level 1 (MaxAhead 4: 89 ms at
  45 fps), 7 at 100 ms level 3 (the first response time, 112 ms, falls past
  level 2's 6 ticks; later ones were 6, and a level is never lowered), 12-13
  at 200 ms level 4. At 60 fps (game speed 0) MaxAhead 4 is 67 ms.
- **The hitches are the same**: waits over 50 ms come and go with the
  scheduling on this machine (7 a minute at no delay with either timing, none
  at 50 ms with the game's), the longest ~120 ms both ways; with loss, the
  longest is the resend's delay (IPX's retry delta, Protocol Zero's
  worst MaxAhead + 10 ticks: 18, 288 ms), both ways.
- **Five times the datagrams at level 1**: a datagram a frame to each other
  player instead of one every 5 frames.

## Eight players (`tools/lan/room.sh 8 420`)

| timing | input delay | frame rate | datagrams a second a page | relay: dropped over the rate / queue full | in sync |
|---|---|---|---|---|---|
| game's | 18-19 frames | 28-45 (30 to start) | 66 | 0 / 0 | all 8 |
| Protocol Zero | 4 frames | 43-52 (60 to start) | 329 (366 at most) | 0 / 0 | all 8 |

Each page sends a datagram a frame to each of the 7 others: ~440 a second at
60 fps, ~45 bytes each. The relay's per-page limit, 1000 datagrams or 1 MB a
second, holds with room to spare (its comment now says so); a relay full of
8-player games, 128 pages, carries ~42,000 datagrams (~2 MB) a second, less
than its lobby full (`relay/README.md`).

## Commands across the first switch (`run.sh spam-...`)

The first raise often lowers MaxAhead (the start's 12 to level 1's 4 or level
2's 6). In theory a machine ahead of the other by more than the new MaxAhead
then gets the other's next commands for frames it has passed, and the game
drops a late event other than EMPTY, PROCESS_TIME and 0x30 (0x64C5AF ->
0x64CAD7), which would unsync; the game's own TIMING can lower MaxAhead the
same way. Played: both players band-select what is on screen and scatter it
(X) every 0.25 s from 3 s to 10 s into the battle (`play-args.py spam`), nine
or more SCATTER events a press, across frames 256-271.

| round trip | level | games | SCATTER events sent | commands received at frames around the switch | late events: dropped / run | in sync |
|---|---|---|---|---|---|---|
| ~0 | 1 (12 -> 4) | 1 | 261 | 244 (10), 283 (9) | 0 / 0 | yes |
| 50 ms | 1 (12 -> 4) | 3 | 261; 116 + 261; 290 + 261 | 258 (9), 262 (9), 268 (5) | 0 / 0 | yes |
| 80 ms | 2 (12 -> 6) | 1 | 319 + 29 | 238 (11), 272 (11) | 0 / 0 | yes |

None late in these, nor in any other game played here (the matrix, eight
players, Chrome, two games in a row: the logs' late counts), though the machines were further apart than the new MaxAhead: the
log's wall clock (CLOCK_REALTIME, the same for two Node processes here) at
the frame the switch took effect, 271, had Bob there 98 ms (~6 frames at the
60 fps it ran then) before Alice in a game at a 50 ms round trip, and 168 ms
in Chrome against Node (Chrome's clock may be its own, `performance.timeOrigin`,
so not counted). So more than the lead keeps a machine's commands from
coming late after a lower MaxAhead; what, the code was not traced for. Two
real machines are where to watch it; the sync check would say.

## In Chrome, at 60 fps (`SPEED=0 SHOTS=... tools/lan/pair.sh 300 chrome`)

Alice under Node, Bob a page in Chrome, the game speed 0 (60 fps at most):
both held 58-62.5 fps the whole game (the 300-frame windows), level 1 at
frame 256 on both, in sync. Bob's screen 7 s into the battle shows the
message at the top left, white: "Latency mode set to: 1 - Best" (`work/runs/lan-chrome-speed0/bob-7.png`, not committed: the game's picture). At 60 fps
level 1's MaxAhead of 4 is 67 ms.

## Two games in one page (`tools/lan/two-games.sh`)

Protocol Zero's state is a game's here (the spawner's is a process's, one game
in it). Alice hosts, Bob joins; Bob's process ends 40 s into the battle; her
game waits for him (dialog 0xEA), drops him at frame 859, she wins, the score
(0x108); Continue takes her to the Network lobby (0xBB), and she hosts again;
Carol joins, the second game. Alice's second game starts from the same
values as her first (MaxAhead 12, FrameSendRate 2, 60 fps, level 0) and
raises to level 1 at frame 256 again; Carol's, her first, the same; in sync.
(A first try failed only for the script: Alice started 60 s after opening her
second room, before Carol, still starting up, had accepted.)

## Full table

`summarize.py` (datagrams: the median a second, the most in brackets; response
time: the 16 ms ticks sent; level: raises, at the frame; late: events executed
late as Protocol Zero lets, events dropped late; relay drops: over the rate,
queue full, lost by `-test-loss`):

| run | player | frames | MaxAhead/FSR/fps | fps | input delay | waiting | longest wait | waits >50 ms a minute | datagrams out/s (most) | in/s | response time | level | out of sync | late: run / dropped | relay drops |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| orig-0 | alice | 4500 | 15/5/45 | 44.7 | 17 frames, 380 ms | 11 % | 119 ms | 7.4 | 9 (10) | 9 | - | - | 0 | 0 / 0 | 0/0/0 |
| orig-0 | bob | 4800 | 15/5/45 | 44.8 | 17 frames, 379 ms | 0 % | 1 ms | 0.0 | 9 (10) | 9 | - | - | 0 | 0 / 0 | 0/0/0 |
| pz-0 | alice | 5100 | 4/1/45 | 44.9 | 4 frames, 89 ms | 39 % | 128 ms | 7.0 | 47 (48) | 47 | 0..0 | 0->1@256 | 0 | 0 / 0 | 0/0/0 |
| pz-0 | bob | 5100 | 4/1/45 | 44.8 | 4 frames, 89 ms | 0 % | 6 ms | 0.0 | 47 (48) | 47 | 0..0 | 0->1@256 | 0 | 0 / 0 | 0/0/0 |
| orig-25 | alice | 4800 | 15/5/45 | 45.4 | 17 frames, 374 ms | 0 % | 1 ms | 0.0 | 9 (10) | 10 | - | - | 0 | 0 / 0 | 0/0/0 |
| orig-25 | bob | 4800 | 15/5/45 | 45.4 | 17 frames, 374 ms | 0 % | 0 ms | 0.0 | 10 (10) | 9 | - | - | 0 | 0 / 0 | 0/0/0 |
| pz-25 | alice | 5100 | 4/1/45 | 44.8 | 4 frames, 89 ms | 58 % | 126 ms | 8.3 | 47 (48) | 47 | 3..3 | 0->1@256 | 0 | 0 / 0 | 0/0/0 |
| pz-25 | bob | 5100 | 4/1/45 | 44.9 | 4 frames, 89 ms | 1 % | 118 ms | 0.6 | 47 (48) | 47 | 3..3 | 0->1@256 | 0 | 0 / 0 | 0/0/0 |
| orig-50 | alice | 4800 | 15/5/45 | 45.4 | 17 frames, 374 ms | 7 % | 108 ms | 1.4 | 10 (10) | 9 | - | - | 0 | 0 / 0 | 0/0/0 |
| orig-50 | bob | 4800 | 15/5/45 | 45.4 | 17 frames, 374 ms | 2 % | 18 ms | 0.0 | 9 (10) | 10 | - | - | 0 | 0 / 0 | 0/0/0 |
| pz-50 | alice | 5100 | 12/3/45 | 44.9 | 13 frames, 290 ms | 20 % | 120 ms | 5.8 | 17 (17) | 17 | 6..6 | 0->3@256 | 0 | 0 / 0 | 0/0/0 |
| pz-50 | bob | 5100 | 12/3/45 | 44.8 | 13 frames, 290 ms | 0 % | 1 ms | 0.0 | 17 (17) | 17 | 6..6 | 0->3@256 | 0 | 0 / 0 | 0/0/0 |
| orig-100 | alice | 4800 | 15/5/45 | 45.4 | 17 frames, 374 ms | 2 % | 92 ms | 1.4 | 10 (10) | 10 | - | - | 0 | 0 / 0 | 0/0/0 |
| orig-100 | bob | 4800 | 15/5/45 | 45.3 | 17 frames, 375 ms | 1 % | 82 ms | 0.7 | 9 (10) | 10 | - | - | 0 | 0 / 0 | 0/0/0 |
| pz-100 | alice | 5100 | 16/4/45 | 45.1 | 16 frames, 354 ms | 14 % | 117 ms | 5.1 | 13 (14) | 13 | 12..12 | 0->4@256 | 0 | 0 / 0 | 0/0/0 |
| pz-100 | bob | 5100 | 16/4/45 | 44.8 | 16 frames, 357 ms | 0 % | 0 ms | 0.0 | 13 (13) | 13 | 12..13 | 0->4@256 | 0 | 0 / 0 | 0/0/0 |
| orig-50j | alice | 4500 | 15/5/45 | 45.1 | 17 frames, 377 ms | 2 % | 290 ms | 3.0 | 9 (10) | 9 | - | - | 0 | 0 / 0 | 0/0/44 |
| orig-50j | bob | 4800 | 15/5/45 | 45.4 | 17 frames, 374 ms | 0 % | 0 ms | 0.0 | 10 (10) | 9 | - | - | 0 | 0 / 0 | 0/0/44 |
| pz-50j | alice | 5100 | 12/3/45 | 45.1 | 13 frames, 288 ms | 3 % | 317 ms | 5.1 | 17 (17) | 17 | 6..7 | 0->2@256 2->3@256 | 0 | 0 / 0 | 0/0/75 |
| pz-50j | bob | 5100 | 12/3/45 | 44.7 | 13 frames, 291 ms | 3 % | 228 ms | 5.7 | 17 (18) | 17 | 6..7 | 0->2@256 2->3@256 | 0 | 0 / 0 | 0/0/75 |
