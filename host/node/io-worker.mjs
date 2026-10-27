// The I/O worker under Node: ../core/io.mjs over the host's directories.
import { parentPort, workerData } from 'node:worker_threads';
import { startIo } from '../core/io.mjs';
import { fsBackend } from './fs-backend.mjs';

// The serve loop waits on the doorbell with Atomics.waitAsync, which does not
// keep a Node worker's event loop alive: without something that does, Node
// ends the worker at its first wait ("unsettled top-level await") and every
// file call after that waits for ever. A page's worker lives until it is
// terminated, so the browser's needs none.
setInterval(() => {}, 2 ** 30);

const { memory, ctl, rpc, mounts } = workerData;
parentPort.postMessage({ t: 'io-ready' });
await startIo({ memory, ctl, rpc, backend: fsBackend(mounts), note: (s) => parentPort.postMessage({ t: 'note', s }) });
