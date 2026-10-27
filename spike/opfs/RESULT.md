# opfs: what the game data's OPFS cache costs (2026-10-26)

`bench.html` (its worker `bench-worker.js`) in headless Chrome 155 on this
Mac (M-series, the profile on the external APFS volume), through
`node tools/chrome.mjs --page /spike/opfs/bench`:

| What | Median | p90 |
|---|---|---|
| `getFileHandle` (create) | 0.245 ms | 0.31 ms |
| `createSyncAccessHandle` | 0.205 ms | 0.31 ms |
| the same, `mode: 'readwrite-unsafe'` | 0.18 ms | 0.25 ms |
| write 1 MiB | 0.13 ms | 0.27 ms |
| **`flush()` after it** | **7.1 ms** | 8.0 ms |
| read 1 MiB | 0.135 ms | 0.15 ms |
| write 1 byte | 0.01 ms | 0.02 ms |
| write 16 MiB, then one `flush()` | 31 ms (1.9 ms a MiB) | 34 ms |

- A hole of a sparse file reads as zeros, and **counts against the site's
  quota at the file's whole length**: a file 428 MiB long with 192 MiB of it
  written took 428 MiB of usage (`navigator.storage.estimate`).
- Two workers (as two tabs would) on one file: in the default mode the second
  `createSyncAccessHandle` fails, `NoModificationAllowedError`; with
  `readwrite-unsafe` both hold it and the second reads what the first wrote.
- Meanwhile `getFile()` (the File API, any thread) reads the file in either
  mode: a page can count what the cache holds while a worker writes it.

## What the game data compresses to (2026-10-26)

Node 24's zlib, 1 MiB blocks (up to 40 spread over each file), the share of
the size left and the speed on this Mac:

| File | MB | gzip 1 | gzip 6 | br 1 | br 5 | zstd 3 |
|---|---|---|---|---|---|---|
| ra2.mix | 269 | 46%, 96 MB/s | 42%, 45 MB/s | 42%, 280 MB/s | 34%, 60 MB/s | 38%, 347 MB/s |
| ra2md.mix | 195 | 44% | 41% | 44% | 35% | 40%, 339 MB/s |
| multimd.mix | 30 | 52% | 49% | 52% | 43% | 47% |
| langmd.mix, language.mix | 131 | 88-90% | 88-90% | 89-91% | 88-90% | 88-91% |
| THEME.MIX, thememd.mix (music) | 118 | 90% | 90% | 90% | 89% | 90% |
| movies01.mix | 341 | 99% | 99% | 100% | 100% | 100% |

The data but the movies (about 810 MB) crosses the network in about 60% of
its size with zstd 3, at a speed no LAN outruns. The module, `out/ra2.wasm`
(120 MB): zstd 3 15.4 MB (13%) in 0.26 s, br 5 13.1 MB (11%) in 1.2 s,
gzip 6 18.8 MB (16%) in 1.7 s.

What the cache takes from this (`web/data-cache.js`):

- Blocks packed one after another in a file per data file, an index naming
  each block's slot, not each at its own offset (sparse): what is kept is
  what counts against the quota (a block deep in a 341 MB movie archive would
  otherwise count all 341 MB), and a file system without holes (NTFS) has no
  zeros to write first.
- Packed, a file has one writer: the I/O worker holding a Web Lock for the
  cache, so one tab at a time; the default (exclusive) mode then.
- A flush costs about 50 reads, so a block's index entry is not written at
  once: blocks are flushed a few at a time, then their entries written. An
  entry is there only for bytes that are on the disk.
- A block reads back from OPFS in 0.14 ms: with OPFS keeping the blocks, the
  memory needs to hold only those being read (64 MB, as nfsu2-web's).
