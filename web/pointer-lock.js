// The mouse kept in the picture (Pointer Lock), asked for the same way by each
// place that asks (fullscreen.js, input.js, settings.js), with the player's
// choice of raw mouse input (the menu's 原始鼠标输入, settings.js rawMouse):
// unadjustedMovement, the mouse's own counts with no acceleration of the
// system's (Chrome: Windows, macOS 10.15.1 and later, ChromeOS; Linux, by the
// reports, not). Where the browser refuses it as unsupported (NotSupportedError)
// the lock is asked again without it, and for the rest of the session it is not
// asked with it again. The choice counts from the next lock (the menu lets the
// mouse go and keeps it again as it closes).
//   setRawMouse(on); rawMouse() -> 'off' | 'on' | 'no' (on, but this browser will not)
//   lockPointer(el) -> the request's promise (undefined where the browser gives none)
//   rawTrying() -> true while a request with it, or the one without it after its
//                  refusal, is unsettled: a pointerlockerror then is not the lock's
//                  refusal (the caller's catch says so)
let wanted = false, refused = false, trying = 0;

export function setRawMouse(on) { wanted = !!on; }
export function rawMouse() { return !wanted ? 'off' : refused ? 'no' : 'on'; }
export const rawTrying = () => trying > 0;

export function lockPointer(el) {
  if (!el?.requestPointerLock) return undefined;
  if (!wanted || refused) return el.requestPointerLock();
  trying++;
  let p;
  try { p = el.requestPointerLock({ unadjustedMovement: true }); } catch (x) { trying--; throw x; }
  if (!p?.then) { trying--; return p; }        // no promise: the option not known either, the lock as before
  return p.then(() => { trying--; }, (x) => {
    if (x?.name !== 'NotSupportedError') { trying--; throw x; }
    refused = true;                            // the lock without it; its own error, when it comes, is the caller's
    let q;
    try { q = el.requestPointerLock(); } catch (y) { trying--; throw y; }
    if (!q?.then) { trying--; return q; }
    return q.finally(() => { trying--; });
  });
}
