// The page's mouse and keyboard into the game: events into wasi/screen.c's
// input ring (shared memory; the game's pump reads it), as the native
// presenter turns SDL's events into the window messages a game gets.
//   ring: Int32 words 0 head (the page's), 1 tail (the pump's), then 256
//   events of 4 words: { 1, message, x, y } a mouse message at game pixels,
//   { 2, down, vk, scan } a key, { 3, delta, x, y } the wheel (WHEEL_DELTA units, + away).
// Keys: the browser's KeyboardEvent.code to a Windows virtual key and a set-1
// scan code, the same table as runtime/win32hle/screen.c's vk_of and scan_of.
// Keys are taken from the whole window (the page is the game's: no need for the
// canvas to have the focus, which a page loaded without a click does not give
// it), except those meant for a text field. Keys held when the window loses
// the focus are let go, or they would stay down. Cmd (Meta: the Windows key
// elsewhere) is the browser's and the system's: a key pressed with it is theirs
// (Cmd+C, Cmd+R, Cmd+Tab), never the game's, and its going down lets go of the
// keys held, as macOS sends no key-up for a key let go while Cmd is down
// (nfsu2-web does the same). The page takes the keys that
// are its own first (onKey(e, down) -> true: Alt+Enter, Shift+F11, the menu's keys:
// settings.js), and they never reach the game.
// The mouse, kept in the picture as cnc-ddraw keeps it (its wndproc.c and
// mouse.c), by the browser's Pointer Lock: full screen always, in a window in
// a battle only (presenter.battle(): the game has captured the mouse). A
// window's menus have the mouse as it is, the game's, its clicks the game's
// at once: a battle's menu opening lets the mouse go, the battle coming back
// asks for it (Resume's click is the gesture the browser wants; it keeps one
// for a second and a quarter after an Escape, so it asks again a few times).
// - Kept, the page moves a cursor of its own by the mouse's moves (times
//   sensitivity()), held inside the picture, so it reaches an edge and stays
//   there (the map scrolls; the presenter draws it where the game has its
//   menus' cursor).
// - Let go (Ctrl+Tab or right Alt + right Ctrl, the page's menu, another
//   window or tab, Escape) where it is to be kept, the mouse is not the
//   game's: no moves, no clicks.
//   A click on the picture keeps it again, the game's cursor where it was
//   clicked (beside the picture: in its middle), and is not the game's.
// - Escape: full screen, its keys locked (fullscreen.js), it is the game's
//   and the mouse stays. In a window the browser takes it to let the mouse go
//   and the page gets only its key up: a key up of Escape with no key down,
//   just after the mouse was let go, gives the game the Escape (its menu).
// - Where the browser will not keep the mouse (a click that did not get it:
//   the lock refused, headless Chrome, a second of Chrome's after an Escape)
//   that click goes to the game after all, and until a click gets it the
//   mouse is the game's as it moves: the mouse that leaves the canvas leaves
//   the game's cursor at the edge it crossed, so the map goes on scrolling.
// The window losing the focus moves the game's cursor off an edge, and the
// map stops.
const WM = { MOVE: 0x200, LDOWN: 0x201, LUP: 0x202, RDOWN: 0x204, RUP: 0x205, MDOWN: 0x207, MUP: 0x208 };

const KEYS = (() => {
  const t = {};
  const letters = 'QWERTYUIOP', row2 = 'ASDFGHJKL', row3 = 'ZXCVBNM';
  [...letters].forEach((c, i) => (t['Key' + c] = [c.charCodeAt(0), 16 + i]));
  [...row2].forEach((c, i) => (t['Key' + c] = [c.charCodeAt(0), 30 + i]));
  [...row3].forEach((c, i) => (t['Key' + c] = [c.charCodeAt(0), 44 + i]));
  for (let d = 1; d <= 9; d++) t['Digit' + d] = [48 + d, 1 + d];
  t.Digit0 = [48, 11];
  for (let f = 1; f <= 10; f++) t['F' + f] = [0x6f + f, 58 + f];
  t.F11 = [0x7a, 87]; t.F12 = [0x7b, 88];
  for (let d = 1; d <= 9; d++) t['Numpad' + d] = [0x60 + d, 0];
  Object.assign(t, {
    Numpad0: [0x60, 0], Enter: [0x0d, 28], NumpadEnter: [0x0d, 0], Escape: [0x1b, 1], Backspace: [0x08, 14], Tab: [0x09, 15],
    Space: [0x20, 57], ShiftLeft: [0x10, 42], ShiftRight: [0x10, 54], ControlLeft: [0x11, 29], ControlRight: [0x11, 0],
    AltLeft: [0x12, 56], AltRight: [0x12, 0], Pause: [0x13, 0], CapsLock: [0x14, 58], PageUp: [0x21, 73], PageDown: [0x22, 81],
    End: [0x23, 79], Home: [0x24, 71], ArrowLeft: [0x25, 75], ArrowUp: [0x26, 72], ArrowRight: [0x27, 77], ArrowDown: [0x28, 80],
    Insert: [0x2d, 82], Delete: [0x2e, 83], NumpadMultiply: [0x6a, 0], NumpadAdd: [0x6b, 0], NumpadSubtract: [0x6d, 0],
    NumpadDecimal: [0x6e, 0], NumpadDivide: [0x6f, 0], Semicolon: [0xba, 39], Equal: [0xbb, 13], Comma: [0xbc, 51],
    Minus: [0xbd, 12], Period: [0xbe, 52], Slash: [0xbf, 53], Backquote: [0xc0, 41], BracketLeft: [0xdb, 26],
    Backslash: [0xdc, 43], BracketRight: [0xdd, 27], Quote: [0xde, 40],
  });
  return t;
})();

