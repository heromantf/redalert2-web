# The download ahead that stopped: OPFS access handles left unanswered (2026-10-27)

**Seen.** In `tools/lan/pair.sh chrome`, Bob's download ahead once stopped at its
start for 390 s. `tools/predownload-loop.sh` (fresh
sites, direct start with `&download`): 7 of 16 downloads stopped, always with
everything but a last small file kept (`ra2md.lcf`, `WDT.MIX`, `MonsterM.yro`...).

**Where.** The worker now says, after 30 s with nothing kept, what each lane is
doing; the cache, where each file's opening stands. Every time: one lane
"keeping" a block, its file's `createSyncAccessHandle()` (its blocks' or its
index's) never answered; the worker otherwise alive, nothing else pending.

**Not it.** The page's 2-s online check reading the indexes (`scanKept`): the
cache directory of a fresh site is empty before the download. Here, in plain
loops (`test.html`, `worker.js`): a file closed and opened again 400 times;
323 files in turn through 64 kept open (data-cache.js's turnover), with their
indexes, with 1 MB writes; four lanes at once sharing it; a handle asked for
while another file's was being closed: 0 of 12,000 handles unanswered. A
second handle on a file still open: refused at once (`NoModificationAllowedError`),
never left waiting.

**What changes it** (fresh downloads, Chrome 155 on this Mac):

| the download's handles | stopped / waited |
|---|---|
| every file opened first (its missing blocks), 64 kept: most opened again later | 7 of 16 stopped |
| every file opened only when its blocks come, 64 kept (the rest closed meanwhile) | 1 of 24 stopped; with one ask again: 3 of 24 waited 15 s, all done |
| nothing closed until the end (all 323 kept open: 646 handles) | 0 of 8; 0 of 24 |

A request left unanswered stays so (the first never came, even later); one
asked again is answered at once. So Chrome loses a request now and then while
other handles are being closed under that load (90 MB/s written, the network
streams); not reproduced without it.

**Kept.** `data-cache.js`: `missing()` reads a file's index without opening it
(the same check as its opening, `checkIndex`); an access handle asked for again
once after 15 s, else the file not kept, told; `keep()` says whether it kept
the block. `predownload-worker.js`: nothing closed until it ends (first
`maxOpen: Infinity`; now the default, `MAX_OPEN`, below); blocks not kept are not counted, and end it in an error; 30 s with
nothing kept are told, lane by lane. The panel: "下载 N 秒没有进展" with how
to try again. A game opens about 27 (a campaign, skirmishes, the movies, a LAN
game: 26-27, none closed); `MAX_OPEN` is now 1024, more than the data's 604
files, so none is closed in a game either (the web build is judged by Chrome;
WebKit's 251 handles a page, for which it was 64, no longer weighed).
