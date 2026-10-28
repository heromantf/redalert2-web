// The page's own settings, its menu and its stats: what the Steam release's
// wrappers let a player change (DDrawCompat's configuration and stats
// overlays, cnc-ddraw's scaling, mouse and screenshot), and nothing of the
// remaster's (its F10 menu, the bars' blur, CRT, the FPS display).
//   Shift+F11      the menu (DDrawCompat's ConfigHotKey); Escape or Shift+F11
//                  closes it, and while it is open the keys are the menu's
//   Shift+F12      the stats in a corner (DDrawCompat's StatsHotKey)
//   PrintScreen    a screenshot: the frame at the game's own size, a PNG
//                  downloaded (cnc-ddraw's keyscreenshot)
// The settings (localStorage "ra2web.settings"): scale (presenter.js's
// SCALES' id), params (each filter's blur or lobes), sensitivity (the locked
// mouse's speed, in percent: later DDrawCompat's MouseSensitivity, not in the Steam release's 0.5.4), stats,
// rawMouse (the locked mouse's raw input, no acceleration of the system's: pointer-lock.js).
// The menu also has the page's log, downloaded or copied (logs: page-log.js), and the stats
// a line for online play (latency: online.js latencyText).
// startMenu({ settings, presenter, screen, audio, memory, ctl, latency, logs, log })
//   presenter, audio, memory, ctl, latency: getters (they come as the game starts)
//   -> { toggle(), close(), isOpen(), toggleStats(), screenshot() }
import { CTL_TIMER_LATE } from '../host/proto.mjs';
import { lockPointer, rawMouse, setRawMouse } from './pointer-lock.js';
import { SCALES } from './presenter.js';

const KEY = 'ra2web.settings';
const DEFAULTS = { scale: 'bilinear', params: {}, sensitivity: 100, stats: false, rawMouse: false };
const SCALE_NAMES = {
  bilinear: '双线性（默认）', point: '最近邻（Steam 版的设置）', integer: '整数倍', bicubic: '双三次', lanczos: 'Lanczos', spline: 'Spline',
  'cnc-bilinear': '双线性', catmull: 'Catmull-Rom（cnc-ddraw 默认）', lanczos2: 'Lanczos2-sharp', xbr: 'xBR-lv2',
};
const PARAM_NAMES = { blur: '模糊', lobes: '瓣数' };
// what an older page kept: the remaster's names
const OLD = { sharp: ['bilinear', 0], smooth: ['bilinear', 100], crt: ['bilinear', 0], nearest: ['point'] };
const GAME_FRAME_VA = 0xA8ED84;               // the game's frame count (out/lift/gen/recomp_target.h RA2_GAME_FRAME_VA)

export function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { /* the defaults */ }
  const out = { ...DEFAULTS, ...s, params: { ...(s.params ?? {}) } };
  delete out.bars;
  if (OLD[out.scale]) { const [id, v] = OLD[out.scale]; out.scale = id; if (v !== undefined) out.params[id] = v; }
  if (!SCALES.some((m) => m.id === out.scale)) out.scale = DEFAULTS.scale;
  return out;
}
const save = (s) => localStorage.setItem(KEY, JSON.stringify(s));

const CSS = `
  .ra2-menu { position: absolute; inset: 0 0 22px 0; display: flex; align-items: center; justify-content: center; z-index: 5;
              background: rgba(0,0,0,.55); font: 14px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #d8dbe2; }
  .ra2-menu[hidden] { display: none; }
  .ra2-menu .box { width: min(440px, 92vw); padding: 22px 24px; background: rgba(20,23,31,.96); border: 1px solid #2c3242; border-radius: 10px; }
  .ra2-menu h2 { margin: 0 0 14px; font-size: 18px; font-weight: 600; color: #f0f2f6; }
  .ra2-menu .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 10px 0; }
  .ra2-menu .row[hidden] { display: none; }
  .ra2-menu select, .ra2-menu button { font: inherit; padding: 5px 10px; border-radius: 6px; border: 1px solid #3a4258; background: #252b3a; color: #e6e8ee; }
  .ra2-menu button { cursor: pointer; }
  .ra2-menu input[type=range] { width: 160px; }
  .ra2-menu .keys { margin-top: 14px; color: #8b92a5; font-size: 12.5px; line-height: 1.6; }
  .ra2-stats { position: absolute; top: 8px; right: 8px; z-index: 4; padding: 6px 9px; background: rgba(0,0,0,.6); color: #cfe3cf;
               font: 12px ui-monospace, monospace; white-space: pre; pointer-events: none; border-radius: 4px; }
  .ra2-stats[hidden] { display: none; }`;

