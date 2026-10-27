# Online play

The game's LAN through a relay: its sockets, the page's worker, the relay,
the original's desyncs and crashes fixed, the lobby and its queues, the
latency control (Protocol Zero). Moved here from README.md as it was written at the time;
the experiments behind it are in `spike/`.

## Online play: the game's LAN through a relay (2026-10-26)

Pages play each other only (not the native build, not Windows: the original
rounds its x87 arithmetic toward zero, `_controlfp(0x300, 0x300)` in WinMain,
and the lift rounds to nearest; and Apple's maths library is not musl's). A
relay on a server everyone reaches (`relay/`, Go) is a virtual LAN; the game's
own Network lobby is its lobby: whoever is on the relay sees the games hosted
there, any number of them (each 8 players; a game in progress stays listed,
in brackets), and the lobby holds any number of players (netdlg2.cpp's lists
grow as they need: 63 measured, Chrome reading the game's own list; the
relay takes 128 pages by default, `relay/README.md`). Checked on one LAN at once: two rooms open, then
both games played, in sync and without a datagram lost, with eight more in the
lobby broadcasting all along (lobby members made of the game's own datagram,
type 4, its checksum Westwood's CRC engine). A game in progress sends to its
own players only; the lobby broadcasts, ~1.3 datagrams (~475 bytes) a second a
page, to every page, so the relay's load grows as the lobby's square (63 in it:
3,069 datagrams, 1.4 MB a second; 302: 121,000, 58 MB a second, and the two
pages playing dropped a few hundred in their battle's first minute, sent again,
in sync; that with the earlier queues, below).
Nothing of the game changes for it but its sockets and the fixes below.

- **The game's sockets** (`wasi/net.c`): win32hle's `wsock32.c` makes IPX into
  UDP as IPXEmu does (checked against IPXEmu 1.0.4's source: the same bytes on
  the wire; the game's IPX socket 0x8813 is UDP port 5000, broadcasts go to
  255.255.255.255, at most ~580 bytes a datagram), on BSD sockets, which are
  here net.c's: UDP on 10.47.0.0/16, a mailbox of two rings in shared memory
  (kind 4) that the page's network worker carries to the relay. `sendto` never
  fails (the game keeps a datagram whose send failed at the head of its queue
  and retries it before anything else, 0x7B13D0: the link down or a full ring
  loses the datagram, as a LAN would); `recvfrom` with nothing is
  WSAEWOULDBLOCK. What waits to be read is a Windows host's: a socket holds
  the SO_RCVBUF the game sets, 128 KB (0x7B2630; Westwood's RA1 code's value,
  and IPXEmu hands it to its UDP socket), of datagrams' bytes, the earliest,
  and loses what does not fit; the game reads one a FD_READ and drains it
  whenever it pumps messages, so it fills only while it pumps none (loading a
  map: ~20 s). The RX ring is only the way there, 512 KB of records of their
  own length, more than the socket holds (headers, small datagrams), so it
  never loses what the socket would keep; with no socket bound (the game not
  yet in its Network menu) nothing is kept, as no one would on Windows, and a
  socket bound starts empty. The relay marks what it sends as a broadcast, and
  the worker's log every 30 s counts what each stage lost, and of it what was
  sent to this page alone. Measured (a LAN game under Node, N lobby members
  made of the game's datagram, a real one's rate): 10 pages, nothing lost; 128,
  nothing lost before the map loads (the socket at 91 KB at most) and while it
  loads ~600 broadcasts past the 128 KB, none sent to the page alone; in sync.
  The queues before (256 slots, then 64 datagrams a socket, a fixed choice):
  with 128 pages 150 lost joining a room, 5 of them the host's to the joiner.
  `wsock32.c` is unchanged: it alone is built with
  `RA2WEB_NET_SHIM` (`compat.h`), which sends its `close`, `fcntl`, `ioctl`,
  `poll`, `getsockopt`, `send` and `recv` to net.c. Off unless the page joins
  a relay (`RA2WEB_NET`).
- **The worker** (`host/core/net.mjs`; `web/net-worker.js`, under Node
  `host/node/net-worker.mjs`): the WebSocket, `Atomics.waitAsync` on the TX
  ring's bell, reconnects with the relay's token (the same address back).
  A worker, not the page: a background tab's page is throttled, and lockstep
  play waits for the slowest player.
- **The page** (`web/online.js`, `play.html`'s start panel, "联机"): the
  relay's address and the player's name (localStorage; `&relay=&name=` for
  tests); the name goes into the game's `[MultiPlayer] Handle`
  (`wasi/main.c`, RA2WEB_NAME; letters, digits, space, `_`, `-`, 16 at most);
  one page of a browser online (a Web Lock, and the relay refuses a second
  page of one browser id); the module's id (its SHA-256's first 8 bytes)
  keeps different builds apart. The status bar says who is on the LAN.
- **The game data here first** (`web/online.js` `onlineData`): a page plays
  online only with all the game data but the movies (game-files.js
  `aheadFiles`, 814 MB) in this browser; the panel says what is missing and
  holds "开始游戏" until it is there or the relay's address is cleared; at once
  (the tests) the page plays alone, saying why (`&download` downloads first).
  A player reading as he plays holds the others up (lockstep): with
  `web/server.mjs --log-data`, a fresh page fetched `ra2.mix`/`ra2md.mix` as
  the map loaded and `langmd.mix`/`thememd.mix` in the battle, and of the
  movies only `movmd03.mix`'s index, in the menus; downloaded first, its whole
  game took 1 block from the server (that index).
  The download ahead itself once stopped short of its last file: Chrome (155)
  now and then leaves an OPFS access handle asked for unanswered while others
  are being closed (`spike/opfs-handles/RESULT.md`: 7 downloads in 16 stopped;
  0 in 24 now): it closes nothing until it ends, reads what is missing without
  opening a file, asks once more after 15 s, and says, after 30 s with nothing
  kept, what each lane waits for (the panel: "下载 N 秒没有进展").
- **Each browser its own PATH** (`wasi/main.c` `machine_path`, win32hle's
  `hle_guest_env_path`): the game mixes PATH into the session's UniqueID
  (0x697AD0) and drops a lobby packet carrying its own as its echo; win32hle's
  PATH was the same everywhere, the start time alone kept players apart. The
  page's browser id (`ra2web.client`) makes it this browser's.
- **CnCNet's crash fixes, checked one by one** (`run_lift.py`
  `crash_fix_patches`, RA2_PROJECT.md 9.25): 11 places where its players'
  games died (no owner, a house-less trigger, a start position past the map's,
  a pixel outside its surface, StructureTab on a building gone, a hotkey's
  command tail-jumping through a dead object...), each a test before the
  faulting instruction (the lift has no SEH; in the browser a guest NULL is
  memory, and a call through a bad pointer leaves the stack off). Where
  CnCNet's own differ or are wrong the code decides (yr-patches' 0x70F831,
  the spawner's 0x65DC17); BlitPlain's row copy (0x7BC806) is not taken:
  win32hle's Lock never fails. `[crash-fix] ...` on stderr when one acts.
