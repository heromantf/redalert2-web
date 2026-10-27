// The game data kept in this site's OPFS: a block the game has read once comes
// from this browser's disk from then on, not from the server (http-backend.js
// asks here first and hands every block it fetches here). After nfsu2-web's
// web/src/host/datacache.ts (MIT; see ../NOTICE.md), but packed.
//
// OPFS "data-cache-v1/" holds, for each file of the game data with a block kept:
//   KEY       its blocks, each in a 1 MiB slot, in the order they came
//   KEY.idx   a little-endian uint32 for each 1 MiB block of the file: 0 not
//             kept, s + 1 kept in slot s
// KEY is the file's path (escaped), size and mtime: a file changed on the
// server is a new name, and what the server no longer has is deleted at the
// start. Packed, not each block at its own offset, since a sparse file counts
// against the site's quota at its whole length and a file system without holes
// would write its zeros (spike/opfs/RESULT.md).
//
// One writer: the I/O worker holding the Web Lock "ra2web-data-cache" (another
// tab of the site reads from the server meanwhile). A block's bytes reach the
// disk (flush) before its index entry is written, a few blocks at a time (a
// flush costs about 7 ms): an entry names only bytes that are there. A slot is
// taken past every slot the index names, so nothing named is written over; a
// slot written whose entry never was (the page went first) is free again at the
// next start. A file whose index does not fit it is emptied. No room left (the
// disk, the site's quota) ends the keeping for this page, not the read.
export const BLOCK = 1 << 20;
export const CACHE_DIR = 'data-cache-v1';
const LOCK = 'ra2web-data-cache';
// Cache files open at once (maxOpen; two handles each), past which the least recently used is closed.
// More than the game data's files (604): none is closed in a game or a download ahead (which counts
// on it, predownload-worker.js). Chrome (155) now and then left a
// handle asked for unanswered while others were being closed (spike/opfs-handles); a game opens about
// 27 (a campaign, skirmishes, the movies: 26-27, none closed). WebKit's 251 handles a page, for which
// this was 64, no longer weighed: the web build is judged by Chrome (the user, 2026-10-27).
const MAX_OPEN = 1024;
const COMMIT_BLOCKS = 32, COMMIT_MS = 1000, HANDLE_MS = 15000;

export const blockCount = (size) => Math.ceil(size / BLOCK);
export const blockLen = (size, bi) => Math.min(BLOCK, size - bi * BLOCK);
const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
function hash(s) {                         // FNV-1a, twice over: a short name for a long path
  let a = 0x811c9dc5, b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) { a = Math.imul(a ^ s.charCodeAt(i), 0x01000193); b = Math.imul(b ^ s.charCodeAt(i), 0x5bd1e995); }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
export function keyOf(f) {
  let k = encodeURIComponent(f.path);
  if (k.length > 160) k = k.slice(0, 120) + '-' + hash(f.path);
  return `${k}~${f.size}~${f.mtime}`;
}

// A cache file's index (its bytes) checked against its blocks' file (its size): { idx, next (the
// first free slot) }, or null when it does not fit them (an entry past the file, a slot named twice).
function checkIndex(f, raw, size) {
  const nb = blockCount(f.size);
  if (raw.length !== nb * 4) return null;
  const v = new DataView(raw.buffer, raw.byteOffset, raw.length), idx = new Uint32Array(nb), used = new Set();
  let next = 0;
  for (let bi = 0; bi < nb; bi++) {
    const e = v.getUint32(bi * 4, true);
    if (!e) continue;
    const s = e - 1;
    if (s >= nb || used.has(s) || s * BLOCK + blockLen(f.size, bi) > size) return null;
    used.add(s); idx[bi] = e; next = Math.max(next, s + 1);
  }
  return { idx, next };
}

// The lock for as long as this worker lives (or release()): its release, or null when another holds it.
function lock() {
  if (!navigator.locks) return Promise.resolve(() => {});
  return new Promise((res, rej) => {
    navigator.locks.request(LOCK, { ifAvailable: true }, (l) => {
      if (!l) { res(null); return undefined; }
      return new Promise((release) => res(release));
    }).catch(rej);
  });
}

