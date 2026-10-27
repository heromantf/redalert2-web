// Blocks of a file of the game data from web/server.mjs's /blocks/: a run of
// them in one answer (compressed where it pays; the browser undoes it), handed
// on block by block as their bytes come, so that an answer cut on the way
// loses only the block it was in. The game's reads (http-backend.js, a block
// at a time) and the download ahead (predownload-worker.js, runs) both use it.
//
// A try that fails on the way (no answer, a reset, a cut, 408, 429, 5xx) or
// stalls (no byte for 20 s: a link that changed its path, say) is made again
// for the blocks still to come, after a pause of 0.25 s doubling to 8 s, and
// back to 0.25 s once a try brought some: for as long as it takes, as the
// game's read of a slow disc would wait. What asking again cannot change
// fails: the file changed or went on the server (409, 404, 416: Gone, the
// page's manifest is old), another 4xx, or the wrong length three times.
// After nfsu2-web's io-worker.ts (MIT; see ../NOTICE.md).
import { BLOCK } from './data-cache.js';

const STALL_MS = 20000, MAX_PAUSE = 8000;
export class Gone extends Error {}
const blockLen = (size, bi) => Math.min(BLOCK, size - bi * BLOCK);
const pause = (ms, signal) => new Promise((res, rej) => {
  if (signal?.aborted) { rej(signal.reason); return; }
  const t = setTimeout(() => { signal?.removeEventListener('abort', stop); res(); }, ms);
  const stop = () => { clearTimeout(t); rej(signal.reason); };
  signal?.addEventListener('abort', stop, { once: true });
});
let tries = 0;                          // for fault.fail, across the worker

// f: { path, size, mtime }; blocks first .. first + n - 1 (n at most 16); onBlock(bi, bytes): awaited, in order
// (what it throws ends the run, as it is).
// signal: stops it (the promise rejects with its reason). onWait({ what, why, tries, ms }): before each pause.
// onAnswer(bytes): an answer's bytes on the wire (compressed): its length once it came whole, else the share
// of it that came (of the data it was to bring).
// fault (tests): { fail: N } every Nth try lost as a connection would be.
export async function fetchRun({ base = '/blocks/', f, first, n, onBlock, signal, note = () => {}, onWait = () => {}, onAnswer = () => {}, fault = {} }) {
  const end = first + n, path = f.path.split('/').map(encodeURIComponent).join('/');
  let next = first;
  const what = () => `${f.path} block${end - next > 1 ? `s ${next}-${end - 1}` : ` ${next}`}`;
  for (let k = 1, wait = 250, sized = 0; ;) {
    const from = next, r = await once(`${base}${path}?b=${next}&n=${end - next}&s=${f.size}&m=${f.mtime}`);
    if (r === true) return;
    if (next > from) { k = 1; wait = 250; }               // it brought some: the link is there
    if (r.gone) throw new Gone(`${f.path}: ${r.why} (the game data changed on the server since this page loaded)`);
    if (!r.again || (r.size && ++sized >= 3)) throw new Error(`${what()}: ${r.why}`);
    onWait({ what: what(), why: r.why, tries: k, ms: wait });
    if (k <= 3 || k % 10 === 0) note(`[data] ${what()}: ${r.why}; again in ${wait / 1000} s (try ${k + 1})`);
    await pause(wait, signal);
    k++; wait = Math.min(wait * 2, MAX_PAUSE);
  }

  // one try: true when every block came, else why not and whether asking again can help
  async function once(url) {
    if (signal?.aborted) throw signal.reason;
    const ac = new AbortController(), stop = () => ac.abort(signal.reason);
    signal?.addEventListener('abort', stop, { once: true });
    let timer = 0, stalled = false, theirs = null, wire = 0, want = 0, came = 0;
    const alive = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; ac.abort(); }, STALL_MS); };
    alive();
    try {
      if (fault.fail && ++tries % fault.fail === 0) throw new TypeError('lost connection (a test\'s fault)');
      const res = await fetch(url, { cache: 'no-store', signal: ac.signal });
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        const s = res.status;
        return { why: `HTTP ${s}`, gone: s === 404 || s === 409 || s === 416, again: s === 408 || s === 429 || s >= 500 };
      }
      wire = +(res.headers.get('content-length') ?? 0);
      for (let bi = next; bi < end; bi++) want += blockLen(f.size, bi);
      let buf = new Uint8Array(blockLen(f.size, next)), at = 0;
      for (const rd = res.body.getReader(); ;) {
        const { done, value } = await rd.read();
        if (done) break;
        alive();
        for (let off = 0; off < value.length;) {
          if (next >= end) return { why: 'more bytes than asked for', again: true, size: true };
          const k = Math.min(buf.length - at, value.length - off);
          buf.set(value.subarray(off, off + k), at); at += k; off += k; came += k;
          if (at === buf.length) {
            clearTimeout(timer);                // its keeping is not the link's time
            try { await onBlock(next, buf); } catch (e) { theirs = e; throw e; }
            next++;
            alive();
            if (next < end) { buf = new Uint8Array(blockLen(f.size, next)); at = 0; }
          }
        }
      }
      if (next < end) return { why: `the answer ended before block ${next}`, again: true, size: true };
      return true;
    } catch (x) {
      if (signal?.aborted) throw signal.reason;
      if (theirs) throw theirs;
      return { why: stalled ? `no answer for ${STALL_MS / 1000} s` : String(x?.message ?? x), again: true };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (wire && want) onAnswer(came >= want ? wire : Math.round(wire * came / want));
    }
  }
}
