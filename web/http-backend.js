// The browser I/O worker's backend (../host/core/io.mjs): one mount, the game
// folder, as two layers.
//   - The game data, read-only, from web/server.mjs: the folder's tree from
//     /data/manifest.json once, a file's bytes in 1 MiB blocks (/blocks/,
//     compressed where it pays: block-fetch.js).
//     A block read once is kept in the site's OPFS (data-cache.js) and comes
//     from there from then on; the blocks being read are kept in memory too,
//     the least recently used dropped past a budget (64 MB over OPFS, which
//     reads a block in 0.14 ms; 256 MB where there is no OPFS cache: to the
//     main menu the game reads 135 MB).
//   - An overlay for what the game writes (its INI, logs, saves), kept by
//     save-store.js: in the site's OPFS, so it outlives the page, or in memory
//     without one. A data file opened for writing is copied into it first; it
//     shadows the data, and a deletion hides a data file.
// A block request that fails on the way or stalls is made again for as long as
// it takes (block-fetch.js), as the game's read of a slow disc would wait: a
// failed read reaches the game as an error it does not expect. Only what asking
// again cannot change fails the read (the file changed on the server: reload).
// cache: false keeps no game data in OPFS; freshCache empties what it kept.
// fault (tests): { fail: N } every Nth request fails as a lost connection,
// { full: N } the Nth block kept fails as a full disk (data-cache.js);
// cacheOpen (tests): the cache files open at once. budget: the memory's, fixed.
import { E } from '../host/proto.mjs';
import { fetchRun, Gone } from './block-fetch.js';
import { BLOCK, openDataCache } from './data-cache.js';
import { saveStore } from './save-store.js';

const SLOW_MS = 5000, WINDOW = 8;     // WINDOW: the blocks of one read asked for at once
const fail = (errno) => Object.assign(new Error(`WASI errno ${errno}`), { errno });

