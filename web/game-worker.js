// A game thread in the browser: ../host/core/thread.mjs in a module Worker.
import { runThread } from '../host/core/thread.mjs';

onmessage = (e) => {
  onmessage = null;
  runThread({ ...e.data, post: (m) => postMessage(m) }).catch((x) => postMessage({ t: 'trap', tid: -1, msg: String(x), stack: x?.stack }));
};