// files: the game data's files, [{ path, size, mtime }]; fresh: the cache emptied first;
// fault: { full: N } the Nth block kept fails as a full disk would; maxOpen (tests: fewer, to close and open again).
// -> null where another tab has the cache, else
//    { read(f, bi) -> bytes | null, keep(f, bi, bytes), missing(f) -> [bi] | null, commit(), close(), stats(), keeping }
//    (read, keep, missing, close: promises)
export async function openDataCache({ files, fresh = false, note = () => {}, fault = {}, maxOpen = MAX_OPEN }) {
  const release = await lock();
  if (!release) { note('[data] another tab of this site keeps the game data: this one reads it from the server only'); return null; }
  let dir;
  const want = new Map(), present = new Set();       // key -> file, of the files served now; keys with an index
  let total = 0, keptBefore = 0;
  try {
    const root = await navigator.storage.getDirectory();
    if (fresh) await root.removeEntry(CACHE_DIR, { recursive: true }).catch(() => {});
    dir = await root.getDirectoryHandle(CACHE_DIR, { create: true });
    keptBefore = await scan(dir);
  } catch (x) { release(); throw x; }

  // What is there: the cache files of the files served now stay, the rest go. -> the bytes kept
  async function scan(dir) {
    for (const f of files) if (f.size > 0) { want.set(keyOf(f), f); total += f.size; }
    const names = [];
    for await (const [name, h] of dir.entries()) names.push([name, h]);
    let gone = 0, goneBytes = 0;
    for (const [name, h] of names) {
      const key = name.endsWith('.idx') ? name.slice(0, -4) : name;
      if (h.kind === 'file' && want.has(key)) { if (key !== name) present.add(key); continue; }
      try {
        if (h.kind === 'file') goneBytes += (await h.getFile()).size;
        await dir.removeEntry(name, { recursive: true });
        gone++;
      } catch (x) { note(`[data] ${CACHE_DIR}/${name}: not deleted (${x?.message ?? x})`); }
    }
    let kept = 0, filesBefore = 0;
    for (const key of present) {
      const f = want.get(key);
      try {
        const v = new DataView(await (await (await dir.getFileHandle(key + '.idx')).getFile()).arrayBuffer());
        if (v.byteLength !== blockCount(f.size) * 4) continue;
        let any = false;
        for (let bi = 0; bi < v.byteLength / 4; bi++) if (v.getUint32(bi * 4, true)) { kept += blockLen(f.size, bi); any = true; }
        if (any) filesBefore++;
      } catch { /* read at its opening */ }
    }
    note(`[data] this browser keeps ${mb(kept)} of the game data's ${mb(total)} (${filesBefore} of ${want.size} files)` +
         `${fresh ? ', emptied first' : ''}${gone ? `; ${gone} cache files of data no longer served deleted (${mb(goneBytes)})` : ''}`);
    return kept;
  }

  const open = new Map();                  // key -> Promise<cf | null>, the least recently used first
  const closing = new Map();               // key -> Promise: its handles being closed
  const dirty = new Set();                 // cfs with blocks whose entries are still to be written
  let keeping = true, closed = false, pending = 0, timer = 0, tries = 0;
  const st = { local: 0, kept: 0, keptBytes: 0, closed: 0 };

  // A cache file: { f, key, h (its blocks), ih (its index), idx, next (the first free slot), pending: [bi] }.
  const opening = new Map();               // key -> where its opening stands (stats: what a stalled download waits for)
  // An access handle, asked for again once if none comes in HANDLE_MS (one that comes later is
  // closed), else an error: a file the browser keeps us waiting on is not kept, rather than the
  // read or the download waiting on it. Chrome (155) has left one unanswered, now and then, while
  // other files' handles were being closed (data-cache's turnover; missing() below).
  async function handle(name, what) {
    for (let k = 1; ; k++) {
      const p = (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
      let t = 0, late = false;
      try {
        return await Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => { late = true; rej(new Error(`${what}: no access handle in ${HANDLE_MS / 1000} s`)); }, HANDLE_MS); })]);
      } catch (x) {
        if (!late || k >= 2) throw x;
        note(`[data] ${name}: ${what}: no access handle in ${HANDLE_MS / 1000} s; asked for again`);
      } finally {
        clearTimeout(t);
        if (late) p.then((h) => { note(`[data] ${name}: the access handle asked for first came after all (closed)`); h.close(); }, () => {});
      }
    }
  }
  async function openFile(f, key) {
    opening.set(key, `${f.path}: waiting for its last closing (${closing.has(key) ? 'pending' : 'none'})`);
    await closing.get(key);
    const nb = blockCount(f.size);
    opening.set(key, `${f.path}: its blocks' access handle`);
    let h, ih;
    try { h = await handle(key, 'its blocks'); }
    catch (x) { opening.delete(key); throw x; }
    opening.set(key, `${f.path}: its index's access handle`);
    try { ih = await handle(key + '.idx', 'its index'); }
    catch (x) { h.close(); opening.delete(key); throw x; }
    opening.delete(key);
    try {
      const raw = new Uint8Array(nb * 4);
      let got = ih.getSize() === raw.length && ih.read(raw, { at: 0 }) === raw.length ? checkIndex(f, raw, h.getSize()) : null;
      if (!got) {
        if (present.has(key)) note(`[data] ${f.path}: its cache file does not fit its index; emptied`);
        got = { idx: new Uint32Array(nb), next: 0 };
        h.truncate(0); ih.truncate(0); ih.write(new Uint8Array(nb * 4), { at: 0 });   // no flush: an empty index lost is as good
      }
      present.add(key);
      return { f, key, h, ih, idx: got.idx, next: got.next, pending: [] };
    } catch (x) { h.close(); ih.close(); throw x; }
  }
  // Used at once, in the same task: a file is closed when it is no longer among the MAX_OPEN newest.
  function cacheFile(f, create) {
    const key = keyOf(f);
    let p = open.get(key);
    if (p) { open.delete(key); open.set(key, p); return p; }
    if (!create && !present.has(key)) return null;
    p = openFile(f, key).catch((x) => {
      if (x?.name === 'QuotaExceededError') stop(f, -1, x);
      else note(`[data] ${f.path}: not kept in this browser (${x?.message ?? x})`);
      return null;
    });
    open.set(key, p);
    for (const [k, op] of open) {
      if (open.size <= maxOpen) break;
      open.delete(k);
      // after the readers already waiting for it, which use it first
      const c = op.then((cf) => cf && shut(cf)).catch(() => {}).finally(() => { if (closing.get(k) === c) closing.delete(k); });
      closing.set(k, c);
    }
    return p;
  }
  function commitFile(cf) {
    if (!cf.pending.length) return;
    const b = new Uint8Array(4), v = new DataView(b.buffer);
    try {
      cf.h.flush();
      for (const bi of cf.pending) { v.setUint32(0, cf.idx[bi], true); cf.ih.write(b, { at: bi * 4 }); }
    } catch (x) { note(`[data] ${cf.f.path}: its blocks' index entries not written (${x?.message ?? x})`); }
    pending -= cf.pending.length; cf.pending = []; dirty.delete(cf);
  }
  function commit() {
    clearTimeout(timer); timer = 0;
    for (const cf of [...dirty]) commitFile(cf);
  }
  function shut(cf) {
    commitFile(cf);
    try { cf.ih.flush(); } catch { /* closing anyway */ }
    cf.h.close(); cf.ih.close();
    st.closed++;
  }
  function stop(f, bi, x) {
    if (!keeping) return;
    keeping = false;
    note(`[data] no room in this browser to keep more of the game data (${f.path}${bi >= 0 ? ` block ${bi}` : ''}: ${x?.message ?? x}); the rest comes from the server`);
    commit();
  }

  return {
    async read(f, bi) {
      if (closed || !f.size) return null;
      const p = cacheFile(f, false), cf = p && await p, e = cf?.idx[bi];
      if (!e) return null;
      const len = blockLen(f.size, bi), b = new Uint8Array(len);
      try {
        const k = cf.h.read(b, { at: (e - 1) * BLOCK });
        if (k !== len) throw new Error(`${k} of ${len} bytes`);
      } catch (x) {
        note(`[data] ${f.path} block ${bi}: this browser's copy did not read (${x?.message ?? x}); from the server`);
        cf.idx[bi] = 0;
        return null;
      }
      st.local++;
      return b;
    },
    async keep(f, bi, b) {                 // -> whether the block is kept now
      if (closed || !keeping || !f.size) return false;
      const cf = await cacheFile(f, true);
      if (!cf || closed || !keeping) return false;
      if (cf.idx[bi]) return true;
      const s = cf.next;
      try {
        if (fault.full && ++tries >= fault.full) throw new DOMException('No space available for this operation (a test\'s fault)', 'QuotaExceededError');
        const k = cf.h.write(b, { at: s * BLOCK });
        if (k !== b.length) throw new Error(`${k} of ${b.length} bytes written`);
      } catch (x) { stop(f, bi, x); return false; }
      cf.next = s + 1; cf.idx[bi] = s + 1; cf.pending.push(bi); dirty.add(cf); pending++;
      st.kept++; st.keptBytes += b.length;
      if (pending >= COMMIT_BLOCKS) commit();
      else if (!timer) timer = setTimeout(commit, COMMIT_MS);
      return true;
    },
    // The blocks of f not kept (null: none can be kept now), from its index as its opening would read
    // it, without opening it. The download ahead asks this of every file first; it opened them all
    // then, 64 at a time, to open them again as their blocks came, and Chrome (155), under that load,
    // left a file's handles asked for again unanswered: 7 downloads in 16 stopped at their last
    // files. None did with each file opened once: all 323 kept open (8 in 8), or none opened before
    // its blocks come, as now (12 in 12, and under a game alongside). Not seen in a plain loop of
    // closing and opening again, even four at once (spike/opfs-handles).
    async missing(f) {
      if (closed || !f.size) return [];
      if (!keeping) return null;
      const key = keyOf(f), p = open.get(key), cf = p && await p;
      let idx = cf?.idx;
      if (!idx && present.has(key)) {
        try {
          const raw = new Uint8Array(await (await (await dir.getFileHandle(key + '.idx')).getFile()).arrayBuffer());
          idx = checkIndex(f, raw, (await (await dir.getFileHandle(key)).getFile()).size)?.idx;
        } catch { /* as if none: its opening will tell */ }
      }
      const out = [];
      for (let bi = 0; bi < blockCount(f.size); bi++) if (!idx?.[bi]) out.push(bi);
      return out;
    },
    commit,
    async close() {
      if (closed) return;
      closed = true;
      commit();
      const cfs = await Promise.all(open.values());
      open.clear();
      for (const cf of cfs) if (cf) shut(cf);
      await Promise.all(closing.values());
      release();
    },
    stats: () => ({ ...st, keeping, open: open.size, closing: closing.size, opening: [...opening.values()], before: keptBefore, total }),
    get keeping() { return keeping; },
  };
}

