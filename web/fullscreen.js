// Full screen for the game, as a PC game has it: the page full screen, every
// key the game's (Keyboard Lock: Escape, Ctrl+number, Alt and the browser's own
// shortcuts reach the game; Escape held leaves, the browser says so) and the
// mouse kept in the picture (Pointer Lock: the map scrolls at its edges, and
// input.js moves a cursor of its own, which the presenter draws). Alt+Enter
// toggles it (input.js), as cnc-ddraw does. In a window too a click keeps the
// mouse (input.js), the keys not locked. Where the browser has no Keyboard Lock (Safari,
// Firefox) the page is full screen all the same and Escape leaves it.
//   gameScreen({ root, canvas, log }) -> { enter(), exit(), toggle(), on() }   (enter, toggle: within a click or a key)
export function gameScreen({ root = document.documentElement, canvas, log = () => {} }) {
  const lockMouse = () => {
    if (document.pointerLockElement === canvas) return;
    try { const p = canvas.requestPointerLock?.(); p?.catch?.((x) => log(`[screen] the mouse not locked: ${x?.message ?? x}`)); }
    catch (x) { log(`[screen] the mouse not locked: ${x?.message ?? x}`); }
  };
  async function enter() {
    lockMouse();                 // first, while the click or key still counts as the user's
    if (!document.fullscreenElement) {
      try { await root.requestFullscreen({ navigationUI: 'hide' }); }
      catch (x) { log(`[screen] full screen refused: ${x?.message ?? x}`); return false; }
    }
    try { await navigator.keyboard?.lock?.(); } catch (x) { log(`[screen] the keys not locked: ${x?.message ?? x}`); }
    lockMouse();
    return true;
  }
  async function exit() {
    navigator.keyboard?.unlock?.();
    if (document.pointerLockElement) document.exitPointerLock();
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  }
  document.addEventListener('fullscreenchange', () => {
    const on = !!document.fullscreenElement;
    if (!on) { navigator.keyboard?.unlock?.(); if (document.pointerLockElement) document.exitPointerLock(); }
    log(`[screen] ${on ? `full screen${navigator.keyboard?.lock ? ', the keys locked (hold Esc to leave)' : ''}` : 'windowed'}`);
  });
  document.addEventListener('pointerlockchange', () => log(`[screen] the mouse ${document.pointerLockElement === canvas ? 'locked in the picture' : 'free'}`));
  return { enter, exit, toggle: () => (document.fullscreenElement ? exit() : enter()), on: () => !!document.fullscreenElement };
}
