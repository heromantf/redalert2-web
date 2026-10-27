// The page's timer probe (../host/core/timer-probe.mjs): { ctl, grid } in, { t: 'note', s } out.
import { runTimerProbe } from '../host/core/timer-probe.mjs';

onmessage = (e) => runTimerProbe({ ...e.data, note: (s) => postMessage({ t: 'note', s }) });
