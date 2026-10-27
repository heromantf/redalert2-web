// The download ahead (predownload): the game data but the movies, or with them
// (game-files.js), into this site's OPFS cache before play, so that a game
// waits on no network for its data. The missing blocks of one file after
// another, in runs of up to 8 blocks an answer, 4 answers at once (a far link
// kept full: 32 MB on the way at most), compressed where it pays, each block
// kept as its bytes come (block-fetch.js: a stop, or an answer cut on the way,
// loses only the blocks in flight; a link that goes is waited for). It holds
// the cache's lock while it runs (data-cache.js: one writer), so the page
// stops it before a game starts. What it kept stays: a stopped or failed
// download goes on from there next time. Before it starts it asks the browser
// whether the site has room for what is missing.
// After nfsu2-web's predownload-worker.ts (MIT; see ../NOTICE.md).
//
// Page -> worker: { t: 'start', movies, only, fault }    (only: those paths alone; fault: data-cache.js's, tests)
//                 { t: 'stop' }
// Worker -> page: { t: 'progress', ...st } at most every 250 ms, and once more at the end as
//                 { t: 'done' | 'stopped', ...st }, { t: 'error', msg, ...st }, or { t: 'busy' } (another holds the cache);
//                 { t: 'note', s }: a line for the log
//   st: { have, total (bytes of what it takes, in this browser), movHave (of have, the movies'), got, wire (this
//         run: data kept, bytes on the network), file (the last one asked for), waiting ({ why, tries, ms, at } while
//         the server is waited for) }
import { fetchRun, Gone } from './block-fetch.js';
import { blockLen, openDataCache } from './data-cache.js';
import { aheadFiles, isMovie, manifestFiles } from './game-files.js';

const LANES = 4, RUN = 8, TICK_MS = 250, ROOM_MARGIN = 64 << 20, STILL_MS = 30000;
const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
const note = (s) => postMessage({ t: 'note', s });
class NoRoom extends Error {}
let ac = null;

onmessage = (e) => {
  if (e.data.t === 'stop') ac?.abort(new DOMException('stopped', 'AbortError'));
  else if (e.data.t === 'start' && !ac) run(e.data).catch((x) => postMessage({ t: 'error', msg: String(x?.message ?? x) }));
};

