// Does Chrome ever leave createSyncAccessHandle unanswered? Variants, each with a time limit per handle:
//  reopen: a file's handles closed and asked for again at once, N times
//  lru:    F files opened in turn, 64 kept open (the oldest closed), then each asked for again (data-cache.js's pattern)
//  idx:    as lru, with a second file per entry (its .idx), as data-cache.js opens two
const LIMIT = 5000;
const log = (s) => postMessage({ log: s });
async function handle(dir, name) {
  const p = (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  let t = 0;
  const r = await Promise.race([p, new Promise((res) => { t = setTimeout(() => res(null), LIMIT); })]);
  clearTimeout(t);
  if (!r) p.then((h) => h.close(), () => {});
  return r;
}
onmessage = (e) => go(e.data).catch((x) => postMessage({ done: 'error: ' + (x?.stack ?? x) }));
async function go({ variant, n, files, write }) {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry('handles-spike', { recursive: true }).catch(() => {});
  const dir = await root.getDirectoryHandle('handles-spike', { create: true });
  let late = 0, asked = 0;
  const t0 = performance.now();
  const block = new Uint8Array(write ? 1 << 20 : 4);
  if (variant === 'closewhile' || variant === 'closeafter') {
    // a handle asked for (Y), and another file's handle (X) closed before Y's answer comes, or only after it
    const xs = [];
    for (let i = 0; i < 16; i++) xs.push(await handle(dir, `x${i}`));
    for (let i = 0; i < n; i++) {
      const fh = await dir.getFileHandle(`y${i}`, { create: true });
      const p = fh.createSyncAccessHandle(); asked++;
      let t = 0;
      if (variant === 'closewhile') { const x = xs[i % 16]; x.close(); }
      const h = await Promise.race([p, new Promise((res) => { t = setTimeout(() => res(null), LIMIT); })]);
      clearTimeout(t);
      if (variant === 'closeafter') xs[i % 16].close();
      if (!h) { late++; log(`late: y${i}`); p.then((hh) => hh.close(), () => {}); }
      else { h.write(block, { at: 0 }); h.close(); }
      xs[i % 16] = await handle(dir, `x${i % 16}`);
    }
    for (const x of xs) x?.close();
  } else if (variant === 'twice') {
    // a second handle asked for while the first is still open: refused at once, or kept waiting?
    const fh = await dir.getFileHandle('same', { create: true });
    const h1 = await fh.createSyncAccessHandle(); asked++;
    const t1 = performance.now();
    const second = fh.createSyncAccessHandle().then((h) => ({ h }), (x) => ({ x }));
    const r = await Promise.race([second, new Promise((res) => setTimeout(() => res(null), LIMIT))]);
    log(r === null ? `twice: the second still unanswered after ${LIMIT / 1000} s, the first open`
      : r.x ? `twice: the second refused in ${(performance.now() - t1).toFixed(0)} ms (${r.x.name}: ${r.x.message})` : 'twice: the second given (!)');
    h1.close();
    if (r === null) { const r2 = await Promise.race([second, new Promise((res) => setTimeout(() => res(null), LIMIT))]); log(`twice: once the first closed, the second ${r2 === null ? 'still unanswered' : r2.x ? 'refused' : 'given'}`); if (r2?.h) r2.h.close(); }
    else if (r.h) r.h.close();
  } else if (variant === 'reopen') {
    for (let i = 0; i < n; i++) {
      const h = await handle(dir, `f${i % 8}`); asked++;
      if (!h) { late++; log(`late: f${i % 8} at try ${i}`); continue; }
      h.write(block, { at: 0 }); h.flush(); h.close();
    }
  } else if (variant === 'lanes') {
    // data-cache.js under predownload-worker.js: every file opened once in turn first (its blocks missing?),
    // then LANES lanes at once, each its own run of files: open (sharing one LRU of 64, closing the oldest),
    // a 1 MB write, a flush every few blocks, a pause as for the network between
    const open = new Map(), opening = new Map();
    const shut = (v) => { v[0].flush(); v[0].close(); v[1].close(); };
    const get = async (k) => {
      if (open.has(k)) { const v = open.get(k); open.delete(k); open.set(k, v); return v; }
      if (opening.has(k)) return opening.get(k);
      const p = (async () => {
        const a = await handle(dir, k); asked++;
        const b = await handle(dir, k + '.idx'); asked++;
        if (!a || !b) { late++; log(`late: ${k}${a ? '.idx' : ''} (${open.size} open)`); a?.close(); b?.close(); return null; }
        return [a, b];
      })();
      opening.set(k, p);
      const v = await p;
      opening.delete(k);
      if (!v) return null;
      open.set(k, v);
      for (const [kk, vv] of open) { if (open.size <= 64) break; open.delete(kk); shut(vv); }
      return v;
    };
    for (let i = 0; i < files; i++) await get(`f${i}`);
    let next = 0, kept = 0;
    const lane = async () => {
      while (next < files) {
        const k = `f${next++}`;
        for (let b = 0; b < (next % 5 === 0 ? 8 : 1); b++) {
          await new Promise((r) => setTimeout(r, Math.random() * 4));
          const v = await get(k);
          if (!v) break;
          v[0].write(block, { at: b * block.length });
          if (++kept % 32 === 0) for (const vv of open.values()) { vv[0].flush(); vv[1].write(new Uint8Array(4), { at: 0 }); }
        }
      }
    };
    await Promise.all([lane(), lane(), lane(), lane()]);
    for (const v of open.values()) shut(v);
  } else {
    const open = new Map(), two = variant === 'idx';
    const get = async (k) => {
      if (open.has(k)) { const v = open.get(k); open.delete(k); open.set(k, v); return v; }
      const a = await handle(dir, k); asked++;
      const b = two ? await handle(dir, k + '.idx') : null; if (two) asked++;
      if (!a || (two && !b)) { late++; log(`late: ${k}${a ? '.idx' : ''}`); a?.close(); b?.close(); return null; }
      open.set(k, [a, b]);
      for (const [kk, v] of open) { if (open.size <= 64) break; open.delete(kk); v[0].flush(); v[0].close(); v[1]?.close(); }
      return [a, b];
    };
    for (let round = 0; round < 2; round++)
      for (let i = 0; i < files; i++) { const v = await get(`f${i}`); if (v) { v[0].write(block, { at: 0 }); v[1]?.write(new Uint8Array(4), { at: 0 }); } }
    for (const v of open.values()) { v[0].close(); v[1]?.close(); }
  }
  postMessage({ done: `${variant}${write ? ' (1 MB writes)' : ''}: ${asked} handles asked for, ${late} not given in ${LIMIT / 1000} s, ${((performance.now() - t0) / 1000).toFixed(1)} s` });
}