export async function httpBackend({ base = '/data/', mount = '/game', budget = 0, save = 'ra2yr', fresh = false,
                                    cache: keepData = true, freshCache = false, fault = {}, cacheOpen, note = () => {} } = {}) {
  const r = await fetch(base + 'manifest.json');
  if (!r.ok) throw new Error(`manifest: HTTP ${r.status}`);
  const root = { dir: true, kids: new Map(), mtime: 0, path: '' }, dataFiles = [];
  for (const f of (await r.json()).files) {
    const parts = f.p.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let k = cur.kids.get(parts[i]);
      if (!k) cur.kids.set(parts[i], k = { dir: true, kids: new Map(), mtime: 0, path: parts.slice(0, i + 1).join('/') });
      cur = k;
    }
    const leaf = parts[parts.length - 1];
    if (f.d) { if (!cur.kids.has(leaf)) cur.kids.set(leaf, { dir: true, kids: new Map(), mtime: f.m, path: f.p }); }
    else { const n = { dir: false, size: f.s, mtime: f.m, path: f.p }; cur.kids.set(leaf, n); dataFiles.push(n); }
  }
  const data = (rel) => {
    let cur = root;
    for (const p of rel ? rel.split('/') : []) { if (!cur.dir) return null; cur = cur.kids.get(p); if (!cur) return null; }
    return cur;
  };

  // ---- the overlay ----
  const store = await saveStore({ name: save, fresh, note });
  const { files, dirs, gone } = store;    // rel -> { size, mtime }; Sets of rel
  const parentOf = (rel) => rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const nameOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
  function entry(rel) {        // what is at rel: { ov } | { dir } | { node } | null
    if (files.has(rel)) return { ov: files.get(rel) };
    if (dirs.has(rel)) return { dir: true };
    if (gone.has(rel)) return null;
    const n = data(rel);
    return n ? (n.dir ? { dir: true, node: n } : { node: n }) : null;
  }
  const hide = async (rel) => { if (data(rel)) { gone.add(rel); await store.saveGone(); } };

  // ---- data blocks: memory, this browser's OPFS, the server ----
  let cache = null;
  if (keepData && navigator.storage?.getDirectory) {
    try { cache = await openDataCache({ files: dataFiles, fresh: freshCache, note, fault, maxOpen: cacheOpen }); }
    catch (x) { note(`[data] OPFS unavailable for the game data (${x?.message ?? x}): it comes from the server only`); }
  } else note(`[data] the game data comes from the server only (${keepData ? 'no OPFS in this browser' : 'not kept: nocache'})`);
  const cap = () => budget || (cache?.keeping ? 64 << 20 : 256 << 20);     // the larger budget once OPFS keeps no more
  const blocks = new Map(), inflight = new Map();
  let held = 0, fetched = 0;
  const fetchedBy = new Map();              // path -> blocks from the server, for the note at the end
  async function fetchBlock(n, bi) {
    const what = `${n.path} block ${bi}`, t0 = performance.now();
    const slow = setTimeout(() => note(`[data] ${what}: waiting for the server for ${SLOW_MS / 1000} s`), SLOW_MS);
    let got = null, waits = 0;
    try { await fetchRun({ f: n, first: bi, n: 1, onBlock: (_, b) => { got = b; }, onWait: () => waits++, note, fault }); }
    catch (x) { note(`[data] ${what}: ${x?.message ?? x}; the read fails${x instanceof Gone ? ': reload the page' : ''}`); throw fail(E.IO); }
    finally { clearTimeout(slow); }
    const secs = (performance.now() - t0) / 1000;
    if (waits || secs >= SLOW_MS / 1000) note(`[data] ${what}: in after ${secs.toFixed(1)} s${waits ? `, ${waits + 1} tries` : ''}`);
    return got;
  }
  function memPut(key, b) {
    blocks.set(key, b); held += b.length;
    for (const [k, v] of blocks) { if (held <= cap()) break; blocks.delete(k); held -= v.length; }
  }
  async function block(n, bi) {
    const key = n.path + '#' + bi;
    const hit = blocks.get(key);
    if (hit) { blocks.delete(key); blocks.set(key, hit); return hit; }
    let p = inflight.get(key);
    if (p) return p;
    p = (async () => {
      let b = cache && await cache.read(n, bi);
      if (!b) {
        b = await fetchBlock(n, bi);
        fetched++; fetchedBy.set(n.path, (fetchedBy.get(n.path) ?? 0) + 1);
        if (cache) await cache.keep(n, bi, b);
      }
      memPut(key, b);
      return b;
    })();
    inflight.set(key, p);
    try { return await p; } finally { inflight.delete(key); }
  }
  async function readData(n, pos, dst) {
    const end = Math.min(n.size, pos + dst.length);
    if (end <= pos) return 0;
    const last = Math.floor((end - 1) / BLOCK);
    for (let first = Math.floor(pos / BLOCK); first <= last; first += WINDOW) {
      const upto = Math.min(last, first + WINDOW - 1);
      const bs = await Promise.all(Array.from({ length: upto - first + 1 }, (_, i) => block(n, first + i)));
      for (let bi = first; bi <= upto; bi++) {
        const b = bs[bi - first], from = Math.max(pos, bi * BLOCK), to = Math.min(end, bi * BLOCK + b.length);
        dst.set(b.subarray(from - bi * BLOCK, to - bi * BLOCK), from - pos);
      }
    }
    return end - pos;
  }
  async function copyIn(rel, n) {   // a data file into the overlay, to be written: an open io on it
    const b = new Uint8Array(n.size);
    await readData(n, 0, b);
    const io = await store.open(rel);
    io.truncate(0); io.write(0, b);
    if (gone.delete(rel)) await store.saveGone();
    note(`[save] ${rel}: copied to be written`);
    return io;
  }

  return {
    mounts: [mount],
    stats: () => ({ blocks: blocks.size, held, fetched, written: files.size, store: store.kind, data: cache ? 'opfs' : 'server', ...(cache?.stats() ?? {}) }),
    async shutdown() {                    // what the cache has kept made to last, its handles closed; what came from the server told
      const by = [...fetchedBy].sort((a, b) => b[1] - a[1]);
      note(`[data] from the server this time: ${fetched} blocks${by.length ? `: ${by.slice(0, 10).map(([p, k]) => `${p} ${k}`).join(', ')}${by.length > 10 ? `, ${by.length - 10} more files` : ''}` : ''}`);
      await cache?.close();
    },
    stat(m, rel) {
      const e = entry(rel);
      if (!e) return null;
      if (e.ov) return { dir: false, size: e.ov.size, mtimeNs: e.ov.mtime * 1e6 };
      if (e.dir) return { dir: true, size: 0, mtimeNs: (e.node?.mtime ?? 0) * 1e6 };
      return { dir: false, size: e.node.size, mtimeNs: e.node.mtime * 1e6 };
    },
    list(m, rel) {
      const e = entry(rel);
      if (!e?.dir) throw fail(E.NOTDIR);
      const out = new Map();
      for (const [name, k] of e.node?.kids ?? []) { const p = rel ? rel + '/' + name : name; if (!gone.has(p)) out.set(name, k.dir); }
      for (const p of files.keys()) if (parentOf(p) === rel) out.set(nameOf(p), false);
      for (const p of dirs) if (parentOf(p) === rel) out.set(nameOf(p), true);
      return [...out].map(([name, dir]) => ({ name, dir }));
    },
    async open(m, rel, o) {
      const e = entry(rel);
      if (e?.dir) throw fail(E.ISDIR);
      if (!o.write && !o.create && !o.trunc) {
        if (!e) throw fail(E.NOENT);
        return e.ov ? { rel, io: await store.open(rel) } : { node: e.node };
      }
      let io;
      if (files.has(rel)) io = await store.open(rel);
      else if (e?.node && !o.trunc) io = await copyIn(rel, e.node);
      else {
        io = await store.open(rel);
        if (gone.delete(rel)) await store.saveGone();
        note(`[save] ${rel}: new`);
      }
      if (o.trunc) io.truncate(0);
      return { rel, io };
    },
    read: (h, pos, dst) => (h.node ? readData(h.node, pos, dst) : h.io.read(pos, dst)),
    write(h, pos, src) { if (!h.io) throw fail(E.BADF); return h.io.write(pos, src); },
    size: (h) => (h.node ? h.node.size : h.io.size()),
    truncate(h, n) { if (!h.io) throw fail(E.BADF); h.io.truncate(n); },
    sync(h) { h.io?.flush(); },
    close(h) { h.io?.close(); },
    times() {},                        // the store keeps when each file was last written
    async mkdir(m, rel) { if (entry(rel)) throw fail(E.EXIST); if (!entry(parentOf(rel))?.dir) throw fail(E.NOENT); await store.mkdir(rel); },
    async rmdir(m, rel) {
      const e = entry(rel); if (!e) throw fail(E.NOENT); if (!e.dir) throw fail(E.NOTDIR);
      if (this.list(m, rel).length) throw fail(E.NOTEMPTY);
      if (dirs.has(rel)) await store.rmdir(rel);
      if (e.node) await hide(rel);
    },
    async unlink(m, rel) {
      const e = entry(rel); if (!e) throw fail(E.NOENT); if (e.dir) throw fail(E.ISDIR);
      if (files.has(rel)) await store.remove(rel);
      await hide(rel);
    },
    async rename(m, rel, m2, rel2) {
      const e = entry(rel); if (!e) throw fail(E.NOENT); if (e.dir) throw fail(E.NOTSUP);
      if (!files.has(rel)) (await copyIn(rel, e.node)).close();
      if (files.has(rel2)) await store.remove(rel2);
      await store.move(rel, rel2);
      await hide(rel);
      if (gone.delete(rel2)) await store.saveGone();
    },
  };
}
