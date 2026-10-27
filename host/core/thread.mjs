// A game thread, wherever its worker runs (Node's worker_threads, a page's
// Worker): it instantiates the game module on the shared memory and parks
// until it is handed the process entry (_start) or a thread started through
// wasi thread-spawn. Everything that blocks (sleeps, waits, synchronous file
// I/O through the I/O worker) blocks this worker only.
//
// After nfsu2-web's web/src/host/game-worker.ts (MIT; see ../../NOTICE.md),
// with one host import of its own instead of nfsu2-web's: ra2web.register(kind,
// ptr, size), where wasi/screen.c says where its frames (1) and its input ring
// (2) are. post(message) sends to the process: { t: 'log', s, fd, tid },
// { t: 'ready', slot }, { t: 'register', kind, ptr, size }, { t: 'trap', tid,
// msg, stack }, { t: 'exit', code }.
import {
  CTL_EXIT, CTL_EXIT_CODE, CTL_IO_DOORBELL, CTL_NEXT_TID, CTL_POOL, CTL_SLEEP, CTL_TIMER_LATE, E, Op, POOL_CLAIMED,
  POOL_IDLE, POOL_RUN_MAIN, POOL_RUN_THREAD, RPC_DONE, RPC_IDLE, RPC_POSTED, RPC_SLOT,
} from '../proto.mjs';
import { COARSE_MS } from './timer-probe.mjs';

class ProcExit { constructor(code) { this.code = code; } }

