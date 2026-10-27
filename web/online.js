// Online play from the page: the relay's address and the player's name (kept in
// localStorage: ra2web.relay, ra2web.name; this browser's own id ra2web.client),
// one page of a browser online at a time (a Web Lock, the relay checks the id too),
// and the network worker (net-worker.js: ../host/core/net.mjs) once the game has
// its mailbox (wasi/net.c, registered as kind 4).
//   onlineSettings() -> { relay, name, client }; saveOnline({ relay, name })
//   claimOnline() -> true if this page may play online (it then holds the lock until it closes)
//   startNet({ memory, ptr, url, hello, onStatus, log }) -> the worker
//   onlineData([files]) -> { ready, missing }: this browser keeps all the game data online play needs
//   netText(status) -> a line for the page, in Chinese
import { scanKept } from './data-cache.js';
import { aheadFiles, manifestFiles } from './game-files.js';

export const NAME_RE = /^[A-Za-z0-9 _-]{1,16}$/;

export function onlineSettings() {
  let client = localStorage.getItem('ra2web.client');
  if (!client) localStorage.setItem('ra2web.client', (client = crypto.randomUUID()));
  let name = localStorage.getItem('ra2web.name');
  if (!name || !NAME_RE.test(name)) name = `Player${Math.floor(100 + Math.random() * 900)}`;
  return { relay: localStorage.getItem('ra2web.relay') ?? '', name, client };
}
export function saveOnline({ relay, name }) {
  localStorage.setItem('ra2web.relay', relay);
  if (NAME_RE.test(name)) localStorage.setItem('ra2web.name', name);
}

export function claimOnline() {
  if (!navigator.locks) return Promise.resolve(true);
  return new Promise((res) => navigator.locks.request('ra2web-online', { ifAvailable: true }, (lock) => {
    res(!!lock);
    return lock ? new Promise(() => {}) : null;     // held until the page closes
  }));
}

export function startNet({ memory, ptr, url, hello, onStatus = () => {}, log = () => {} }) {
  const w = new Worker(new URL('./net-worker.js', import.meta.url), { type: 'module', name: 'net' });
  w.onmessage = (e) => (e.data.t === 'net' ? onStatus(e.data.s) : log(e.data.s));
  w.onerror = (e) => log(`[net] worker: ${e.message}`);
  w.postMessage({ memory, ptr, url, hello });
  return w;
}

// The game data a page must keep before it plays online: all of it but the
// movies (game-files.js aheadFiles). A player reading as he plays holds up
// every other player (lockstep), loading the map and in the battle: measured
// (tools/lan/pair.sh, Bob in a fresh Chrome, web/server.mjs --log-data), he
// fetched ra2.mix and ra2md.mix as the map loaded, langmd.mix and thememd.mix
// in the battle, and of the movies only movmd03.mix's index, in the menus.
export async function onlineData(files) {
  const need = aheadFiles(files ?? (await manifestFiles()), { movies: false });
  const total = need.reduce((a, f) => a + f.size, 0), { have } = await scanKept(need);
  return { ready: have >= total, missing: Math.max(0, total - have) };
}

const WHY = { name: '这个名字已经有人在用了，换一个', client: '这个浏览器已经有一个页面在联机', version: '游戏版本和服务器上其他玩家的不同',
              full: '服务器满了', bad: '名字或服务器地址不对' };
export function netText(s) {
  if (!s) return '';
  if (s.state === 'connecting') return '联机：连接中…';
  if (s.state === 'joined') return `联机：${s.ip ?? ''}${s.peers ? ` · ${s.peers.length} 人在线（${s.peers.map((p) => p.name).join('、')}）` : ''}`;
  if (s.state === 'dropped') return `联机：断线了，${s.retryMs / 1000} 秒后重连`;
  if (s.state === 'refused') return `联机被拒：${WHY[s.why] ?? s.why}`;
  if (s.state === 'busy') return `联机：${WHY.client}，这个页面不联机`;
  if (s.state === 'nodata') return `联机：要先在开始界面下载完游戏数据（不含过场动画${s.missing ? `，还差 ${Math.ceil(s.missing / 1048576)} MB` : ''}），这个页面不联机`;
  return '';
}
