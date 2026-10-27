// The I/O worker in the browser: ../host/core/io.mjs over the game data from
// the server, kept in the site's OPFS as it is read, and the game's writes in
// the site's OPFS (http-backend.js, data-cache.js, save-store.js; save: the
// save set's folder there, fresh: emptied first; cache: false keeps no game
// data, freshCache: what it kept emptied first). Every 10 s it notes where the
// data blocks came from, while they still come. { t: 'shutdown' } (the page,
// the game over) makes what the cache kept last and answers { t: 'io-done' }.
import { startIo } from '../host/core/io.mjs';
import { httpBackend } from './http-backend.js';

const note = (s) => postMessage({ t: 'note', s });
onmessage = async (e) => {
  onmessage = null;
  const { memory, ctl, rpc, save, fresh, cache, freshCache } = e.data;
  try {
    const backend = await httpBackend({ note, save, fresh, cache, freshCache });
    let last = '';
    setInterval(() => {
      const s = backend.stats(), now = `${s.fetched} ${s.local ?? 0}`;
      if (now !== last) {
        note(`[data] ${s.fetched} blocks from the server, ${s.local ?? 0} from this browser's copy` +
             `${s.data === 'opfs' ? `, ${s.kept} kept in it (${(s.keptBytes / 1048576).toFixed(0)} MB)${s.keeping ? '' : ', no room for more'}` : ''}; ` +
             `${s.blocks} in memory (${(s.held / 1048576).toFixed(0)} MB); ${s.written} files written (${s.store})` +
             `${s.data === 'opfs' ? `; cache files ${s.open} open, ${s.closed} closed` : ''}`);
      }
      last = now;
    }, 10000);
    onmessage = async (m) => {
      if (m.data?.t !== 'shutdown') return;
      try { await backend.shutdown(); } catch (x) { note(`[data] shutdown: ${x?.message ?? x}`); }
      postMessage({ t: 'io-done' });
    };
    postMessage({ t: 'io-ready' });
    await startIo({ memory, ctl, rpc, backend, note });
  } catch (x) {
    postMessage({ t: 'io-error', msg: String(x?.stack ?? x) });
  }
};
