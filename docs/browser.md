# In the browser

The game on a page (phase 1b): Chrome, the picture and input, movies, sound,
saves, the free disk space, Windows' timer, keys and mouse, the Steam
release's wrappers, the game as shipped. The game data has its own notes
(`docs/data.md`), online play too (`docs/online.md`). Moved here from README.md as it was written at the time;
the experiments behind it are in `spike/`.

## Phase 1b: the browser

**First step done (2026-10-26): the same headless run in Chrome 155.**

- The host was split into a shared core (`host/core/`: a game thread with its
  WASI and thread-spawn, and the I/O worker's file calls over a backend) and
  thin adapters: Node's (`host/node/`, node:fs) and the browser's (`web/`:
  Worker, the game data over HTTP). The Node run is unchanged (same checksum).
- `web/server.mjs` serves the page, the module and the game data (byte ranges,
  a manifest, COOP/COEP for SharedArrayBuffer, `no-store`), on 127.0.0.1.
  `tools/chrome.mjs` opens the installed Chrome through playwright-core (no
  browser downloaded), its profile and disk cache under `work/`.
- In Chrome: the 119 MB module fetched in ~350 ms and compiled in ~70 ms, 16
  threads in ~50 ms. To the main menu the game read 151 blocks of 1 MiB
  (135 MB); the menu's first frame has the native checksum (`C5727BA3`).
- The scripted skirmish: at the game's pace 6.4 ms between frames, as
  natively. Uncapped (`FAST=1`), the first 10 x 2,000 in-game frames, before
  any of the three games is decided: native 0.535 ms a frame, Node 0.75 ms
  (1.40x), **Chrome 0.73 ms (1.36x)**.

**The picture and input done (2026-10-26).**

- `wasi/screen.c` publishes each new frame as RGB565 into the next of three
  buffers (8- and 32-bit frames converted) and bumps a sequence; the page reads
  the newest at its pace. It says too whether the page shows a cursor (the
  game's menus use the Windows cursor, made from the game's own 32x32 masks; in
  a game the game draws its own) and drains a ring of the page's input events
  into win32hle (`hle_input_mouse`, `hle_input_key`). Both structures reach
  the page through one host import, `ra2web.register(kind, ptr, size)`.
- `web/presenter.js`: WebGL2, the frame uploaded as RGB565 as it is,
  letterboxed, scaled sharp-bilinear (the native default) in the shader.
  `web/input.js`: pointer events at game pixels, keys from the whole window
  through the native presenter's virtual-key and scan-code table, held keys
  let go on blur. `web/play.html`: the game's page; `tools/play.sh` starts the
  server and a Chrome window with a profile of its own (in `work/`).
- The page passed `--headless` (no native window: no HD vehicles machinery, no
  F10 menu) and got the picture all the same: `main.c` was unchanged. (Since
  2026-10-26 the web has a host of its own, `wasi/main.c`, and no such flag.)
- Checked in Chrome through `tools/chrome.mjs --page play` (screenshots in
  `work/runs/shots`): the main menu drawn (60 fps, 800x600 scaled to
  1280x960); real clicks at game pixels open Single Player (0x100) and the
  skirmish screen (0x102) and start the game; in the game (640x480) the page's
  H key centres the view on the base. The Node run is unchanged (checksum).
- Found on the way: a page loaded without a click gives no element the focus,
  so keys are taken from the window, not the canvas.

The goal (2026-10-26): playing over the LAN with friends, the server on this
Mac and their browsers joining it. Next, in this order:

1. ~~The picture and input~~ (done, above).
   ~~Movies~~ (done, below).
2. ~~Sound~~ (done, below).
3. ~~Saves and settings that outlive the page~~ (done, below).
4. The LAN: the server on the LAN's address, and a secure context for the
   friends' browsers: HTTPS from the server, or (for now, measured) Chrome
   started with `--unsafely-treat-insecure-origin-as-secure=http://IP:PORT`.
   A plain `http://` address that is not the machine's own has no
   SharedArrayBuffer, no OPFS and no Web Locks: the game would not start.
   ~~The game data's blocks kept in OPFS~~ (done, below).
5. Multiplayer: no UDP in a browser, so the game's IPX/UDP through a
   WebSocket relay on the server (a virtual LAN switch, as nfsu2-web's).
   On hold (2026-10-26): the user may have another idea for it.
   To mind then: the game tells machines apart by a session UniqueID
   (`sub_00697AD0`) mixed from `timeGetTime`, the free disk space (win32hle's
   is a constant 2047 MB, below) and each character of `PATH` (a
   page has none): in the browser it is mostly the millisecond, and native
   playtests started at the same moment got the same one. A random `PATH` per browser, kept, would make
   it unique with no change to the game.
6. ~~Fonts for GDI text~~: not needed for RA2 (2026-10-26, measured: the game
   draws all its text with its own fonts; no text or font call in 70 M import
   calls over menus, skirmish, campaign, options, load and, natively, the LAN
   lobby; the list screens byte-identical with and without fonts:
   `spike/gditext/RESULT.md`).

**Movies done (2026-10-26).** `wasi/ffmpeg.sh` cross-compiles FFmpeg 9.0.2
(the source from ffmpeg.org, checked against Homebrew's sha256) with wasi-sdk:
only Bink's demuxer, video and audio decoders, MP3's (Miles' codec, `mss.c`)
and libswresample, no assembly, no threads, the game module's wasm features;
3.3 MB of static libraries in 39 s. `wasi/build.sh` then compiles win32hle's
own `bink.c` and `mss.c` with `HLE_WITH_FFMPEG`, as the native build does, and
links them (the module grows 1.1 MB); `wasi/bink.c`'s black movies remain the
build without FFmpeg. Checked: the intro (800x600, 190 frames) and the main
menu's background (632x570, 431 frames) as natively, and the checksums of
the frames sampled during the intro (`B1C76FB6`, `6D1040EF`) are the native
build's (FFmpeg 8.1 there), so the decoding is the same to the pixel; in
Chrome the menu's background moves and the Soviet campaign's briefing plays at
15 fps with its Chinese subtitles (`work/runs/shots/briefing-2.png`). The
movies' sound goes to the mixer, and from there to the speakers (below).

**Sound done (2026-10-26).** `wasi/sdl.c`'s audio device (the thread that
runs DirectSound's mixer, 44.1 kHz 16-bit stereo, 1024 frames a call) mixes
into a ring in shared memory (16,384 frames, ~370 ms; `ra2web.register`
kind 3), and `web/audio-worklet.js` plays it on the browser's audio thread
(`web/audio.js`: an AudioContext at 44.1 kHz, no resampling). While the page
plays, the sound card's clock paces the mixer: it mixes another buffer whenever
the ring holds less than 4,096 frames (~93 ms), so the clocks cannot drift and
DirectSound's play cursors move with the speakers; before the page plays (a
browser starts sound after a gesture: the first click or key) and under Node,
the mixer keeps its own clock, into nothing, as before. The page no longer
passes `--mute`. Checked in Chrome (`tools/chrome.mjs --wav` saves what the
speakers get): the context runs at 44.1 kHz with 5 ms of output latency;
44,160 frames played a second; the intro's sound, silence while loading, the
menu's music (`Theme::PlaySong`) and a skirmish's music as RMS 0.05-0.18;
0 short quanta to the main menu and 2 in a 100 s skirmish (of 128 frames);
the frame pacing unchanged (6.4 ms). The captures are music, not noise: their
spectrograms show harmonics and beats (`work/runs/*-spectrum.png`), 2,600-2,800
zero crossings a second (white noise at 44.1 kHz: ~22,000), left and right
correlated 0.60-0.88, nothing clipped.

**Saves and settings done (2026-10-26).** `web/save-store.js` keeps the
overlay (what the game writes) in the site's OPFS: a folder per save set
(`?save=`, default `ra2yr`; the test page `ra2yr-test`; `?fresh` empties it
first), a file there for every file the game wrote at its path in the game
folder, `_gone.json` for the data files it deleted; read and written through
synchronous access handles in the I/O worker, one per file however often it
is open; an index walked at start ("[save] ... files kept from before"). In
memory where a browser has no OPFS. The data layer is unchanged (blocks over
HTTP, in memory). The play page asks for persistent storage (headless Chrome
says no: Chrome grants it to sites it sees used, bookmarked or installed;
without it only a disk short of room would make it clear the folder). A site
is a scheme, host and port: `tools/play.sh` keeps port 8780, so its saves stay;
another address starts empty. Checked in Chrome: a skirmish started writes
`RA2MD.INI` into OPFS, and the next page load (same site, same set) finds it
kept (1,699 bytes); `web/tests/store.html` (`tools/chrome.mjs --page
tests/store`) passes 18 checks over a reload: a file new, a data file copied
and written, truncated, renamed (an overlay file and a data file), deleted
(both), a folder with a file in it, a file open twice at once, all of it
there after the reload and the deleted data file still gone.

**The free disk space (2026-10-26).** The game asks KERNEL32 for
`GetDiskFreeSpaceExA` by `GetProcAddress` (`sub_0048DD50`: under 8 MB at
start it asks whether to go on, under 2 MB a save is refused as "disk full",
and the session UniqueID mixes it in). win32hle had none ("GetProcAddress
failed ... 127" in the log), so it took `GetDiskFreeSpaceA`, whose answer is a
constant 2047 MB (what Windows tells a program that old). win32hle
(`win32hle/kernel32_ext.c`) now answers the Ex call too, with the same
constant: 2047 MB free of 4 GB, nothing here. Under 2 GB on purpose: the game
reads the count's low half as signed (`fiadd` at 0x0048DDCC), so whenever that
half's top bit is set it comes out 4 GB short, or below 0 (measured: 6 GB read
as 2048 MB, 3 GB as 4,193,280), though both its checks compare unsigned and
pass anyway. A real figure (the disk's, OPFS's quota) was tried and dropped
as not worth what it took. Checked natively, under Node and in Chrome: "Using
GetDiskFreeSpaceEx", "Free disk space is 2047 Mb", no GetProcAddress
failure, the main menu reached.

**Windows' timer, the keys and the mouse (2026-10-26).** Three things a
friend on Windows would meet, before multiplayer.
- The timer (`spike/timer/RESULT.md`): Chrome on Windows wakes a timed
  `Atomics.wait` on a 15.6 ms OS timer at times (nfsu2-web measured it), and
  every timed wait of the game comes to `host/core/thread.mjs`: its main loop
  sleeps a millisecond at a time, ~390 times a second. Simulated
  (`RA2WEB_TIMER_MS=15.625`: every wait ended on that grid), the scripted
  skirmish ran 184-197 game frames in 3.33 s instead of 201-209, and the
  sound was short 8 times. Now `host/core/timer-probe.mjs` (a worker) keeps
  measuring how late a 1 ms wait wakes; where the median is later than 3 ms
  a sleep under 8 ms waits for all but that and spins the rest: 197-209 and
  the sound never short, the main thread spinning (~0.9 of a core) on a
  coarse timer only. On this Mac's timer nothing spins.
- Full screen (`web/fullscreen.js`): the start panel's choice (on), the
  bar's button, Alt+Enter as cnc-ddraw has it. The page full screen, the keys
  locked (Keyboard Lock: Escape, Ctrl+number, Alt reach the game; Escape held
  leaves) and the mouse locked in the picture (Pointer Lock): `input.js` then
  moves a cursor of its own by the mouse's moves, held in the picture, so it
  reaches an edge and stays there, and the presenter draws the game's menu
  cursor there (in a game the game draws its own).
- The edges in a window: the mouse that leaves the canvas leaves the game's
  cursor at the edge it crossed, so the map goes on scrolling, as against a
  screen's edge; the window losing the focus moves it 2 pixels in. (Since
  then a window keeps the mouse too, below; this is what is left where the
  browser will not keep it.)

Checked in Chrome (`spike/input/RESULT.md`, the game's view position read
from its memory: `TacticalClass` at `*(0x887324)`, x at `+0xB0`): scrolling
at each edge, beyond the window, stopped by the focus lost; Alt+Enter full
screen with the keys locked, Escape reaching the game (its menu) while the
page stays full screen; the locked mouse simulated (headless Chrome gives no
Pointer Lock): it starts at the game's cursor, moves at the picture's scale,
holds at the edges (the map scrolls), the page's cursor drawn in the menus and
not in a game. Not tested: a real Pointer Lock (it would take this Mac's
mouse), and anything on Windows itself.

**What the Steam release's wrappers do, taken (2026-10-26).** The Steam copy
(EA's The Ultimate Collection, 2024) ships DDrawCompat 0.5.4 as `ddraw.dll`
and ipxemu 1.0.4 as `wsock32.dll`, which the lift never loads (win32hle is
both), and its `game.exe` and `gamemd.exe` patched in place (no CD: the CD's
search looks at `.\`; the version shown as 1.001TUC), which the lift has.
From DDrawCompat's settings (its wiki: 62) and cnc-ddraw's (`config.c`, with
its Red Alert 2 sections), what applies here:
- Not kept: the menus' message loop held (DDrawCompat's `FpsLimiter =
  msgloop(120)`). Tried in win32hle's `PeekMessageA` (empty looks held to N
  a second): 40 s idle in the main menu took native 5.4 s of CPU instead of
  36.8 at 480, and the menu in Chrome kept 57-60 frames a second (45 at 120,
  55-58 at 240); taken out again (2026-10-26, the user's choice): the menus
  poll the empty queue as on Windows, a core busy while they show.
- Rows kept clear around every surface (DDrawCompat's `SurfacePatches =
  top:64, bottom:64`, cnc-ddraw's `guard_lines`): win32hle kept 64 KB behind
  a surface only; now 64 rows in front and behind (`ddraw.c`, ~100 KB a
  surface at 800x600). `HLE_SURF_GUARD=1` keeps 200 rows each side filled
  with a pattern and logs what the game writes there: nothing, in a skirmish
  scrolled to all four edges and the start of both campaigns.
- Scaling (`web/presenter.js`), each wrapper's as its source computes it.
  DDrawCompat's `DisplayFilter` (`ShaderBlitter.cpp`, `Shaders/*.hlsl`):
  bilinear with its blur 0-100 (0, the default there and here, is sharp;
  100 the plain bilinear), point (EA's choice in the Steam copy), integer,
  bicubic with its blur (Mitchell-Netravali, 0 being Catmull-Rom), lanczos
  and spline with 2-4 lobes; in linear light, one axis a pass, more taps
  where the picture shrinks. cnc-ddraw's own shaders (`inc/openglshader.h`,
  in the picture's colours): bilinear, Catmull-Rom in 5 taps (its default),
  Hyllian's lanczos2-sharp and xBR-lv2 (its `f4`, never set there or
  upstream, is 0 here, as WebGL makes an unset one). The bars beside the
  picture are black, as both have them. The game's size never follows the window: a window
  resized scales the same picture (integer: the largest whole multiple that
  fits, and where not even 1x fits, scaled to fit, as cnc-ddraw's boxing).
- A menu (Shift+F11, DDrawCompat's `ConfigHotKey` and configuration overlay):
  the filter and its blur or lobes, the locked mouse's sensitivity
  (DDrawCompat's `MouseSensitivity`, a setting of later DDrawCompat, not the Steam release's 0.5.4), the stats, full screen, a screenshot
  (`web/settings.js`, kept in localStorage; an older page's sharp, smooth,
  crt and nearest become bilinear 0, 100, 0 and point). Stats in a corner (Shift+F12,
  DDrawCompat's `StatsHotKey`): the page's frame rate, the game's frames a
  second (its counter at 0xA8ED84), the timer (fine, or coarse and how late),
  the sound and its underruns, the mouse. A screenshot (PrintScreen,
  cnc-ddraw's): the frame at the game's size, a PNG downloaded.
- The mouse, as cnc-ddraw keeps it (`wndproc.c`, `mouse.c`), here and in the
  native presenter: a click keeps it in the picture (the browser's Pointer
  Lock; full screen keeps it as it starts; a window in a battle only, below),
  and that click is not the game's, only the game's cursor goes where it was
  (beside the picture: to the middle); Ctrl+Tab or right Alt + right Ctrl
  lets it go (cnc-ddraw's unlock keys; in a window Ctrl+Tab is the
  browser's), and so do the page's menu and another window; a mouse let go
  is not the game's, no moves and no clicks. In a window, the keys not
  locked, Escape is the browser's while it keeps the mouse (it lets the
  mouse go; Chromium's `exclusive_access_manager.cc` passes the page no key
  down, only the key up), so a key up of Escape that had no key down, just
  after the lock went, gives the game its Escape. Where the browser will not
  keep the mouse (refused, headless Chrome, its second after an Escape) the
  click that asked goes to the game after all, and the mouse is the game's
  as it moves until a click gets the lock (`web/input.js`). A window keeps it
  in a battle only (`presenter.battle()`: the game's own capture of the
  mouse, `Capture_Mouse()` and `Release_Mouse()`, measured in
  `spike/input/RESULT.md`): its menus have the mouse as it is, their clicks
  the game's at once; a battle's menu opening lets it go, the battle coming
  back asks for it (Resume's click being the gesture the browser wants; asked
  again a few times, the browser refusing for 1.25 s after an Escape:
  Chromium's `kEffectiveUserEscapeDuration`), and a battle begun after a long
  load gets it at its first click.
- Not taken: activation messages (cnc-ddraw's `noactivateapp`: win32hle never
  sends a game its deactivation already), single-core affinity (the machine
  lock runs one guest thread at a time), `WinVersionLie`, `tshack` (surfaces
  reported as video memory), exclusive full screen, DPI and alt-tab fixes (a
  real DirectDraw's matters), `PresentDelay` (the page shows the frame the
  game has when it reads its message queue already).

Checked in Chrome: in a window, the main menu's first click opening Single
Player with no lock; the lock granted (simulated) as the battle began, let go
by the browser's Escape with the game's menu (0xB5) open and the page's
cursor shown, granted again at Resume; the lock refused in a battle, the
mouse not the game's until a click, that click the game's and from then on
its moves. Before that: the lock refused (headless), the click that asked
opening Single Player all the same; the lock granted (simulated: headless Chrome has
none), that click not the game's and the game's cursor at it, the next one
opening Single Player, moves while let go not the game's, and in a skirmish
the browser's Escape (the lock ended, a key up alone) opening the game's menu
(0xB5). A real lock, and a window's Escape in a real Chrome, not tried (it
would take this Mac's mouse). Every filter drawn (`work/runs/filters`), and 60 pixels
of each DDrawCompat filter (point, bilinear 0 and 100, bicubic 0 and 50,
lanczos 3, spline 2, 3 and 4) against the same formulas computed on the CPU
from the frame: 1-2/255 apart at most (8-bit rounding); Shift+F11 opening the
menu, its blur or lobes shown for the filters that have one, Shift+F12's
stats, a screenshot of 800x600 as a PNG, Ctrl+Tab letting the (simulated)
locked mouse go, a sensitivity of 200% moving it twice as far (100 CSS px:
125 game pixels at 0.625).

**The game as shipped, on the page (2026-10-26).** The web has a host of its
own, `wasi/main.c`, in place of the native one (`src/linux/main.c`), and none
of the remaster's features: no HD vehicles, Modern controls, mods, F10 menu,
FPS display, `ra2.ini`, recording, or `--headless` (it meant "no native
window", which the web never has). The lift's patches still call a host: the
remaster's features answer as they do switched off (`ra2_vox_hd_on` 0,
`ra2_modern_controls` 0), and its two fixes stay (the sidebar's rows capped
past 1440 lines, the line clipper's rounds capped: issue #20). Of the native
host only `script.c` (the tests' scripted input) and `blowfish.c` (the
game's cipher) are built. `RA2_FRAME_STATS` still says the frame time. A
message box's question is answered No, as through `--headless` before.
Checked: the main menu under Node, the scripted skirmish in Chrome (209 game
frames each 3.33 s, as before), the cache and store test pages.

**The resolutions: the game's own, a display's list (2026-10-26).** The game
lists only 640, 800 and 1024 wide in its Options screen unless its INI has
`[Video] AllowHiResModes=yes` (its code: read at 0x5FA942, the list built
near 0x56017A, every 16-bit mode from 640x480 to 4096x4096 when on); it
never writes the key. `wasi/main.c` adds `yes` when the INI has none (a
player's own value stays), as the native host does. The modes offered are a
display's, as the Steam release's DDrawCompat passes them on (`native` in
EA's `DDrawCompat.ini`: every mode of the display): the page writes its
screen's size, logical and in pixels, into the frames header
(`presenter.js`; in pixels exact in full screen at any zoom, otherwise at a
zoom of 100%), and `wasi/screen.c` answers ddraw.c's `hle_dd_modes_hook`
(win32hle's; unset natively) with ddraw.c's table cut to what fits the screen
in pixels, the screen's own sizes added, 640x480 and 800x600 always. The
game's size never follows the window (above). Checked in Chrome on a
simulated 1470x956 screen at 2x: the INI without the key got it, the game
logging `AllowHiRes is ON`; its Options screen offered 640x480 to 2560x1600
less 3440x1440 and wider, plus 1470x956 and 2940x1912. Measured (wasm,
uncapped, the scripted skirmish): 0.7 ms a frame at 640x480, 1.4 at
1920x1080, 2.2-2.9 at 2560x1440, 3.4-4.4 at 3840x2160; in Chrome 60 game
frames a second and 59-60 shown at 640x480, 1920x1080 and 3840x2160 (this
Mac; slower machines not tried).

**Saves out and back (2026-10-28).** A site's OPFS is its own (scheme, host
and port) and the browser's: another address, browser or machine starts
without the saves. The start panel's "存档" section (`web/saves.js`) exports
them as one zip and imports one: the saves only, as the game names them
(`SAVE%04lX.SAV`, its format at 0x829EE8) at the save set's top, not its
INI or anything else it wrote; deflated by Chrome's `CompressionStream`, no
library. An import takes a zip's saves at its top or in a folder of it (a
folder zipped whole; macOS's `__MACOSX/` entries left out), checks each one's
size and CRC, asks before it replaces saves of the same names, and writes over
a save of the name in another case rather than beside it (win32hle's lookup
ignores case). The panel is up only while the game is not running, which
keeps its files open. Checked in Chrome: `web/tests/saves.html`
(`tools/chrome.mjs --page tests/saves`) passes 9 checks: what is a save and
what is not (an INI, `SAVE00G1.SAV`, a save in a folder), 2,009,000 bytes out
in an 8,640-byte zip and back the same, a zip made by Python's `zipfile` (a
folder, macOS's entries, stored and deflated) read, `save0002.sav` replaced
by `SAVE0002.SAV` and no second file, a damaged zip and a file that is no zip
refused; the exported zip read by Python's `zipfile` (`testzip` clean) and
macOS's `unzip`. The panel's buttons on the play page: no saves, the export
off; a zip imported, "这个浏览器里有 2 个存档", the export on and exporting both.

**The game's own bugs that CnCNet fixes (2026-10-28).** Six, in the lift
(`lift/run_lift.py` `bugfix_patches`, one `wasi/fixes.c`), each where CnCNet
found it (yrpp-spawner `src/Misc/Bugfixes.cpp`,
`Bugfixes.ClampTacticalPos.cpp`, `Bugfixes.IsoMapPack5Limit.cpp`, `VideoMode.cpp`;
yr-patches' type select: GPL-3.0, read, not copied), checked in IDA and written anew.
None touches the game's state, so none can unsync a network game.
- **A map smaller than the view.** The view's limits (0x6D8640: x from
  `view w / 2 + 30 (2 visible x - map w)` to that `+ 60 visible w - view w`,
  y from `view h / 2 + 15 (map w + 2 visible y - 5)` to that
  `+ (60 visible h + 270) / 2 - view h`) cross when the map's visible part is
  narrower or shorter than the view, and the view is set to one, then the
  other: of the game's 161 maps 52 at 3840x2160, 13 at 2560x1440, 19 at
  3440x1440, TurfWar at 1920x1080. Both are their middle then (0x6D86BE), as
  CnCNet's: the view centred. The view beside the map, where no cell is drawn
  and the composite surface held whatever it last did, is filled black once
  the map is drawn (0x6D4934, `wasi/fixes.c`, from the limits before they are
  centred: the map's edges). The radar's frame of the view is kept inside its
  picture of the map (0x657134): the game moves it in so that its x + width
  is at most the picture's x + width - 1, which a frame wider than the
  picture cannot be; it is made the picture's width less one then (CnCNet's
  makes it the whole width, one more than the game itself ever leaves) and
  moved in, and a frame that fits is left as the game set it. Checked: TurfWar
  at 1920x1080 (the view 1752x1048, y's limits 2369 and 2146) black 112
  pixels above the map and 111 below; The Alamo at 3840x2160 (the view
  3672x2128) 156 left and right, 247 above and 246 below, its base's edge
  where the band ends; The Alamo at 1920x1080 the
  same view as the build before, nothing filled. The radar's part needs a
  radar on such a map: not seen.
- **A big map's terrain.** The map's cells (`IsoMapPack5`) are read, still
  packed, into a 640x400 16-bit surface (0x4AD343-0x4AD356), 512,000 bytes:
  what is past it is cut (`Get_UUBlock`, 0x526FB0) and its cells left clear
  land at height 0. The surface 1024x768 now, 1,572,864 bytes, as CnCNet's.
  The game's own maps use 41 % of the old at most (XMP20T6, 207,587 bytes).
  Checked with a map past it: The Alamo with its cells after 50,000 copies of
  its first (the same cell set again), each block packed as literals only
  (LZO1X, so 631,694 bytes packed, 123 % of the old size, 40 % of the new), a
  loose `XMP29U2.MAP` in the game folder: the build before showed clear land
  for its roads, lots and fields, this one The Alamo as shipped.
- **The loading screen's waits.** Do_Blit (0x4F4780) sleeps 50 ms before the
  mouse puts the cursor back (WWMouse +0x40, 0x7B92D0), which does nothing
  unless the mouse is captured (+0x1C): the loading screen's blits waited for
  nothing. Slept only when captured (0x4F4B8E). Measured: a skirmish's
  loading (The Alamo, 1920x1080, under Node) 15.1 s twice before, 11.7 and
  11.5 s now.
- **Type select pressed again and again** (0x732CC0): twice in 500 ms selects
  every unit of the type on the map, then asks for the whole screen redrawn
  (FlagToRedraw(1), 0x4F42F0); not asked now (0x732CED to 0x732CF9, as
  yr-patches'): the selection shows as the view is drawn anyway. Not measured.
- **Waiting for the other players** (dialog 0xEA, 0x648710). On Windows its
  first control, Leave Game (IDCANCEL), gets the focus as the dialog is shown
  (the dialog manager's first tab stop), and Space, meant for the game (it
  centres the view on the last radar event: `CenterOnRadarEvent=32` in
  KEYBOARDMD.INI), presses it: the player has left. The focus is
  taken off once it is shown (SetFocus(0) at 0x648CCC, as CnCNet's). Here the
  bug does not show: win32hle gives the dialog itself the focus as it is
  shown. Tried before the fix (a pair, Alice under Node stopped for 45 s
  40 s into the battle, Bob in Chrome): Space and Enter at 3 and
  6 s went to the dialog (a log of win32hle's key target), which did nothing;
  Bob waited its 30 s and removed Alice. After it the same: nothing on Space
  or Enter, Alice removed after 30 s, both on to the score screen. The patch
  stays, so that it cannot whatever win32hle's focus does.
- **The shell's layout at 601 to 767 lines** (0x72EC70, the screen's width and
  height): the 800x600 shell is centred across from 1024 wide and down from
  768 high (0x72ECA4), so at 1280x720 it sits at the top and the 120 lines
  under it are never drawn. Seen in a game's menus (Esc, Delete Game: the
  message box asking Yes or No draws the shell behind it): what the surface
  last held, noise, under the shell. Centred down from 600 high now (the jump
  at 0x72ECB2 against 600; the spawner's `VideoMode.cpp` writes 600 into the
  compare): 60 lines black above and below at 720. 800x600, 1366x768 and
  every height under 601 or over 767 lay out as before (the same numbers).
  Checked in Chrome at 1280x720, the allied campaign's first mission: the
  noise before, the shell centred after.

**A window gone uncovers its siblings (2026-10-28).** win32hle repainted the
parent where a window had been, and the parent's children there only if it did
not clip them (WS_CLIPCHILDREN); the game's main window clips them, so a
dialog closed over another, a sibling under the same main window, left the
other unpainted, its last picture on screen. Windows repaints whatever is
uncovered, whatever the parent's style (that only keeps the parent's own
painting off its children). pcrecomp had fixed it upstream the day before
(`7f217a7`: the siblings below the window, higher in z, repainted where it
was; found with the Options screen left blank after its box to keep a new
resolution), taken here as it is (`uncover`, `win32hle/user32.c`). It holds
here because the menu is below the message box in win32hle's z-order too (a
log of `uncover`: the box at z 37, the menu, 1280x720, at 38). Seen with the
in-game Delete Game at 1280x720: Yes or No asked, then Esc or 否, and the
screen kept the message box (its checksum the same for as long as it was left:
600 to 1,100 frames) though the game went on (Back and Resume Mission, clicked
blind, worked); the build before these fixes did the same. Now the list of
saves is drawn again at once, after Esc as after 否.

**The local time (2026-10-28).** WASI's C library has no time zone: its
`localtime_r` is UTC whatever `TZ` says (a test with wasmtime: `CST-8`,
`LOC-8:00` and a DST rule all came out UTC), so the game's local time was
UTC: its saves were dated 8 hours early in China (Delete Game's list showed
10/27 8:13 PM at 04:13 on 10/28). The page gives the browser's offset now
(`RA2WEB_TZ`, minutes east of UTC: `web/process.js`; under Node
`host/run.mjs` gives the machine's), `wasi/main.c` hands it to win32hle
(`hle_tz_minutes`), and its three ways to local time (GetLocalTime, the file
times' and GetTimeZoneInformation's bias, the CRT's date and time formats)
take it through `hle_localtime`; a native host sets none and keeps its C
library's. The offset of the page's start throughout, as Windows'
FileTimeToLocalFileTime takes the one of now. Checked in Chrome: "[host]
time zone: UTC+8:00", and a save made at 5:27 AM listed at 10/28/2026 5:27:51
AM.

**The mouse wheel (2026-10-28).** The game's main window takes
WM_MOUSEWHEEL (0x7775C0: 522): a row of the sidebar up or down a message
(its SidebarUp or SidebarDown command, the keyboard's numpad 8 and 2),
whatever the delta. Neither host sent it. The page now does where the mouse
is the game's (as its clicks: `web/input.js`): the browser's wheel in
WHEEL_DELTA units (a line 120, a page three lines, 100 pixels a line, as
nfsu2-web counts them), one message for each 120 gathered, so a notch is a
row and a trackpad's slow swipe no flood; `wasi/screen.c` takes it from the
input ring ({ 3, delta, x, y }) to win32hle's `hle_input_wheel`, which sends
it to the window with the focus, as Windows; a window that does not take it
passes it to its parent (DefWindowProc, as Windows'). Checked in Chrome, a
skirmish: three notches down were three WM_MOUSEWHEEL of -120 to the main
window's 0x7775C0, three up +120 (a log, taken out after). Its sidebar was
empty there, and the allied campaign's first mission had no tab of more
than a page, so the rows moving was not seen.

**Cmd, the page's log and the saves' lock (2026-10-28).**
- **Cmd** (Meta; the Windows key elsewhere) is the browser's and the
  system's: a key pressed with it goes to them as it is (Cmd+C copies, Cmd+R
  reloads), not to the game, and Cmd going down lets go of the keys held:
  macOS sends no key-up for a key let go while Cmd is down, so a key of a
  Cmd shortcut stayed down in the game (`web/input.js`, as nfsu2-web does).
  Before, such a key went to the game and the page cancelled the browser's
  default for it: Cmd+C copied nothing (why the log could not be copied).
- **The log** (`web/page-log.js`): all of a session's lines (the last
  20,000), downloaded as a text file or copied whole, from the start panel
  ("日志") or Shift+F11, a header of the page and the browser first; the
  page's own thread keeps it, so a game that hangs (it runs in workers)
  leaves it to be had. The log over the picture (a click on the bar) is added
  to a line at a time, the last 500, so a selection in it stays to be copied:
  it was all written again twice a second, and Cmd+C was the page's.
- **The saves' lock** (`web/saves.js` `claimSaves`): a save set is one
  page's at a time, a Web Lock as online play's (`online.js`): two pages on
  one folder would open its files at once (an OPFS file has one writer: the
  second page's writes fail), and an import or an export beside a running game
  would meet it half-written. The page takes it as its game starts (the play
  button, or the tests' `&go`) and lets it go as the game ends; an import or
  an export takes it while it lasts. Another page's: "这个存档正在另一个页面里使用",
  the game not started, nothing imported or exported.
