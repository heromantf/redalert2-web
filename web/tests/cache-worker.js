// The game data's OPFS cache, tried out (web/tests/cache.html runs it, a pass
// a page load), each read compared with the server's own bytes:
//   pass 1  a fresh cache: a file under a block, reads across blocks and over
//           four, a file's short last block, a file of a few blocks; each
//           block from the server once and kept, with 2 cache files open at
//           most (so closed and opened again). Again with no memory to keep
//           blocks in: all from OPFS. While it holds the cache, another tab
//           (role 'other') reads from the server only. Left behind: a cache
//           file of data no longer served, and a broken index.
//   pass 2  the same reads from OPFS, but the file with the broken index (its
//           cache emptied, from the server again); the stale file deleted;
//           every block the cache names, read past its code (the File API),
//           the server's bytes.
//   pass 3  a fresh cache whose 3rd block finds no room, and a server that
//           loses every 4th request: the same bytes, 2 blocks kept and read
//           back, the lost requests made again. The test's save sets go.
//   verify  (role) only every block the cache names against the server's,
//           whatever filled it (a game run on this site): cache.html?verify
// -> { fails, lines, notes }
import { httpBackend } from '../http-backend.js';
import { BLOCK, CACHE_DIR, keyOf } from '../data-cache.js';

let go = null;
onmessage = async (e) => {
  if (e.data.t === 'go') { go?.(); return; }
  const { pass, role } = e.data, lines = [], notes = [];
  let fails = 0;
  const ok = (what, c) => { lines.push(`${c ? 'ok  ' : 'FAIL'} ${what}`); if (!c) fails++; };
  const note = (s) => notes.push(s);
  try {
    const man = (await (await fetch('/data/manifest.json', { cache: 'no-store' })).json()).files.filter((f) => !f.d)
      .sort((a, b) => (a.p < b.p ? -1 : 1));
    const pick = (fn, what) => { const f = man.find(fn); if (!f) throw new Error(`no data file ${what}`); return f; };
    const small = pick((f) => f.s > 0 && f.s < 65536, 'under 64 KB');
    const big = pick((f) => f.s > 9 * BLOCK && f.s % BLOCK, 'over 9 MiB, its last block short');
    const broken = pick((f) => f.s > BLOCK && f.s < 4 * BLOCK, 'of 1 to 4 MiB');
    const reads = [                       // [file, pos, len]
      [small, 0, small.s],
      [big, BLOCK - 100, 200],            // across a block's end
      [big, 5 * BLOCK + 7, 3 * BLOCK],    // over four blocks
      [big, big.s - 1000, 5000],          // the short last block, and past the file's end
      [broken, 0, broken.s],
    ];
    const blocks = new Set(), brokenBlocks = Math.ceil(broken.s / BLOCK);
    for (const [f, pos, len] of reads)
      for (let bi = Math.floor(pos / BLOCK); bi <= Math.floor((Math.min(f.s, pos + len) - 1) / BLOCK); bi++) blocks.add(`${f.p}#${bi}`);
    const want = blocks.size;
    const url = (f) => '/data/' + f.p.split('/').map(encodeURIComponent).join('/');
    const server = async (f, pos, len) => {
      const r = await fetch(url(f), { headers: { Range: `bytes=${pos}-${Math.min(f.s, pos + len) - 1}` }, cache: 'no-store' });
      return new Uint8Array(await r.arrayBuffer());
    };
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    async function readAll(b, label) {
      let good = 0;
      for (const [f, pos, len] of reads) {
        const h = await b.open(0, f.p, { read: true }), d = new Uint8Array(len);
        const k = await b.read(h, pos, d);
        await b.close(h);
        const w = await server(f, pos, len);
        if (k === w.length && same(d.subarray(0, k), w)) good++;
        else lines.push(`     ${label}: ${f.p} at ${pos}: ${k} bytes, the server's ${w.length}, ${same(d.subarray(0, Math.min(k, w.length)), w.subarray(0, Math.min(k, w.length))) ? 'alike as far as both go' : 'different'}`);
      }
      return good === reads.length;
    }
    const files = `${small.p} (${small.s} bytes), ${big.p} (${big.s}), ${broken.p} (${broken.s})`;
    // every block the cache names, read without its code (the File API): { named, bad, nfiles }
    async function verify() {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(CACHE_DIR);
      let named = 0, bad = 0, nfiles = 0;
      for (const f of man) {
        const key = keyOf({ path: f.p, size: f.s, mtime: f.m });
        let idx, data;
        try { idx = new DataView(await (await (await dir.getFileHandle(key + '.idx')).getFile()).arrayBuffer()); data = await (await dir.getFileHandle(key)).getFile(); }
        catch { continue; }
        nfiles++;
        for (let bi = 0; bi < idx.byteLength / 4; bi++) {
          const e = idx.getUint32(bi * 4, true);
          if (!e) continue;
          named++;
          const len = Math.min(BLOCK, f.s - bi * BLOCK);
          const mine = new Uint8Array(await data.slice((e - 1) * BLOCK, (e - 1) * BLOCK + len).arrayBuffer());
          if (!same(mine, await server(f, bi * BLOCK, len))) { bad++; lines.push(`     ${f.p} block ${bi} (slot ${e - 1}): not the server's`); }
        }
      }
      return { named, bad, nfiles };
    }

    if (role === 'verify') {
      const v = await verify();
      ok(`every block the cache names is the server's (${v.named} blocks of ${v.nfiles} files)`, v.bad === 0 && v.named > 0);
    } else if (role === 'other') {
      const b = await httpBackend({ save: 'cache-test-other', fresh: true, note });
      ok('another tab meanwhile: it reads from the server only', b.stats().data === 'server' && notes.some((n) => n.includes('another tab')));
      ok('another tab meanwhile: the same bytes', await readAll(b, 'other'));
      await b.shutdown();
    } else if (pass === 1) {
      lines.push(`     the files: ${files}; ${want} blocks in the reads`);
      const b = await httpBackend({ save: 'cache-test', fresh: true, freshCache: true, budget: 1, cacheOpen: 2, note });
      ok('the game data is kept in OPFS', b.stats().data === 'opfs');
      ok('a fresh cache: every read the server\'s bytes', await readAll(b, 'first'));
      let s = b.stats();
      ok(`a fresh cache: ${want} blocks from the server, each once, each kept, none from OPFS`, s.fetched === want && s.kept === want && s.local === 0);
      ok('again, no memory to keep blocks in: the same bytes', await readAll(b, 'again'));
      s = b.stats();
      ok(`again: all ${want} from OPFS, none more from the server`, s.fetched === want && s.local === want);
      ok(`2 cache files open at most: closed and opened again (${s.closed} times)`, s.closed >= 2 && s.open <= 2);
      postMessage({ t: 'holding' });
      await new Promise((res) => { go = res; });
      await b.shutdown();
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(CACHE_DIR);
      for (const n of ['gone.mix~10~1', 'gone.mix~10~1.idx']) {
        const w = await (await dir.getFileHandle(n, { create: true })).createWritable();
        await w.write(new Uint8Array(10)); await w.close();
      }
      const w = await (await dir.getFileHandle(keyOf({ path: broken.p, size: broken.s, mtime: broken.m }) + '.idx')).createWritable({ keepExistingData: true });
      await w.truncate(3); await w.close();
      lines.push('     left behind: a cache file of data no longer served, and a broken index');
    } else if (pass === 2) {
      const b = await httpBackend({ save: 'cache-test', note });
      ok('a reload: the stale cache file deleted', notes.some((n) => /2 cache files of data no longer served deleted/.test(n)));
      ok('a reload: the same bytes', await readAll(b, 'reload'));
      const s = b.stats();
      ok(`a reload: all from OPFS but the broken file's ${brokenBlocks} blocks`, s.fetched === brokenBlocks && s.local === want - brokenBlocks);
      ok('a reload: the broken index noticed, its file emptied', notes.some((n) => n.includes(broken.p) && n.includes('does not fit its index')));
      ok('a reload: what it keeps told at the start', notes.some((n) => n.startsWith('[data] this browser keeps')));
      await b.shutdown();
      const v = await verify();
      ok(`every block the cache names is the server's (${v.named} blocks of ${v.nfiles} files)`, v.bad === 0 && v.named === want);
    } else if (pass === 3) {
      const b = await httpBackend({ save: 'cache-test', freshCache: true, budget: 1, fault: { full: 3, fail: 4 }, note });
      ok('a full disk, a lossy server: the same bytes', await readAll(b, 'faults'));
      let s = b.stats();
      ok('a full disk: 2 blocks kept, then no more, told', s.kept === 2 && !s.keeping && notes.some((n) => n.includes('no room in this browser')));
      ok('a lossy server: the lost requests made again', notes.some((n) => n.includes('lost connection') && n.includes('again in')));
      ok('again: the same bytes', await readAll(b, 'faults, again'));
      s = b.stats();
      ok('again: the 2 kept from OPFS, the rest from the server', s.local === 2 && s.fetched === 2 * want - 2);
      await b.shutdown();
      const root = await navigator.storage.getDirectory();
      for (const n of ['cache-test', 'cache-test-other']) await root.removeEntry(n, { recursive: true }).catch(() => {});
    }
  } catch (x) { fails++; lines.push(`FAIL ${x?.stack ?? x}`); }
  postMessage({ fails, lines, notes });
};
