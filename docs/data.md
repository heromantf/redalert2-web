# The game data

The game data on the page: its blocks kept in OPFS as they are read, and all
of it downloaded ahead from the start panel. Moved here from README.md as it was written at the time;
the experiments behind it are in `spike/`.

**The game data in OPFS (2026-10-26).** A block the game reads is kept in the
site's OPFS (`web/data-cache.js`) and read from there from then on; the
server is asked only for what this browser has not kept.
- What it costs (`spike/opfs/RESULT.md`, Chrome 155): a block written in
  0.13 ms and read in 0.14 ms, a `flush()` 7 ms; a sparse file counts against
  the quota at its whole length; two holders of one file only in
  `readwrite-unsafe` mode.
- So, in `data-cache-v1/`: a file per data file with blocks kept, the blocks
  packed in 1 MiB slots in the order they came, and an index (a uint32 a
  block: its slot + 1). The name is the path, size and mtime: a file changed
  on the server is a new one, and cache files of data the server no longer
  has are deleted at the start. Packed, the quota counts what is kept (a
  block deep in a 341 MB movie archive is 1 MiB, not 341), and a file system
  without holes writes no zeros.
- One writer: the I/O worker holding the Web Lock `ra2web-data-cache`; a
  second tab of the site reads from the server. Blocks are flushed a few at
  a time (32, or after a second), then their index entries written: an entry
  names only bytes on the disk, a slot is taken past every one the index
  names, an index that does not fit its file empties it. When the game ends,
  the page has the I/O worker make all of it last before it goes.
- The memory keeps the blocks being read, 64 MB (256 MB without OPFS, or once
  OPFS has no room). No room (the disk, the quota) ends the keeping for the
  page, never a read.
- The blocks' requests: a lost one (no answer, 408, 429, 5xx, no byte for
  20 s) is made again after 0.25 s, doubling to 8 s, for as long as it takes;
  the blocks of one read are asked for 8 at a time.
- `?nocache`: none kept; `?freshcache`: emptied first. `tools/chrome.mjs`
  clears the site's storage at the end of a run on a port of its own (it grew
  by 133 MB to the menu, and was back afterwards).

Checked in Chrome: `web/tests/cache.html` passes 19 checks over three page
loads (every read the server's bytes): a fresh cache filled, each block once,
with 2 cache files open at most (closed and opened again); read back with no
memory, all from OPFS; another tab meanwhile from the server only; after a
reload all from OPFS but the file whose index was broken (emptied), a stale
cache file deleted, and every block the cache names, read past its code,
the server's; a full disk at the 3rd block and a server losing every 4th
request: the same bytes, 2 kept. The game on one port: the first start to the
main menu 148 blocks from the server (24.0 s), the second **none** (166 reads
from OPFS, 22.2 s; on this machine the server is fast too); the 153 blocks
kept are the server's byte for byte. The scripted skirmish: in the game at
the game's pace (6.49 ms a frame), 208 blocks fetched and kept (192 MB).

**The download ahead, and a slow LAN (2026-10-26).** A LAN may be slow and
far (an SD-WAN: a few to a few tens of Mbit/s, tens of ms or more, a path
that changes), so the game data can come ahead of play, and it all crosses
compressed.
- What it compresses to (`spike/opfs/RESULT.md`, 1 MiB blocks): the core
  archives (`ra2.mix`, `ra2md.mix`, 464 MB) to 38-40% with zstd 3 at
  ~340 MB/s, the language and music archives to ~90%, the movies not at all;
  the module (`out/ra2.wasm`, 120 MB) to 13 MB with brotli 5.
- `web/server.mjs`: `/blocks/<path>?b=F&n=N&s=SIZE&m=MTIME`, up to 16 blocks
  as one answer of exactly their bytes, compressed where the browser takes it
  and it pays (zstd 3, else brotli 1, else gzip 1); 409 when the file is not
  the one the page's manifest named. The pages, scripts and module are
  revalidated (ETag, `no-cache`): a page load that changes nothing fetches
  304s; the module goes brotli 5, compressed once a build (1.2 s). For
  tests: `--throttle KBPS[,MS]` (one shared link, each answer MS later) and
  `--drop N` (every Nth answer of data cut halfway, once its first half is
  out: a cut before any byte Chrome itself asks again for, unseen).
- `web/block-fetch.js` (the game's reads and the download): a run's blocks
  handed on as their bytes come, so a cut answer loses only the block in it;
  a try that fails or stalls (20 s) is made again for the blocks still to
  come, 0.25 s doubling to 8 s and back to 0.25 s once a try brings some; a
  file changed on the server fails (reload).
- `web/predownload-worker.js`: what `game-files.js` takes (the data but the
  movies, 323 files, 814 MB; with them 1.8 GB; never the installers, manuals
  or map editor) that the cache lacks, in runs of up to 8 blocks, 4 answers
  at once (32 MB on the way: a far link kept full), each block kept as it
  comes, holding the cache's lock; before it starts, whether the site has
  room. Stopped or failed, what it kept stays and it goes on from there.
- `web/play.html` opens on a start panel (Chinese): Play, and the game data
  on this browser: how much, the game's files and the movies apart (a bar
  each, the movies' whether the download takes them or not: a game keeps what
  it plays of them), the speed and time left (the last 5 s),
  the server waited for and why, pause and resume, with the movies or not,
  delete, whether the browser keeps it for good and the room left. Play
  pauses the download, the game's end resumes it. `?download` starts it at
  once; with the host's arguments (tests) or `?go` the game starts at once
  (`?panel`: the panel all the same).

Checked in Chrome: `web/tests/predownload.html` passes 14 checks over a link
of 3,000 KB/s and 40 ms cutting every 9th answer: progress only grows;
stopped part way, what it kept is in the index; started again, done, nothing
kept twice; every block the server's (122 of 122); 8.2 MB on the network for
17.9 MB of data; 12 cut answers made again; another holder of the cache:
busy; a full disk: an error, told. The whole download (no movies): 814 MB in
11 s here, **184 s over 2,500 KB/s and 60 ms** (435 MB on the network, 97%
of the link's time; uncompressed it would take 333 s). Over the downloaded
cache the scripted skirmish fetched 1 block from the server (a movie's). On
the page: the panel downloading at 3.4-3.7 MB/s over a 2.4 MB/s link, Play
paused it at once, the game ran, and its end brought the panel back with the
download going on.
