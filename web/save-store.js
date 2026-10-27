// Where the game's writes are kept (its INI, saves, logs): the overlay of
// http-backend.js, in the browser's own file system for this site (OPFS) so
// that they outlive the page, or in memory where there is none.
//
// OPFS: a folder per save set (?save=, default "ra2yr") under the site's
// private file system, a file there for every file the game wrote, at the
// game folder's path; "_gone.json" lists the data files the game deleted. The
// browser keeps it in its profile (tools/play.sh: in work/),
// apart for every site (scheme, host and port: http://127.0.0.1:8780 is one).
// A file is read and written through a synchronous access handle (a worker's
// way to do file I/O at offsets), one per file however often it is open.
//
// The store: files (rel -> { size, mtime }), dirs, gone (Sets of rel), and
//   open(rel) -> { read(pos, dst), write(pos, src), size(), truncate(n), flush(), close() }   (made empty if new)
//   remove(rel), move(rel, rel2), mkdir(rel), rmdir(rel), saveGone(), kind ('opfs' | 'memory')
const GONE = '_gone.json';
const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const nameOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);

export async function saveStore({ name = 'ra2yr', fresh = false, note = () => {} } = {}) {
  if (/^data-cache/.test(name)) throw new Error(`a save set may not be called ${name}: the game data's cache is (data-cache.js)`);
  if (!navigator.storage?.getDirectory) { note('[save] no OPFS in this browser: the game\'s writes last as long as the page'); return memoryStore(); }
  try { return await opfsStore(name, fresh, note); }
  catch (x) { note(`[save] OPFS unavailable (${x}): the game's writes last as long as the page`); return memoryStore(); }
}

async function opfsStore(name, fresh, note) {
  const root = await navigator.storage.getDirectory();
  if (fresh) await root.removeEntry(name, { recursive: true }).catch(() => {});
  const top = await root.getDirectoryHandle(name, { create: true });
  const files = new Map(), dirs = new Set(), gone = new Set();
  async function walk(dir, rel) {
    for await (const [n, h] of dir.entries()) {
      if (!rel && n === GONE) continue;
      const p = rel ? rel + '/' + n : n;
      if (h.kind === 'directory') { dirs.add(p); await walk(h, p); }
      else { const f = await h.getFile(); files.set(p, { size: f.size, mtime: f.lastModified }); }
    }
  }
  await walk(top, '');
  try { for (const p of JSON.parse(await (await (await top.getFileHandle(GONE)).getFile()).text())) gone.add(p); } catch {}
  const kept = [...files].map(([p, f]) => `${p} (${f.size} bytes)`);
  note(`[save] OPFS "${name}"${fresh ? ' (fresh)' : ''}: ${kept.length ? `${kept.length} files kept from before: ${kept.slice(0, 8).join(', ')}${kept.length > 8 ? ', ...' : ''}` : 'empty'}${gone.size ? `; ${gone.size} data files deleted` : ''}`);

  const dirOf = async (rel, create) => { let d = top; for (const part of rel ? rel.split('/') : []) d = await d.getDirectoryHandle(part, { create }); return d; };
  const handles = new Map();          // rel -> { sah, refs }
  async function open(rel) {
    let o = handles.get(rel);
    if (!o) {
      const fh = await (await dirOf(parentOf(rel), true)).getFileHandle(nameOf(rel), { create: true });
      o = { sah: await fh.createSyncAccessHandle(), refs: 0 };
      handles.set(rel, o);
      if (!files.has(rel)) files.set(rel, { size: o.sah.getSize(), mtime: Date.now() });
    }
    o.refs++;
    const meta = files.get(rel), sah = o.sah;
    let closed = false;
    return {
      read(pos, dst) {                // through a copy: a view of shared memory is not every browser's to take
        const b = new Uint8Array(dst.length), k = sah.read(b, { at: pos });
        dst.set(b.subarray(0, k));
        return k;
      },
      write(pos, src) {
        const k = sah.write(src.slice(), { at: pos });
        meta.size = Math.max(meta.size, pos + k); meta.mtime = Date.now();
        return k;
      },
      size: () => sah.getSize(),
      truncate(n) { sah.truncate(n); meta.size = n; meta.mtime = Date.now(); },
      flush: () => sah.flush(),
      close() {
        if (closed) return;
        closed = true;
        if (--o.refs === 0) { sah.flush(); sah.close(); handles.delete(rel); }
      },
    };
  }
  const shut = (rel) => { const o = handles.get(rel); if (o) { o.sah.flush(); o.sah.close(); handles.delete(rel); } };
  async function saveGone() {
    const h = await top.getFileHandle(GONE, { create: true }), w = await h.createWritable();
    await w.write(JSON.stringify([...gone])); await w.close();
  }
  return {
    kind: 'opfs', files, dirs, gone, open, saveGone,
    async remove(rel) { shut(rel); await (await dirOf(parentOf(rel), false)).removeEntry(nameOf(rel)); files.delete(rel); },
    async move(rel, rel2) {
      shut(rel);
      const fh = await (await dirOf(parentOf(rel), false)).getFileHandle(nameOf(rel));
      await fh.move(await dirOf(parentOf(rel2), true), nameOf(rel2));
      files.set(rel2, files.get(rel)); files.delete(rel);
    },
    async mkdir(rel) { await dirOf(rel, true); dirs.add(rel); },
    async rmdir(rel) { await (await dirOf(parentOf(rel), false)).removeEntry(nameOf(rel)); dirs.delete(rel); },
  };
}

function memoryStore() {
  const files = new Map(), dirs = new Set(), gone = new Set(), bytes = new Map();
  function open(rel) {
    if (!files.has(rel)) { files.set(rel, { size: 0, mtime: Date.now() }); bytes.set(rel, new Uint8Array(4096)); }
    const meta = files.get(rel);
    const grow = (need) => { const b = bytes.get(rel); if (need <= b.length) return; const n = new Uint8Array(Math.max(need, b.length * 2)); n.set(b.subarray(0, meta.size)); bytes.set(rel, n); };
    return {
      read(pos, dst) { const k = Math.max(0, Math.min(dst.length, meta.size - pos)); dst.set(bytes.get(rel).subarray(pos, pos + k)); return k; },
      write(pos, src) {
        grow(pos + src.length);
        const b = bytes.get(rel);
        if (pos > meta.size) b.fill(0, meta.size, pos);
        b.set(src, pos); meta.size = Math.max(meta.size, pos + src.length); meta.mtime = Date.now();
        return src.length;
      },
      size: () => meta.size,
      truncate(n) { grow(n); if (n > meta.size) bytes.get(rel).fill(0, meta.size, n); meta.size = n; meta.mtime = Date.now(); },
      flush() {},
      close() {},
    };
  }
  return {
    kind: 'memory', files, dirs, gone, open, saveGone() {},
    remove(rel) { files.delete(rel); bytes.delete(rel); },
    move(rel, rel2) { files.set(rel2, files.get(rel)); bytes.set(rel2, bytes.get(rel)); files.delete(rel); bytes.delete(rel); },
    mkdir(rel) { dirs.add(rel); },
    rmdir(rel) { dirs.delete(rel); },
  };
}
