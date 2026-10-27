// Starting the game from the page, as host/run.mjs does under Node: the shared
// memory (its size as the module declares it), the control and RPC blocks,
// the I/O worker and a pool of game-thread workers, slot 0 running _start.
// The page itself never runs wasm and never blocks.
// After nfsu2-web's web/src/host/process.ts (MIT; see ../NOTICE.md).
import { CTL_INTS, CTL_NEXT_TID, CTL_POOL, MAX_THREADS, POOL_RUN_MAIN, RPC_BYTES } from '../host/proto.mjs';

// the memory the module imports: its limits, from the import section
export function memoryLimits(bytes) {
  let i = 8;
  const leb = () => { let r = 0, s = 0, b; do { b = bytes[i++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return r; };
  const name = () => { const n = leb(); i += n; };
  while (i < bytes.length) {
    const id = bytes[i++], size = leb(), end = i + size;
    if (id === 2) {
      for (let n = leb(); n > 0; n--) {
        name(); name();
        const kind = bytes[i++];
        if (kind === 0) leb();
        else if (kind === 1) { i++; const f = bytes[i++]; leb(); if (f & 1) leb(); }
        else if (kind === 2) { const f = bytes[i++], min = leb(), max = f & 1 ? leb() : 65536; return { min, max, shared: !!(f & 2) }; }
        else if (kind === 3) i += 2;
        else if (kind === 4) { i++; leb(); }
      }
    }
    i = end;
  }
  return null;
}

// onRegister(kind, ptr, size, memory, { build }): where wasi/screen.c's frames (1) and input ring (2),
// wasi/sdl.c's sound (3) and wasi/net.c's network mailbox (4) are, in memory; build: the module's id
// (the first 8 bytes of its SHA-256, as hex: the relay keeps players of different builds apart).
// save, fresh: the OPFS folder the game's writes are kept in, and whether to empty it first (save-store.js).
// cache, freshCache: whether the game data is kept in OPFS as it is read, and that kept emptied first (data-cache.js).
export async function startProcess({ wasmUrl, args, env = {}, pool = 16, save = 'ra2yr', fresh = false, cache = true, freshCache = false,
                                     onLog, onExit, onRegister = () => {} }) {
  const log = (s) => onLog(s, 2, -1);
  if (!crossOriginIsolated) throw new Error('the page is not cross-origin isolated: no SharedArrayBuffer');
  let t0 = performance.now();
  const bytes = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
  const fetchMs = performance.now() - t0;
  const build = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const lim = memoryLimits(bytes);
  if (!lim?.shared) throw new Error(`${wasmUrl}: imports no shared memory`);
  t0 = performance.now();
  const mod = await WebAssembly.compile(bytes);
  const compileMs = performance.now() - t0;
  const memory = new WebAssembly.Memory({ initial: lim.min, maximum: lim.max, shared: true });
  const ctlBuf = new SharedArrayBuffer(CTL_INTS * 4), rpc = new SharedArrayBuffer(RPC_BYTES);
  const ctl = new Int32Array(ctlBuf);
  ctl[CTL_NEXT_TID] = 1;
  pool = Math.min(pool, MAX_THREADS);
  const cfg = { args: ['ra2', ...args], env };
  log(`[host] ${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? navigator.userAgent}: ${wasmUrl} ${(bytes.length / 1048576).toFixed(1)} MB ` +
      `fetched in ${fetchMs.toFixed(0)} ms, compiled in ${compileMs.toFixed(0)} ms; memory ${lim.min * 64 / 1024} MB of ${lim.max * 64 / 1024} MB; ${pool} threads`);

  const workers = [];
  let done = false, io = null;
  // The game threads first, then the I/O worker once it has made what the
  // data cache kept last (at most 2 s): a block kept but not yet named in the
  // cache's index would be fetched again next time.
  const exit = async (code) => {
    if (done) return;
    done = true;
    for (const w of workers) if (w !== io) w.terminate();
    if (io) {
      await new Promise((res) => {
        const t = setTimeout(res, 2000);
        io.onmessage = (e) => { if (e.data.t === 'io-done') { clearTimeout(t); res(); } else onMsg(e); };
        io.postMessage({ t: 'shutdown' });
      });
      io.terminate();
    }
    onExit(code);
  };
  const onMsg = (e) => {
    const m = e.data;
    if (m.t === 'log') onLog(m.s, m.fd, m.tid);
    else if (m.t === 'note') log(m.s);
    else if (m.t === 'register') onRegister(m.kind, m.ptr, m.size, memory, { build });
    else if (m.t === 'trap') log(`[host] TRAP in thread ${m.tid}: ${m.msg}\n${m.stack ?? ''}`);
    else if (m.t === 'exit') { log(`[host] exit ${m.code}; ${Atomics.load(ctl, CTL_NEXT_TID) - 1} threads were started`); exit(m.code); }
  };

  // the timer probe: how late a short wait wakes, for the game threads' sleeps (host/core/timer-probe.mjs)
  const probe = new Worker(new URL('./timer-worker.js', import.meta.url), { type: 'module', name: 'timer' });
  probe.onmessage = (e) => log(e.data.s);
  probe.postMessage({ ctl: ctlBuf, grid: +(env.RA2WEB_TIMER_MS ?? 0) });
  workers.push(probe);

  const ioWorker = new Worker(new URL('./io-worker.js', import.meta.url), { type: 'module', name: 'io' });
  workers.push(ioWorker);
  await new Promise((res, rej) => {
    ioWorker.onmessage = (e) => (e.data.t === 'io-ready' ? res() : e.data.t === 'io-error' ? rej(new Error(e.data.msg)) : onMsg(e));
    ioWorker.onerror = (e) => rej(new Error(`I/O worker: ${e.message}`));
    ioWorker.postMessage({ memory, ctl: ctlBuf, rpc, save, fresh, cache, freshCache });
  });
  ioWorker.onmessage = onMsg;
  io = ioWorker;

  t0 = performance.now();
  const ready = [];
  for (let s = 0; s < pool; s++) {
    const w = new Worker(new URL('./game-worker.js', import.meta.url), { type: 'module', name: `game-${s}` });
    ready.push(new Promise((res) => { w.onmessage = (e) => { if (e.data.t === 'ready') { w.onmessage = onMsg; res(); } else onMsg(e); }; }));
    w.onerror = (e) => { log(`[host] game worker ${s}: ${e.message}`); exit(134); };
    w.postMessage({ mod, memory, ctl: ctlBuf, rpc, slot: s, pool, cfg });
    workers.push(w);
  }
  await Promise.all(ready);
  log(`[host] ${pool} threads instantiated in ${(performance.now() - t0).toFixed(0)} ms; starting`);
  Atomics.store(ctl, CTL_POOL, POOL_RUN_MAIN); Atomics.notify(ctl, CTL_POOL);
  return { memory, ctl, terminate: () => exit(-1) };
}