export function startInput(canvas, memory, ptr, presenter, { onKey = () => false, sensitivity = () => 1 } = {}) {
  let ring = null;
  const view = () => { if (!ring || ring.buffer !== memory.buffer) ring = new Int32Array(memory.buffer, ptr, 2 + 256 * 4); };
  function push(type, a, b, c) {
    view();
    const head = Atomics.load(ring, 0), tail = Atomics.load(ring, 1);
    if (head - tail >= 256) return false;                 // the game is not pumping: drop it
    const o = 2 + ((head >>> 0) % 256) * 4;
    ring[o] = type; ring[o + 1] = a; ring[o + 2] = b; ring[o + 3] = c;
    Atomics.store(ring, 0, head + 1);
    return true;
  }
  const at = (e) => { const r = canvas.getBoundingClientRect(); return presenter.gameAt(e.clientX - r.left, e.clientY - r.top); };
  const locked = () => document.pointerLockElement === canvas;
  let last = null, vx = 0, vy = 0;              // the last point sent; the locked mouse's cursor (game pixels)
  let free = false;                              // the last try to keep the mouse failed: it is the game's as it moves
  let pending = null;                            // the click that asked for the lock: { button, p, up }
  let eatUp = -1;                                // its button's release, when it comes after the lock
  let lostAt = -1e9;                             // when the lock went
  const send = (msg, p) => { if (p) { last = p; push(1, msg, p[0], p[1]); } };
  function where(e) {                            // the event's game pixel: the page's cursor, moved, while locked
    if (!locked()) return at(e);
    const [w, h] = presenter.size();
    if (!w) return null;
    const [sx, sy] = presenter.scale(), k = sensitivity();
    vx = Math.max(0, Math.min(w - 1, vx + (e.movementX || 0) * sx * k));
    vy = Math.max(0, Math.min(h - 1, vy + (e.movementY || 0) * sy * k));
    presenter.softCursor([Math.floor(vx), Math.floor(vy)]);
    return [Math.floor(vx), Math.floor(vy)];
  }
  const mouse = (msg, e) => send(msg, where(e));
  const DOWN = [WM.LDOWN, WM.MDOWN, WM.RDOWN], UP = [WM.LUP, WM.MUP, WM.RUP];
  const full = () => !!document.fullscreenElement;
  const menus = () => !full() && !presenter.battle();      // a window's menus: the mouse as it is, the game's
  const theGames = () => locked() || free || menus();      // whether the mouse's moves and clicks are the game's
  function refused() {                           // the click that asked goes to the game after all
    free = true;
    const c = pending;
    pending = null;
    if (!c) return;
    send(WM.MOVE, c.p); send(DOWN[c.button], c.p);
    if (c.up) send(UP[c.button], c.p);
  }
  function ask(tries) {                          // not a click's: refused, the mouse stays unkept until a click
    const again = () => {
      if (tries > 1 && !locked() && !menus() && navigator.userActivation?.isActive !== false) setTimeout(() => ask(tries - 1), 400);
    };
    if (!canvas.requestPointerLock || locked()) return;
    try { const q = canvas.requestPointerLock(); q?.catch?.(again); } catch { again(); }
  }
  let wasBattle = false, wasFull = false;
  (function watch() {                            // a window: the lock follows the battle
    const b = presenter.battle(), f = full();
    if (!f && !b && locked()) document.exitPointerLock();   // a menu: the mouse as it is (the page let it go: no gesture to keep it again)
    if (!f && b && !locked() && ((!wasBattle && presenter.size()[0]) || wasFull)) ask(4);   // the battle (again), or full screen left in it
    wasBattle = b; wasFull = f;
    requestAnimationFrame(watch);
  })();
  function keep(e) {                             // a click on the canvas, the mouse not kept: ask for it
    const r = canvas.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top, [w, h] = presenter.size();
    const p = presenter.inPicture(cx, cy) ? presenter.gameAt(cx, cy) : (w ? [w >> 1, h >> 1] : null);
    if (!free) pending = { button: e.button, p, up: false };
    if (!canvas.requestPointerLock) return refused();
    try { const q = canvas.requestPointerLock(); q?.catch?.(() => { if (pending && !locked()) refused(); }); }
    catch { if (pending) refused(); }
  }
  document.addEventListener('pointerlockerror', () => { if (pending && !locked()) refused(); });
  document.addEventListener('pointerlockchange', () => {
    if (locked()) {                              // from the click that asked, else where the game's cursor was
      free = false;
      if (pending?.p) send(WM.MOVE, pending.p);
      if (pending && !pending.up) eatUp = pending.button;
      pending = null;
      const [w, h] = presenter.size();
      [vx, vy] = last ?? [w >> 1, h >> 1];
      presenter.softCursor([Math.floor(vx), Math.floor(vy)]);
    } else { presenter.softCursor(null); lostAt = performance.now(); }
  });

  canvas.addEventListener('pointermove', (e) => { if (theGames()) mouse(WM.MOVE, e); });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button > 2) return;
    canvas.focus();
    e.preventDefault();
    if (locked()) { mouse(WM.MOVE, e); mouse(DOWN[e.button], e); return; }
    if (menus()) { canvas.setPointerCapture(e.pointerId); mouse(WM.MOVE, e); mouse(DOWN[e.button], e); return; }
    const wasFree = free;
    keep(e);
    if (!wasFree) return;                        // the click that asks is not the game's (refused: sent already)
    canvas.setPointerCapture(e.pointerId);
    mouse(WM.MOVE, e); mouse(DOWN[e.button], e);
  });
  canvas.addEventListener('pointerup', (e) => {
    if (e.button > 2) return;
    e.preventDefault();
    if (eatUp === e.button) { eatUp = -1; return; }
    if (pending && pending.button === e.button) { pending.up = true; return; }
    if (theGames()) mouse(UP[e.button], e);
  });
  canvas.addEventListener('pointerleave', (e) => { if (free && !locked()) mouse(WM.MOVE, e); });   // at the edge it crossed
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // The wheel, as WM_MOUSEWHEEL where the mouse is the game's: the game's main window takes a message
  // for a row of the sidebar (SidebarUp or SidebarDown, 0x7775C0), whatever its delta, so one goes for
  // each 120 gathered (WHEEL_DELTA: a notch, a line; a trackpad's 100 pixels, as nfsu2-web counts them).
  let wheelAcc = 0;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!theGames()) return;
    const lines = e.deltaMode === 1 ? e.deltaY : e.deltaMode === 2 ? e.deltaY * 3 : e.deltaY / 100, add = -lines * 120;
    if (Math.sign(add) !== Math.sign(wheelAcc)) wheelAcc = 0;   // turned the other way: afresh
    wheelAcc += add;
    const [w, h] = presenter.size(), p = last ?? [w >> 1, h >> 1];
    for (; Math.abs(wheelAcc) >= 120; wheelAcc -= Math.sign(wheelAcc) * 120) push(3, Math.sign(wheelAcc) * 120, p[0], p[1]);
  }, { passive: false });
  window.addEventListener('blur', () => {        // off an edge: the map stops
    const [w, h] = presenter.size();
    if (!last || !w || locked()) return;
    const [x, y] = last, nx = Math.max(2, Math.min(w - 3, x)), ny = Math.max(2, Math.min(h - 3, y));
    if (nx !== x || ny !== y) send(WM.MOVE, [nx, ny]);
  });

  const held = new Set();
  let escDown = false;                           // the page saw Escape go down (the browser kept none of it)
  const letGo = () => { for (const c of held) push(2, 0, KEYS[c][0], KEYS[c][1]); held.clear(); };
  const key = (down, e) => {
    if (e.code === 'MetaLeft' || e.code === 'MetaRight' || e.key === 'Meta') { if (down) letGo(); return; }
    if (e.metaKey && down) return;                 // the browser's shortcut, as it is
    if (e.code === 'Escape') {
      if (down) escDown = true;
      else if (!escDown && performance.now() - lostAt < 1500 && !locked()) {   // the browser's: it let the mouse go
        e.preventDefault();
        push(2, 1, KEYS.Escape[0], KEYS.Escape[1]); push(2, 0, KEYS.Escape[0], KEYS.Escape[1]);
        return;
      } else escDown = false;
    }
    if (onKey(e, down)) { e.preventDefault(); return; }
    const k = KEYS[e.code];
    if (!k) return;
    if (down) held.add(e.code); else held.delete(e.code);
    push(2, down ? 1 : 0, k[0], k[1]);
    e.preventDefault();
  };
  const forText = (e) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  window.addEventListener('keydown', (e) => { if (!forText(e)) key(true, e); });
  window.addEventListener('keyup', (e) => { if (!forText(e)) key(false, e); });
  window.addEventListener('blur', letGo);
  // last: the last point sent; free: whether the mouse is the game's unkept (tests)
  return { push, last: () => last, free: () => free };
}
