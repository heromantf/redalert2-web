// bench.html's worker: OPFS's sync access handles, timed (bench), held
// (hold, release) and tried while another worker holds them (try).
const B = 1 << 20, N = 64;
const say = (line) => postMessage({ line });
const dirOf = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('opfs-bench', { create: true });
function stats(name, a) {
  a.sort((x, y) => x - y);
  say(`${name}: median ${a[a.length >> 1].toFixed(3)} ms, p90 ${a[Math.floor(a.length * 0.9)].toFixed(3)} ms, max ${a[a.length - 1].toFixed(3)} ms (${a.length})`);
}
let held = null;
onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.t === 'bench') {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('opfs-bench', { recursive: true }).catch(() => {});
      const dir = await dirOf(), t = () => performance.now();
      const before = (await navigator.storage.estimate()).usage;
      const open = [], sah = [], sahU = [];
      for (let i = 0; i < 32; i++) {
        let t0 = t();
        const fh = await dir.getFileHandle('f' + i, { create: true });
        open.push(t() - t0);
        t0 = t(); const h = await fh.createSyncAccessHandle(); sah.push(t() - t0); h.close();
        t0 = t(); const h2 = await fh.createSyncAccessHandle({ mode: 'readwrite-unsafe' }); sahU.push(t() - t0); h2.close();
      }
      stats('getFileHandle (create)', open); stats('createSyncAccessHandle', sah); stats('createSyncAccessHandle, readwrite-unsafe', sahU);
      const block = new Uint8Array(B);
      for (let i = 0; i < B; i += 65536) crypto.getRandomValues(block.subarray(i, i + 65536));
      const h = await (await dir.getFileHandle('big', { create: true })).createSyncAccessHandle({ mode: 'readwrite-unsafe' });
      const w = [], f = [], r = [], one = [], w16 = [];
      for (let i = 0; i < N; i++) {                       // every 3rd MiB: a sparse file, as a cache file is
        let t0 = t(); const k = h.write(block, { at: i * 3 * B }); w.push(t() - t0);
        if (k !== B) throw new Error(`wrote ${k}`);
        t0 = t(); h.flush(); f.push(t() - t0);
      }
      for (let i = 0; i < N; i++) {
        const b = new Uint8Array(B), t0 = t(), k = h.read(b, { at: i * 3 * B }); r.push(t() - t0);
        if (k !== B || b[12345] !== block[12345] || b[B - 1] !== block[B - 1]) throw new Error(`read back wrong at block ${i}`);
      }
      const hole = new Uint8Array(B); h.read(hole, { at: B });
      say(`a hole reads as ${hole.every((x) => x === 0) ? 'zeros' : 'something else'}; the file's size ${h.getSize() / B} MiB for ${N} MiB written`);
      for (let i = 0; i < 16; i++) { const t0 = t(); h.write(block.subarray(0, 1), { at: 200 * B + i }); one.push(t() - t0); }
      for (let j = 0; j < 8; j++) {
        const t0 = t();
        for (let i = 0; i < 16; i++) h.write(block, { at: (300 + 16 * j + i) * B });
        h.flush(); w16.push(t() - t0);
      }
      stats('write 1 MiB', w); stats('flush after it', f); stats('read 1 MiB', r); stats('write 1 byte', one); stats('write 16 MiB, then one flush', w16);
      const len = h.getSize();
      h.close();
      const after = (await navigator.storage.estimate()).usage;
      say(`quota usage: ${((after - before) / B).toFixed(1)} MiB more for a file ${(len / B).toFixed(0)} MiB long with ${N + 128} MiB of it written`);
      postMessage({ done: true });
    } else if (m.t === 'hold') {
      const fh = await (await dirOf()).getFileHandle('shared', { create: true });
      try { held = await fh.createSyncAccessHandle({ mode: m.mode }); held.write(new Uint8Array([42]), { at: 0 }); held.flush(); postMessage({ held: true }); }
      catch (x) { postMessage({ held: false, err: String(x) }); }
    } else if (m.t === 'release') {
      held?.close(); held = null; postMessage({ released: true });
    } else if (m.t === 'peek') {        // the File API's read, while another holds a sync handle
      const fh = await (await dirOf()).getFileHandle('shared', { create: true });
      try { const b = new Uint8Array(await (await fh.getFile()).arrayBuffer()); postMessage({ done: true, ok: true, saw: b[0] }); }
      catch (x) { postMessage({ done: true, ok: false, err: x?.name ?? String(x) }); }
    } else if (m.t === 'try') {
      const fh = await (await dirOf()).getFileHandle('shared', { create: true });
      try { const h = await fh.createSyncAccessHandle({ mode: m.mode }); const b = new Uint8Array(1); h.read(b, { at: 0 }); h.close(); postMessage({ done: true, ok: true, saw: b[0] }); }
      catch (x) { postMessage({ done: true, ok: false, err: x?.name ?? String(x) }); }
    } else if (m.t === 'clean') {
      await (await navigator.storage.getDirectory()).removeEntry('opfs-bench', { recursive: true });
      say('cleaned up'); postMessage({ done: true });
    }
  } catch (x) { say(`FAIL ${x?.stack ?? x}`); postMessage({ done: true, ok: false }); }
};