- **No spinning while waiting for the others** (`run_lift.py`
  `online_patches`, CnCNet's): `Sleep(3)` in the wait loop (0x649851); under a
  coarse timer it spins its 3 ms (thread.mjs keeps short sleeps on time).
- **The original's desyncs, fixed** (`lift/run_lift.py`
  `desync_fix_patches`, after CnCNet's spawner `Bugfixes.Desyncs.cpp`, written
  anew): an aircraft's shadow drawn with its height set to 0 (map cells
  recomputed only where it is seen), crates, flags, veinholes and bridges
  leaving a cell's land type stale, an invisible unit's owner-dependent
  "behind" animation, and a shroud check (0x5C0E30). 32 places, all in the
  lift; native and web alike.
- **Checked** (`tools/lan/pair.sh`, a relay on this Mac): two players under
  Node, Alice hosting and Bob joining through the lobby, both deploying,
  building and training: 12,900 game frames in step, no datagram lost, no
  out-of-sync; the same with Bob a page in Chrome (status "联机：10.47.0.3 ·
  2 人在线（Alice、Bob）"), 14,400 frames; the same after the desync fixes.
  The sync check catches a desync: Bob's scenario random table scrambled in
  the battle (`POKE=1`), both stopped at frame 2310 with the game's
  out-of-sync dialog (0xCE), and Bob wrote SYNC1.TXT. The relay's protocol:
  `relay/test.mjs`, 17 checks (18 with `-test-delay`).
- **Not done**: serving the page and its data to friends (HTTPS; the relay
  is separate), a real network's latency and loss (WebSocket is TCP: a lost
  segment holds up what follows; WebTransport datagrams are the way to UDP;
  the relay's test options stand in for a path's delay, jitter and loss),
  two real machines.

## Protocol Zero: the latency control CnCNet plays with (2026-10-27)

The game as shipped sets a network game's timing at its start from IPX's
response time (0x5DC350: FrameSendRate 5, MaxAhead at least 10) and then by
the TIMING events of the first live human: 15 frames and FrameSendRate 5 at
every round trip measured, ~375 ms from a click to its effect on a LAN as
across 200 ms. CnCNet's yrpp-spawner (`src/Spawner/ProtocolZero*.cpp`,
`src/Ext/Event/Body.cpp`, GPL-3.0: read for its findings) replaces it with
Protocol Zero, which its players have long played with; here it is written
anew, the same logic, on in every LAN game (`--protocol-zero off`: the game's
own, for measuring).

