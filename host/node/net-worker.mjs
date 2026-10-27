// The virtual LAN's worker under Node: ../core/net.mjs, its WebSocket to the relay.
import { parentPort, workerData } from 'node:worker_threads';
import { runNet } from '../core/net.mjs';

// Atomics.waitAsync does not keep a Node worker alive (as io-worker.mjs says)
setInterval(() => {}, 2 ** 30);

const { memory, ptr, url, hello } = workerData;
runNet({ memory, ptr, url, hello, status: (s) => parentPort.postMessage({ t: 'net', s }), log: (s) => parentPort.postMessage({ t: 'note', s }) });