export function startMenu({ settings, presenter, screen, audio = () => null, memory = () => null, ctl = () => null, latency = () => '',
                           logs = null, log = () => {} }) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const menu = document.createElement('div'); menu.className = 'ra2-menu'; menu.hidden = true;
  menu.innerHTML = `<div class="box">
    <h2>设置</h2>
    <div class="row"><span>缩放方式</span><select data-k="scale">${['DDrawCompat', 'cnc-ddraw'].map((from) =>
      `<optgroup label="${from}">${SCALES.filter((m) => m.from === from).map((m) => `<option value="${m.id}">${SCALE_NAMES[m.id]}</option>`).join('')}</optgroup>`).join('')}</select></div>
    <div class="row" data-r="param"><span data-v="param-name"></span><span><input type="range" data-k="param"> <b data-v="param"></b></span></div>
    <div class="row"><span>鼠标灵敏度（全屏锁定时）</span><span><input type="range" min="50" max="200" step="10" data-k="sensitivity"> <b data-v="sensitivity"></b></span></div>
    <div class="row"><span>原始鼠标输入（全屏锁定时，不经系统加速）</span><span><b data-v="rawMouse"></b> <input type="checkbox" data-k="rawMouse"></span></div>
    <div class="row"><span>显示统计</span><input type="checkbox" data-k="stats"></div>
    <div class="row"><button data-a="full">全屏 / 退出全屏</button><button data-a="shot">截图</button><button data-a="close">关闭</button></div>
    <div class="row"><span>日志</span><span><button data-a="logsave">下载</button><button data-a="logcopy">复制</button> <b data-v="log"></b></span></div>
    <div class="keys">Shift+F11 设置 · Alt+Enter 全屏 · Ctrl+Tab 解锁鼠标（不退出全屏）· Shift+F12 统计 · PrintScreen 截图 · 长按 Esc 退出全屏</div>
  </div>`;
  setRawMouse(settings.rawMouse);
  const stats = document.createElement('div'); stats.className = 'ra2-stats'; stats.hidden = !settings.stats;
  document.body.append(menu, stats);
  const $ = (sel) => menu.querySelector(sel);

  const scaleNow = () => SCALES.find((m) => m.id === settings.scale);
  const paramNow = () => { const p = scaleNow().param; return p ? settings.params[settings.scale] ?? p.def : undefined; };
  const apply = () => {
    presenter()?.setScale(settings.scale, paramNow());
    stats.hidden = !settings.stats;
    save(settings);
  };
  const showParam = () => {                    // DDrawCompat's: a filter's blur or lobes
    const p = scaleNow().param, r = $('[data-k=param]');
    $('[data-r=param]').hidden = !p;
    if (!p) return;
    $('[data-v=param-name]').textContent = PARAM_NAMES[p.name];
    Object.assign(r, { min: p.min, max: p.max, step: p.step });
    r.value = paramNow();
    $('[data-v=param]').textContent = p.name === 'blur' ? `${paramNow()}%` : `${paramNow()}`;
  };
  const show = () => {
    $('[data-k=scale]').value = settings.scale;
    showParam();
    $('[data-k=sensitivity]').value = settings.sensitivity;
    $('[data-v=sensitivity]').textContent = `${settings.sensitivity}%`;
    $('[data-k=stats]').checked = settings.stats;
    $('[data-k=rawMouse]').checked = settings.rawMouse;
    $('[data-v=rawMouse]').textContent = rawMouse() === 'no' ? '这个浏览器不支持，用的是普通方式' : '';
  };
  $('[data-k=scale]').onchange = (e) => { settings.scale = e.target.value; showParam(); apply(); };
  $('[data-k=param]').oninput = (e) => { settings.params[settings.scale] = +e.target.value; showParam(); apply(); };
  $('[data-k=sensitivity]').oninput = (e) => { settings.sensitivity = +e.target.value; $('[data-v=sensitivity]').textContent = `${settings.sensitivity}%`; apply(); };
  $('[data-k=stats]').onchange = (e) => { settings.stats = e.target.checked; apply(); };
  $('[data-k=rawMouse]').onchange = (e) => { settings.rawMouse = e.target.checked; setRawMouse(settings.rawMouse); apply(); };   // from the next lock: the menu's closing
  $('[data-a=full]').onclick = () => screen.toggle();
  $('[data-a=shot]').onclick = () => screenshot();
  $('[data-a=close]').onclick = () => close();
  $('[data-a=logsave]').onclick = () => logs?.download();                // page-log.js: the whole of the session's
  $('[data-a=logcopy]').onclick = async () => { $('[data-v=log]').textContent = (await logs?.copy()) ? '已复制' : '复制不了，用下载'; };

  let wasLocked = false;
  function open() {
    show();
    wasLocked = !!document.pointerLockElement;
    if (wasLocked) document.exitPointerLock();          // the mouse for the menu
    menu.hidden = false;
    log('[menu] open');
  }
  function close() {
    menu.hidden = true;
    if (wasLocked) lockPointer(document.querySelector('canvas'))?.catch?.(() => {});   // as it was, in a window too
    log('[menu] closed');
  }
  async function screenshot() {
    const blob = await presenter()?.screenshot();
    if (!blob) return;
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const name = `ra2-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    const [w, h] = presenter().size();
    log(`[screen] screenshot ${name} (${w}x${h})`);
  }

  // the stats, twice a second
  let lastFrame = null, lastT = 0;
  setInterval(() => {
    if (stats.hidden) return;
    const p = presenter(), m = memory(), c = ctl(), a = audio(), now = performance.now();
    let game = '';
    if (m) {
      const f = new DataView(m.buffer).getUint32(GAME_FRAME_VA, true);
      if (lastFrame !== null && now > lastT) game = `${Math.round((f - lastFrame) * 1000 / (now - lastT))} 帧/秒（第 ${f} 帧）`;
      lastFrame = f; lastT = now;
    }
    const late = c ? Atomics.load(c, CTL_TIMER_LATE) / 1000 : 0, [w, h] = p ? p.size() : [0, 0];
    stats.textContent = [
      `画面   ${p ? `${p.fps()} fps · ${w}x${h} · ${SCALE_NAMES[p.scaleName()]}${p.scaleParam() !== undefined ? `（${p.scaleParam()}）` : ''}` : '还没有'}`,
      `游戏   ${game || '—'}`,
      `定时器 ${c ? (late ? `粗（晚醒 ${late.toFixed(1)} ms，短睡眠空转）` : '精细') : '—'}`,
      `声音   ${a ? `${a.state() === 'running' ? '播放中' : a.state()} · 欠载 ${a.underruns()} 次` : '—'}`,
      `鼠标   ${document.pointerLockElement ? `锁定（灵敏度 ${settings.sensitivity}%）` : '未锁定'}`,
      `联机   ${latency() || '—'}`,
    ].join('\n');
  }, 500);

  return {
    toggle: () => (menu.hidden ? open() : close()),
    close, isOpen: () => !menu.hidden, screenshot,
    toggleStats() { settings.stats = !settings.stats; apply(); },
  };
}