// What the cache keeps of these files, read past its lock (the File API, any
// thread, while a worker writes it: what it has not named in an index yet is
// not counted): { have (bytes), by (path -> bytes) }.
export async function scanKept(files) {
  const by = new Map();
  let have = 0, dir;
  try { dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(CACHE_DIR); } catch { return { have, by }; }
  const names = new Set();
  for await (const name of dir.keys()) names.add(name);
  for (const f of files) {
    const k = keyOf(f) + '.idx';
    if (!f.size || !names.has(k)) continue;
    try {
      const v = new DataView(await (await (await dir.getFileHandle(k)).getFile()).arrayBuffer());
      if (v.byteLength !== blockCount(f.size) * 4) continue;
      let b = 0;
      for (let bi = 0; bi < v.byteLength / 4; bi++) if (v.getUint32(bi * 4, true)) b += blockLen(f.size, bi);
      if (b) { by.set(f.path, b); have += b; }
    } catch { /* gone meanwhile */ }
  }
  return { have, by };
}
// Whether a worker (a game, a download, in this tab or another) holds the cache.
export async function cacheBusy() {
  const q = await navigator.locks?.query?.();
  return !!q?.held?.some((l) => l.name === LOCK);
}
// The cache emptied, when no one holds it: true, or false (busy).
export async function deleteCache() {
  const release = await lock();
  if (!release) return false;
  try {
    await (await navigator.storage.getDirectory()).removeEntry(CACHE_DIR, { recursive: true }).catch((x) => { if (x?.name !== 'NotFoundError') throw x; });
    return true;
  } finally { release(); }
}