- **What it does** (`wasi/protocol_zero.c`): each player sends its response
  time every 30 frames (the first 240 frames after the game's start) in an
  event of a type the game lacks, 0x30, two bytes: the response time + 1 as a
  MaxAhead, and its latency level (the first of 1-8 whose MaxAhead, 4 6 12 16
  20 24 28 32, the response time does not pass, else 9; the response time is
  IPX's, 0x542450: the worst of its connections' mean ack time, in
  `timeGetTime() >> 4`, 16 ms). Every machine executes those events in step
  (the same frame on each), keeps each house's last and drops those 120
  frames old, and raises its level to the highest (never lowering it in a
  game): FrameSendRate the level, MaxAhead its table's (36 at 9), 60 fps, as
  the precalculated timing that the first live human sends as a TIMING at
  its next QueueAI; everyone takes it on that event's frame. The real TIMING
  each 256 frames then sets the frame rate from the slowest machine's, with
  MaxAhead and FrameSendRate kept. A raise prints "Latency mode set to: N -
  Best..." (CnCNet's message without its "CnCNet: ").
- **The start**: at 0x5DD877, the end of 0x5DC350 where its two ways meet
  with a game to load, the spawner's values for Protocol=0 over the game's:
  FrameSendRate 2, MaxAhead 12, 60 fps, PreCalc 0, MaxMaxAhead 0,
  LatencyFudge 0, IPX's timing (60, -1, 600 ticks); and Protocol Zero's state
  from its beginning (level 0, the worst MaxAhead 24): the spawner runs one
  game in a process, a page one game after another. Every LAN game goes
  through there (0x52D9A0's LAN way: 0x5DC350 returns with a game to load,
  and a game's end comes back to it); QueueAI_Multiplayer, which holds most of
  the sites, runs only in network games (0x6475C8, modes 1-4).
- **The sites** (`lift/run_lift.py` `protocol_zero_patches`, each checked in
  IDA; `@before:` a patch ahead of its instruction, after its label, so on
  every way in, as a hook at an address is): the main loop after drawing
  (0x55DDA0: the send); QueueAI_Multiplayer's real TIMING without 5 frames
  sent first (0x647BEB), the response time it reads the worst MaxAhead
  (0x6476CB, 0x647CC5), the TIMING's MaxAhead the one in force (0x647DF2),
  the precalculated TIMING's FrameSendRate the level's (0x647EB4); TIMING
  executed without its -10 for flag 0x1000 (0x4C8011); the event executed
  (0x4C6CC8); EMPTY, PROCESS_TIME and 0x30 executed when late, not dropped
  (0x64C598); the event's size, 2, packing and unpacking (0x64B6FE,
  0x64BE7D, 0x64C30E: the size table, 0x8208EC, stops at 0x2F, and 0x30's
  entry, 0xE8, would throw the packet's parse) and its name in the debug log
  (0x64C5C7: 0x30's entry is no pointer). Its size and its answer are not
  behind the switch (nor in the spawner): a machine with it off still reads
  such an event. Two of the patches' jumps land where the game's code has no
  branch (0x647DF7, 0x64C5CE): `run_lift.py` makes those addresses labels; the
  lift is otherwise the same line for line, 91 patch lines and 8 labels added.
- **Measured** (`spike/protocol-zero/RESULT.md`: two players under Node, the
  relay's `-test-delay` for the round trip, at the LAN's saved game speed, 45
  fps): the input delay, the game's own 17 frames (~375 ms) at a round trip
  of 0 to 200 ms, Protocol Zero's 4 frames (89 ms) at 0 and 50 ms, 13 (290 ms)
  at 100 ms, 16 (355 ms) at 200 ms; in sync throughout, with 1 % lost and
  ±10 ms of jitter too; the waits over 50 ms no more frequent; five times the
  datagrams at level 1 (47 a second a page with two players). Eight players
  (`tools/lan/room.sh 8 420`): 4 frames against 18-19, 329 datagrams a second
  a page (66 the game's own), the relay's limit (1000) never reached, all
  eight in sync. Commands across the first switch (often a lower MaxAhead, 12
  to 4): none late, in sync (4 games, nine or more SCATTER events every 0.25 s
  from 3 s to 10 s). Two games in one page (`tools/lan/two-games.sh`: Bob
  leaves the first, Alice wins, Continue, the Network lobby, Carol joins her
  second): each starts from the same values and raises again.