async function run({ movies = false, only = null, fault = {} }) {
  ac = new AbortController();
  const files = await manifestFiles();
  let ahead = aheadFiles(files, { movies });
  if (only) ahead = ahead.filter((f) => only.includes(f.path));
  // every file it opens kept open until it ends (cache.close; data-cache.js's MAX_OPEN is more than the
  // data's files): a file's handles are asked for once, and none are closed meanwhile, under which
  // Chrome (155) now and then left one asked for unanswered (3 downloads in 24 waited 15 s for one;
  // none of 8 with nothing closed; spike/opfs-handles/RESULT.md)
  const cache = await openDataCache({ files, note, fault });
  if (!cache) { postMessage({ t: 'busy' }); return; }
  const st = { have: 0, total: 0, movHave: 0, got: 0, wire: 0, file: '', waiting: null, still: 0 };
  let failure = null, tick = 0, lost = 0;
  try {
    // what is missing, as runs of up to RUN blocks
    const queue = [];
    for (const f of ahead) {
      st.total += f.size;
      const miss = await cache.missing(f);
      if (!miss) throw new NoRoom(`${f.path}: this browser keeps none of it`);
      const here = f.size - miss.reduce((a, bi) => a + blockLen(f.size, bi), 0);
      st.have += here;
      if (isMovie(f)) st.movHave += here;
      for (let i = 0; i < miss.length;) {
        let j = i + 1;
        while (j < miss.length && j - i < RUN && miss[j] === miss[j - 1] + 1) j++;
        queue.push({ f, first: miss[i], n: j - i });
        i = j;
      }
    }
    const need = st.total - st.have, est = await navigator.storage.estimate?.().catch(() => null);
    note(`[predownload] ${ahead.length} files, ${mb(st.total)}${movies ? ' with the movies' : ''}: ${mb(st.have)} here already, ${mb(need)} to come in ${queue.length} answers` +
         `${est?.quota ? `; the site may keep ${mb(est.quota - (est.usage ?? 0))} more` : ''}`);
    if (need > 0 && est?.quota && est.quota - (est.usage ?? 0) < need + ROOM_MARGIN)
      throw new NoRoom(`this browser lets this site keep ${mb(Math.max(0, est.quota - (est.usage ?? 0)))} more, and ${mb(need)} are missing`);
    postMessage({ t: 'progress', ...st });
    // Where each lane is, and when it got there: a download that keeps nothing for STILL_MS says
    // so, every STILL_MS, lane by lane (asking the server, or keeping a block in OPFS).
    const lanes = Array.from({ length: LANES }, () => ({ doing: 'starting', since: Date.now() }));
    const at = (l, doing) => { l.doing = doing; l.since = Date.now(); };
    let keptAt = Date.now(), toldAt = 0;
    tick = setInterval(() => {
      const now = Date.now();
      st.still = Math.floor((now - keptAt) / 1000);
      postMessage({ t: 'progress', ...st });
      if (now - keptAt < STILL_MS || now - toldAt < STILL_MS) return;
      toldAt = now;
      note(`[predownload] nothing kept for ${Math.round((now - keptAt) / 1000)} s (${mb(st.have)} of ${mb(st.total)}): ` +
           lanes.map((l, i) => `lane ${i} ${l.doing} for ${Math.round((now - l.since) / 1000)} s`).join('; ') +
           ((c) => `; the cache: ${c.open} open, ${c.closing} closing${c.opening.length ? `, opening ${c.opening.join(', ')}` : ''}`)(cache.stats()));
    }, TICK_MS);
    let qi = 0;
    const lane = async (l) => {
      while (qi < queue.length && !ac.signal.aborted) {
        const r = queue[qi++];
        st.file = r.f.path;
        at(l, `asking for ${r.f.path} blocks ${r.first}-${r.first + r.n - 1}`);
        await fetchRun({
          f: r.f, first: r.first, n: r.n, signal: ac.signal, note, fault,
          onWait: (w) => { st.waiting = { why: w.why, tries: w.tries, ms: w.ms, at: Date.now() }; },
          onAnswer: (bytes) => { st.wire += bytes; },
          onBlock: async (bi, b) => {
            st.waiting = null;
            at(l, `keeping ${r.f.path} block ${bi}`);
            const kept = await cache.keep(r.f, bi, b);
            keptAt = Date.now();
            at(l, `asking for ${r.f.path} blocks ${bi + 1}-${r.first + r.n - 1}`);
            if (!cache.keeping) throw new NoRoom('no room in this browser for more of the game data');
            if (kept) { st.have += b.length; st.got += b.length; if (isMovie(r.f)) st.movHave += b.length; } else lost += b.length;
          },
        });
      }
    };
    await Promise.all(lanes.map((l) => lane(l).catch((x) => {
      if (!failure && !ac.signal.aborted) { failure = x; ac.abort(x); }
    })));
  } catch (x) { failure = x; }
  clearInterval(tick);
  st.waiting = null; st.still = 0;
  await cache.close();
  if (!failure && lost && !ac.signal.aborted) failure = new Error(`${mb(lost)} of it could not be kept in this browser (the log says which); try again`);
  if (failure) {                       // a stop is no failure: the lanes it ends set none
    const msg = failure instanceof Gone ? 'the game data changed on the server: reload the page' : String(failure?.message ?? failure);
    note(`[predownload] stopped by ${msg}`);
    postMessage({ t: 'error', msg, ...st });
  } else if (ac.signal.aborted) postMessage({ t: 'stopped', ...st });
  else postMessage({ t: 'done', ...st });
}
