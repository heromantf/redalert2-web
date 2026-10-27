// The download ahead, from the page: its worker (predownload-worker.js)
// started and stopped, and where it stands, for the page's panel:
//   { phase: 'idle' | 'running' | 'stopping' | 'stopped' | 'done' | 'busy' | 'error', still (s with nothing kept, running),
//     have, total (bytes of what it takes, in this browser), movies (whether it takes them),
//     gameHave, gameTotal, movieHave, movieTotal (the game's files and the movies, apart: both whether it takes the movies or not),
//     rate (bytes a second, over the last 5 s), eta (s), file, waiting ({ why, tries, ms, at }),
//     got, wire (this run: the data kept, and its bytes on the network), msg (an error's) }
// refresh() counts what this browser keeps without the cache's lock (any time:
// data-cache.js scanKept), the movies too (a game keeps what it plays of them);
// 'busy' while another tab (or a game) holds it.
// only, fault: for tests (those paths alone; data-cache.js's faults).
import { cacheBusy, scanKept } from './data-cache.js';
import { aheadFiles, isMovie, manifestFiles } from './game-files.js';

const STOP_WAIT_MS = 5000, RATE_MS = 5000;

export function predownload({ onUpdate = () => {}, log = () => {}, only = null } = {}) {
  const st = { phase: 'idle', have: 0, total: 0, movies: false, gameHave: 0, gameTotal: 0, movieHave: 0, movieTotal: 0,
              rate: 0, eta: null, file: '', waiting: null, got: 0, wire: 0, msg: '', still: 0 };
  let w = null, files = null, samples = [], waiters = [], t0 = 0, heardAt = 0;
  const emit = () => onUpdate({ ...st });
  const mine = async () => {             // the movies too: refresh() counts them apart
    files ??= await manifestFiles();
    const a = aheadFiles(files, { movies: true });
    return only ? a.filter((f) => only.includes(f.path)) : a;
  };
  function sample() {
    const now = performance.now();
    samples.push([now, st.have]);
    while (samples.length > 2 && now - samples[1][0] >= RATE_MS) samples.shift();
    const [ts, hs] = samples[0];
    st.rate = now - ts >= 1000 ? (st.have - hs) / ((now - ts) / 1000) : 0;
    st.eta = st.rate > 0 ? (st.total - st.have) / st.rate : null;
  }
  function finish() {
    w?.terminate(); w = null;
    st.rate = 0; st.eta = null; st.waiting = null; st.still = 0;
    emit();
    for (const r of waiters.splice(0)) r();
  }
  return {
    state: () => ({ ...st }),
    // how long since the worker last said anything (it says where it stands every 250 ms): ms, or 0 when none runs
    silentFor: () => (w ? performance.now() - heardAt : 0),
    running: () => !!w,
    async refresh({ movies = st.movies } = {}) {
      if (w) return;
      st.movies = movies;
      st.got = st.wire = 0;                // "this run": a download's, as it ends, not after
      const fs = await mine(), k = await scanKept(fs);
      st.gameHave = st.gameTotal = st.movieHave = st.movieTotal = 0;
      for (const f of fs) {
        const here = k.by.get(f.path) ?? 0;
        if (isMovie(f)) st.movieHave += here, st.movieTotal += f.size;
        else st.gameHave += here, st.gameTotal += f.size;
      }
      st.total = st.gameTotal + (movies ? st.movieTotal : 0);
      st.have = st.gameHave + (movies ? st.movieHave : 0);
      st.phase = (await cacheBusy()) ? 'busy' : st.have >= st.total ? 'done' : st.phase === 'stopped' ? 'stopped' : 'idle';
      emit();
    },
    start({ movies = st.movies, fault } = {}) {
      if (w) return;
      Object.assign(st, { phase: 'running', movies, msg: '', got: 0, wire: 0, waiting: null, rate: 0, eta: null });
      samples = []; t0 = heardAt = performance.now();
      emit();
      log(`[predownload] started${movies ? ', with the movies' : ''}`);
      w = new Worker(new URL('./predownload-worker.js', import.meta.url), { type: 'module', name: 'predownload' });
      w.onmessage = (e) => {
        const m = e.data;
        heardAt = performance.now();
        if (m.t === 'note') { log(m.s); return; }
        if (m.t === 'busy') { st.phase = 'busy'; log('[predownload] another tab of this site has the game data'); finish(); return; }
        for (const k of ['have', 'total', 'got', 'wire', 'file', 'waiting', 'still']) if (k in m) st[k] = m[k];
        if ('have' in m) { st.gameHave = m.have - m.movHave; if (st.movies) st.movieHave = m.movHave; }   // without them, as refresh() found
        if (m.t === 'progress') { sample(); emit(); return; }
        st.phase = m.t;
        if (m.t === 'error') st.msg = m.msg;
        const secs = (performance.now() - t0) / 1000;
        log(`[predownload] ${m.t}${m.msg ? `: ${m.msg}` : ''}: ${(st.have / 1048576).toFixed(0)} of ${(st.total / 1048576).toFixed(0)} MB here; ` +
            `this run ${(st.got / 1048576).toFixed(1)} MB in ${secs.toFixed(1)} s, ${(st.wire / 1048576).toFixed(1)} MB on the network`);
        finish();
      };
      w.onerror = (e) => { st.phase = 'error'; st.msg = e.message; log(`[predownload] error: ${e.message}`); finish(); };
      w.postMessage({ t: 'start', movies, only, fault });
    },
    // -> once it has stopped (what it kept made to last; the cache's lock let go), at most 5 s
    stop() {
      if (!w) return Promise.resolve();
      st.phase = 'stopping'; emit();
      w.postMessage({ t: 'stop' });
      const it = w;
      return new Promise((res) => {
        waiters.push(res);
        setTimeout(() => { if (w === it) { log(`[predownload] did not stop in ${STOP_WAIT_MS / 1000} s: ended`); st.phase = 'stopped'; finish(); } }, STOP_WAIT_MS);
      });
    },
  };
}
