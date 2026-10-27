// The virtual LAN's worker in the page: ../host/core/net.mjs, its WebSocket to the
// relay. A worker, not the page: a page in a background tab is throttled, and in
// lockstep play everyone waits for the slowest.
import { runNet } from '../host/core/net.mjs';

onmessage = (e) => {
  const { memory, ptr, url, hello } = e.data;
  runNet({ memory, ptr, url, hello, status: (s) => postMessage({ t: 'net', s }), log: (s) => postMessage({ t: 'log', s }) });
};
