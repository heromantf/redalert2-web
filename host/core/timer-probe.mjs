// How late a short timed wait wakes, measured all along by a thread of its own
// and kept in ctl[CTL_TIMER_LATE] (µs) for the game threads' sleeps
// (thread.mjs). Chrome on Windows wakes an Atomics.wait on the OS timer, which
// runs at 1 ms or at 15.6 ms (nfsu2-web measured a 1 ms wait at 15.5 ms there);
// on this Mac a short wait wakes about 0.5 ms late, now and then 12 ms when the
// machine is busy (a page loading). A 1 ms wait every ~10 ms: a coarse timer is
// one whose latest second's waits woke late at the median, not one late wait;
// then the figure is that second's worst (a sleep must not run past its end),
// else 0. So it goes up within a second and down in about one. After nfsu2-web's timer probe (runtime/win32_ext.c; MIT, see
// ../../NOTICE.md). grid: RA2WEB_TIMER_MS's (tests), every wait ended on it.
// note(s): a line once the timer turns coarse or fine.
import { CTL_SLEEP, CTL_TIMER_LATE } from '../proto.mjs';

export const COARSE_MS = 3;          // later than this: the sleeps keep to their time by spinning (thread.mjs)

export function runTimerProbe({ ctl: ctlBuf, grid = 0, note = () => {} }) {
  const ctl = ctlBuf instanceof Int32Array ? ctlBuf : new Int32Array(ctlBuf), T0 = performance.timeOrigin, seen = [];
  const wait = (ms) => {
    const now = performance.now();
    Atomics.wait(ctl, CTL_SLEEP, 0, grid ? Math.ceil((T0 + now + ms) / grid) * grid - (T0 + now) : ms);
  };
  let coarse = false;
  for (;;) {
    const t0 = performance.now();
    wait(1);
    const t1 = performance.now();
    seen.push([t1, t1 - t0 - 1]);
    while (seen.length > 1 && t1 - seen[0][0] > 1000) seen.shift();
    const lates = seen.map((s) => s[1]).sort((a, b) => a - b), median = lates[lates.length >> 1], late = lates[lates.length - 1];
    const now = median > COARSE_MS;
    Atomics.store(ctl, CTL_TIMER_LATE, now ? Math.round(Math.max(late, COARSE_MS + 0.001) * 1000) : 0);
    if (now !== coarse) {
      coarse = now;
      note(coarse ? `[timer] coarse: a 1 ms wait wakes ${median.toFixed(1)} ms late (up to ${late.toFixed(1)}); the game's short sleeps keep to their time by spinning`
                  : `[timer] fine again (${median.toFixed(1)} ms late)`);
    }
    wait(9);
  }
}