export async function runThread({ mod, memory, ctl: ctlBuf, rpc, slot, pool: POOL, cfg, post }) {
  const ctl = new Int32Array(ctlBuf);
  const rpcI32 = new Int32Array(rpc), rpcI64 = new BigInt64Array(rpc);
  let tid = 0;

  const u8 = () => new Uint8Array(memory.buffer);
  const dv = () => new DataView(memory.buffer);
  const te = new TextEncoder(), td = new TextDecoder();

  // ---- logging: stdout/stderr lines go to the process ----
  const pending = { 1: '', 2: '' };
  function writeOut(fd, bytes) {
    pending[fd] += td.decode(bytes, { stream: true });
    let k;
    while ((k = pending[fd].indexOf('\n')) >= 0) { post({ t: 'log', s: pending[fd].slice(0, k), fd, tid }); pending[fd] = pending[fd].slice(k + 1); }
  }

  // ---- synchronous call into the I/O worker ----
  function io(op, ...args) {
    const b = slot * (RPC_SLOT / 4), b64 = slot * (RPC_SLOT / 8);
    rpcI32[b + 1] = op; rpcI32[b + 3] = args.length;
    for (let i = 0; i < args.length; i++) rpcI64[b64 + 2 + i] = BigInt(args[i]);
    Atomics.store(rpcI32, b, RPC_POSTED);
    Atomics.add(ctl, CTL_IO_DOORBELL, 1); Atomics.notify(ctl, CTL_IO_DOORBELL);
    // wait on the value just checked: re-loading it for Atomics.wait could read RPC_DONE (the I/O
    // worker finished in between) and then sleep on DONE forever, the notify already gone
    for (let v; (v = Atomics.load(rpcI32, b)) !== RPC_DONE;) Atomics.wait(rpcI32, b, v);
    const r = rpcI32[b + 2];
    Atomics.store(rpcI32, b, RPC_IDLE);
    return r;
  }

  const T0US = Math.round(performance.timeOrigin * 1e3), T0MS = performance.timeOrigin;
  const monoNs = () => BigInt(Math.round(performance.now() * 1e3) + T0US) * 1000n;
  const writeUsAsNs = (p, us) => dv().setBigUint64(p, BigInt(us) * 1000n, true);
  // Every timed wait of the game comes here: Sleep, and WaitForSingleObject's polling (win32hle
  // looks every 0.2 ms), the sound's pacing (wasi/sdl.c). Where the timer is coarse (Chrome on
  // Windows: a 1 ms wait wakes up to 15.6 ms late; timer-probe.mjs measures it all along), a sleep
  // under SPIN_UNDER_MS waits for all but that lateness and spins on the clock for the rest: the
  // game's main loop sleeps a millisecond at a time, ~390 times a second. Measured on a simulated
  // Windows timer (RA2WEB_TIMER_MS=15.625), the scripted skirmish in Chrome: unspun 184-197 game
  // frames in 3.33 s and the sound short 8 times, spun 197-209 as on a fine timer (and natively)
  // and the sound never short. Under 8 ms: the main thread spins (~0.9 of a core while the game
  // runs); spun up to 50 ms the 16 ms sleeps of two other threads cost 1.4 cores more and changed
  // nothing. Longer sleeps wait as asked, and on a fine timer nothing spins.
  // Tests: RA2WEB_TIMER_MS=15.625 ends every wait on that grid of the clock, as on Windows (the
  // probe's too); RA2WEB_SPIN_UNDER_MS sets the bound; RA2WEB_SLEEP_STATS=1 logs this thread's
  // sleeps every 10 s.
  const GRID = +(cfg.env.RA2WEB_TIMER_MS ?? 0), STATS = !!cfg.env.RA2WEB_SLEEP_STATS, SPIN_UNDER_MS = +(cfg.env.RA2WEB_SPIN_UNDER_MS ?? 8);
  const BUCKETS = [0.5, 2, 8, 20, Infinity], st = { n: 0, by: [0, 0, 0, 0, 0], asked: 0, slept: 0, spun: 0, t0: performance.now() };
  const timedWait = (ms) => {
    if (GRID) { const now = performance.now(); ms = Math.ceil((T0MS + now + ms) / GRID) * GRID - (T0MS + now); }
    Atomics.wait(ctl, CTL_SLEEP, 0, ms);
  };
  function sleepNs(ns) {
    const ms = Number(ns) / 1e6;
    if (!(ms > 0)) return;
    const t0 = performance.now(), end = t0 + ms;
    const late = ms < SPIN_UNDER_MS ? Atomics.load(ctl, CTL_TIMER_LATE) / 1000 : 0, spin = late > COARSE_MS;
    const w = spin ? ms - late - 0.25 : ms;
    if (w > 0) timedWait(w);
    let t1 = performance.now();
    if (spin) { const s0 = t1; while (t1 < end) t1 = performance.now(); st.spun += t1 - s0; }
    if (STATS) {
      st.n++; st.by[BUCKETS.findIndex((b) => ms < b)]++; st.asked += ms; st.slept += t1 - t0;
      if (t1 - st.t0 >= 10000) {
        post({ t: 'log', s: `[sleep] thread ${tid}: ${st.n} sleeps in ${((t1 - st.t0) / 1000).toFixed(0)} s (asked <0.5 ms ${st.by[0]}, <2 ${st.by[1]}, <8 ${st.by[2]}, <20 ${st.by[3]}, more ${st.by[4]}), ` +
                     `${st.asked.toFixed(0)} ms asked, ${st.slept.toFixed(0)} ms slept, ${st.spun.toFixed(0)} of them spun`, fd: 2, tid });
        Object.assign(st, { n: 0, by: [0, 0, 0, 0, 0], asked: 0, slept: 0, spun: 0, t0: t1 });
      }
    }
  }
  const strings = (list) => list.map(s => te.encode(s + '\0'));

  function wasi() {
    const argv = strings(cfg.args);
    const envv = strings(Object.entries(cfg.env).map(([k, v]) => `${k}=${v}`));
    const sizes = (l, pc, ps) => { dv().setUint32(pc, l.length, true); dv().setUint32(ps, l.reduce((a, b) => a + b.length, 0), true); return 0; };
    const fill = (l, pv, pb) => { const d = dv(), m = u8(); let o = pb; l.forEach((b, i) => { d.setUint32(pv + 4 * i, o, true); m.set(b, o); o += b.length; }); return 0; };
    return {
      args_sizes_get: (pc, ps) => sizes(argv, pc, ps),
      args_get: (pv, pb) => fill(argv, pv, pb),
      environ_sizes_get: (pc, ps) => sizes(envv, pc, ps),
      environ_get: (pv, pb) => fill(envv, pv, pb),
      clock_res_get: (_id, p) => { dv().setBigUint64(p, 1000n, true); return 0; },
      clock_time_get: (id, _prec, p) => {
        // 0 realtime, 1 monotonic, 2/3 process/thread CPU time (wall time here)
        writeUsAsNs(p, id === 0 ? Math.round((T0MS + performance.now()) * 1e3) : Math.round(performance.now() * 1e3) + T0US);
        return 0;
      },
      random_get: (p, n) => {
        const b = new Uint8Array(n); for (let o = 0; o < n; o += 65536) crypto.getRandomValues(b.subarray(o, Math.min(n, o + 65536)));
        u8().set(b, p); return 0;
      },
      sched_yield: () => 0,
      proc_exit: (code) => { throw new ProcExit(code); },
      proc_raise: () => E.NOSYS,
      poll_oneoff: (inp, outp, n, pn) => {
        // clock subscriptions only (nanosleep, usleep): sleep until the earliest one
        const d = dv(); let wait = -1n; const now = monoNs();
        for (let i = 0; i < n; i++) {
          const s = inp + 48 * i;
          if (d.getUint8(s + 8) !== 0) continue;
          let t = d.getBigUint64(s + 24, true);
          if (d.getUint16(s + 40, true) & 1) t = t > now ? t - now : 0n;       // abstime
          if (wait < 0n || t < wait) wait = t;
        }
        if (wait > 0n) sleepNs(wait);
        let k = 0;
        for (let i = 0; i < n; i++) {
          const s = inp + 48 * i, o = outp + 32 * k++;
          d.setBigUint64(o, d.getBigUint64(s, true), true); d.setUint16(o + 8, 0, true); d.setUint8(o + 10, d.getUint8(s + 8));
        }
        d.setUint32(pn, k, true); return 0;
      },
      fd_write: (fd, iov, n, pw) => {
        if (fd === 1 || fd === 2) {
          const d = dv(); let t = 0;
          for (let i = 0; i < n; i++) { const b = d.getUint32(iov + 8 * i, true), l = d.getUint32(iov + 8 * i + 4, true); writeOut(fd, u8().slice(b, b + l)); t += l; }
          d.setUint32(pw, t, true); return 0;
        }
        return io(Op.FdWrite, fd, iov, n, pw);
      },
      fd_read: (fd, iov, n, pr) => fd === 0 ? (dv().setUint32(pr, 0, true), 0) : io(Op.FdRead, fd, iov, n, pr),
      fd_pread: (fd, iov, n, off, pr) => io(Op.FdPread, fd, iov, n, off, pr),
      fd_pwrite: (fd, iov, n, off, pw) => io(Op.FdPwrite, fd, iov, n, off, pw),
      fd_seek: (fd, off, wh, p) => io(Op.FdSeek, fd, off, wh, p),
      fd_tell: (fd, p) => io(Op.FdTell, fd, p),
      fd_close: (fd) => (fd <= 2 ? 0 : io(Op.FdClose, fd)),
      fd_sync: (fd) => (fd <= 2 ? 0 : io(Op.FdSync, fd)),
      fd_datasync: (fd) => (fd <= 2 ? 0 : io(Op.FdSync, fd)),
      fd_fdstat_get: (fd, p) => {
        if (fd <= 2) { const d = dv(); d.setUint8(p, 2); d.setUint16(p + 2, 0, true); d.setBigUint64(p + 8, 0xFFFFFFFFn, true); d.setBigUint64(p + 16, 0n, true); return 0; }
        return io(Op.FdFdstatGet, fd, p);
      },
      fd_fdstat_set_flags: (fd, fl) => io(Op.FdFdstatSetFlags, fd, fl),
      fd_fdstat_set_rights: () => 0,
      fd_filestat_get: (fd, p) => io(Op.FdFilestatGet, fd, p),
      fd_filestat_set_size: (fd, sz) => io(Op.FdFilestatSetSize, fd, sz),
      fd_filestat_set_times: (fd, a, m, fl) => io(Op.FdFilestatSetTimes, fd, a, m, fl),
      fd_readdir: (fd, buf, len, cookie, pu) => io(Op.FdReaddir, fd, buf, len, cookie, pu),
      fd_prestat_get: (fd, p) => io(Op.FdPrestatGet, fd, p),
      fd_prestat_dir_name: (fd, p, l) => io(Op.FdPrestatDirName, fd, p, l),
      fd_advise: () => 0,
      fd_allocate: (fd, off, len) => io(Op.FdAllocate, fd, off, len),
      fd_renumber: (a, b) => io(Op.FdRenumber, a, b),
      path_open: (dfd, dfl, p, pl, of, rb, ri, ff, pfd) => io(Op.PathOpen, dfd, dfl, p, pl, of, rb, ri, ff, pfd),
      path_filestat_get: (dfd, fl, p, pl, out) => io(Op.PathFilestatGet, dfd, fl, p, pl, out),
      path_filestat_set_times: (dfd, fl, p, pl, a, m, f2) => io(Op.PathFilestatSetTimes, dfd, fl, p, pl, a, m, f2),
      path_create_directory: (dfd, p, pl) => io(Op.PathCreateDirectory, dfd, p, pl),
      path_remove_directory: (dfd, p, pl) => io(Op.PathRemoveDirectory, dfd, p, pl),
      path_unlink_file: (dfd, p, pl) => io(Op.PathUnlinkFile, dfd, p, pl),
      path_rename: (a, ap, al, b, bp, bl) => io(Op.PathRename, a, ap, al, b, bp, bl),
      path_link: () => E.NOSYS, path_symlink: () => E.NOSYS, path_readlink: () => E.NOSYS,
      sock_accept: () => E.NOSYS, sock_recv: () => E.NOSYS, sock_send: () => E.NOSYS, sock_shutdown: () => E.NOSYS,
    };
  }

  function threadSpawn(arg) {
    const t = Atomics.add(ctl, CTL_NEXT_TID, 1);
    for (let s = 0; s < POOL; s++) {
      const i = CTL_POOL + 4 * s;
      if (Atomics.compareExchange(ctl, i, POOL_IDLE, POOL_CLAIMED) === POOL_IDLE) {
        ctl[i + 1] = t; ctl[i + 2] = arg;
        Atomics.store(ctl, i, POOL_RUN_THREAD); Atomics.notify(ctl, i);
        return t;
      }
    }
    post({ t: 'log', s: `thread-spawn: all ${POOL} pool workers busy`, fd: 2, tid });
    return -6; // EAGAIN
  }

  // a trap's stack keeps this many frames: V8's default of 10 cuts the lifted guest calls off
  Error.stackTraceLimit = 100;

  const imports = {
    env: { memory }, wasi_snapshot_preview1: wasi(), wasi: { 'thread-spawn': threadSpawn },
    ra2web: { register: (kind, ptr, size) => post({ t: 'register', kind, ptr, size }) },
  };
  // any import the module wants that is not here: a stub that says so, loudly
  for (const im of WebAssembly.Module.imports(mod)) {
    const ns = (imports[im.module] ??= {});
    if (im.kind === 'function' && !(im.name in ns))
      ns[im.name] = (...a) => { post({ t: 'log', s: `unimplemented import ${im.module}.${im.name}(${a.join(',')})`, fd: 2, tid }); return E.NOSYS; };
  }
  const ex = (await WebAssembly.instantiate(mod, imports)).exports;
  post({ t: 'ready', slot });

  const i = CTL_POOL + 4 * slot;
  for (;;) {
    let st;
    while ((st = Atomics.load(ctl, i)) === POOL_IDLE || st === POOL_CLAIMED) Atomics.wait(ctl, i, st);
    try {
      if (st === POOL_RUN_MAIN) {
        tid = 0;
        try { ex._start(); Atomics.store(ctl, CTL_EXIT_CODE, 0); }
        catch (x) { if (x instanceof ProcExit) Atomics.store(ctl, CTL_EXIT_CODE, x.code); else throw x; }
        Atomics.store(ctl, CTL_EXIT, 1); Atomics.notify(ctl, CTL_EXIT);
        post({ t: 'exit', code: ctl[CTL_EXIT_CODE] });
        return;
      }
      tid = ctl[i + 1];
      try { ex.wasi_thread_start(tid, ctl[i + 2]); }
      catch (x) {
        if (x instanceof ProcExit) { Atomics.store(ctl, CTL_EXIT_CODE, x.code); Atomics.store(ctl, CTL_EXIT, 1); post({ t: 'exit', code: x.code }); return; }
        throw x;
      }
    } catch (x) {
      post({ t: 'trap', tid, msg: String(x), stack: x?.stack });
      // a trap in any thread takes the process down, as an unhandled fault would on Windows
      Atomics.store(ctl, CTL_EXIT_CODE, 134); Atomics.store(ctl, CTL_EXIT, 1); post({ t: 'exit', code: 134 });
      return;
    }
    Atomics.store(ctl, i, POOL_IDLE);
  }
}
