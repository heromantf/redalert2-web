// A game thread under Node: ../core/thread.mjs in a worker_threads worker.
import { parentPort, workerData } from 'node:worker_threads';
import { runThread } from '../core/thread.mjs';

await runThread({ ...workerData, post: (m) => parentPort.postMessage(m) });
