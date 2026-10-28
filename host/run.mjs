#!/usr/bin/env node
// Run a wasm32-wasip1-threads program (the WASI build, out/ra2.wasm) under Node:
// V8, the engine Chrome runs it on, with a host that is the browser's in shape.
//
//   node host/run.mjs [--dir HOST::GUEST]... [--pool N] [--stack-mb N] [--env K=V]...
//        [--relay ws://HOST:PORT/net --name NAME [--client ID] [--lan LAN]] MODULE.wasm [ARG...]
//
// The shared memory (its size as the module declares it), a control block and
// one RPC slot per thread; an I/O worker serving the file calls (node/io-worker.mjs:
// core/io.mjs, the --dir mounts as preopened directories); a pool of game-thread
// workers (node/game-worker.mjs: core/thread.mjs), slot 0 running _start and the others taken by
// thread-spawn (16 by default: Yuri's Revenge starts 6 to 7, and the rest is room
// for what starts more; an idle worker costs ~17 MB, its own engine). Each worker's engine stack is --stack-mb: 0.7 by default, which
// gives a wasm recursion 97% of the depth a Chrome 155 worker gives on this Mac
// (spike/stacklimit: Chrome's worker has about 0.5 MB for wasm; Node keeps
// ~192 KB of a worker's stack in reserve, and its own default of 4 MB would let
// five times as much through), so a chain too deep for the browser fails here too.
//
// --relay: the game on the relay's virtual LAN (relay/main.go, wasi/net.c), as
// a page that plays online is: NAME the player's (the game's [MultiPlayer]
// Handle), ID this player's own (a page's is its browser's), LAN which one;
// the module's id (its SHA-256) keeps builds apart.
//
// After nfsu2-web's web/src/host/process.ts (MIT; see ../NOTICE.md).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { CTL_EXIT, CTL_INTS, CTL_NEXT_TID, CTL_POOL, MAX_THREADS, POOL_RUN_MAIN, RPC_BYTES } from './proto.mjs';

function usage(msg) {
  if (msg) console.error(msg);
  console.error('usage: node host/run.mjs [--dir HOST::GUEST]... [--pool N] [--stack-mb N] [--env K=V]... ' +
                '[--relay URL --name NAME [--client ID] [--lan LAN]] MODULE.wasm [ARG...]');
  process.exit(2);
}

const mounts = [], env = {};
let pool = 16, stackMb = 0.7, file = null, args = [], relay = null, name = null, client = null, lan = 'main';
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) {
  const a = av[i];
  if (a === '--dir' && i + 1 < av.length) {
    const [host, guest] = av[++i].split('::');
    if (!fs.existsSync(host) || !fs.statSync(host).isDirectory()) usage(`--dir: no directory ${host}`);
    mounts.push({ host: path.resolve(host), guest: guest ?? host });
  } else if (a === '--pool' && i + 1 < av.length) pool = Math.min(+av[++i], MAX_THREADS);
  else if (a === '--stack-mb' && i + 1 < av.length) stackMb = +av[++i];
  else if (a === '--env' && i + 1 < av.length) { const [k, ...v] = av[++i].split('='); env[k] = v.join('='); }
  else if (a === '--relay' && i + 1 < av.length) relay = av[++i];
  else if (a === '--name' && i + 1 < av.length) name = av[++i];
  else if (a === '--client' && i + 1 < av.length) client = av[++i];
  else if (a === '--lan' && i + 1 < av.length) lan = av[++i];
  else if (a.startsWith('--') && !file) usage(`unknown option ${a}`);
  else { file = a; args = av.slice(i + 1); break; }
}
if (!file) usage();
if (relay && !name) usage('--relay needs --name');
if (relay) Object.assign(env, { RA2WEB_NET: '1', RA2WEB_NAME: name });
// this run's id, as a browser's (web/online.js ra2web.client): the relay's
// one page per browser, and the guest's PATH (wasi/main.c machine_path)
const clientId = client ?? `node-${crypto.randomUUID()}`;
env.RA2WEB_MACHINE ??= clientId;
env.RA2WEB_TZ ??= String(-new Date().getTimezoneOffset());   // this machine's time zone, as the page gives the browser's (wasi/main.c)

// The memory the module imports (env.memory): its limits, from the import section
// (the JS API does not tell a module's declared minimum).
function memoryLimits(bytes) {
  let i = 8;
  const leb = () => { let r = 0, s = 0, b; do { b = bytes[i++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return r; };
  const name = () => { const n = leb(); i += n; };
  while (i < bytes.length) {
    const id = bytes[i++], size = leb(), end = i + size;
    if (id === 2) {
      for (let n = leb(); n > 0; n--) {
        name(); name();
        const kind = bytes[i++];
        if (kind === 0) leb();
        else if (kind === 1) { i++; const f = bytes[i++]; leb(); if (f & 1) leb(); }
        else if (kind === 2) { const f = bytes[i++], min = leb(), max = f & 1 ? leb() : 65536; return { min, max, shared: !!(f & 2) }; }
        else if (kind === 3) { i += 2; }
        else if (kind === 4) { i++; leb(); }
      }
    }
    i = end;
  }
  return null;
}

const bytes = fs.readFileSync(file);
const lim = memoryLimits(bytes);
if (!lim?.shared) usage(`${file}: imports no shared memory (a wasm32-wasip1-threads build?)`);
let t0 = performance.now();
const mod = await WebAssembly.compile(bytes);
const compileMs = performance.now() - t0;
const memory = new WebAssembly.Memory({ initial: lim.min, maximum: lim.max, shared: true });
const ctlBuf = new SharedArrayBuffer(CTL_INTS * 4), rpc = new SharedArrayBuffer(RPC_BYTES);
const ctl = new Int32Array(ctlBuf);
ctl[CTL_NEXT_TID] = 1;
const cfg = { args: [path.basename(file, '.wasm'), ...args], env };
console.error(`[host] ${path.basename(file)}: ${(bytes.length / 1048576).toFixed(1)} MB compiled in ${compileMs.toFixed(0)} ms; ` +
              `memory ${lim.min * 64 / 1024} MB of ${lim.max * 64 / 1024} MB; ${pool} threads, ${stackMb} MB engine stack each; ` +
              `mounts ${mounts.map(m => `${m.guest}=${m.host}`).join(' ') || 'none'}`);

const workers = [];
let exited = false;
function exit(code) {
  if (exited) return;
  exited = true;
  for (const w of workers) w.terminate();
  process.exitCode = code;
}
let net = null;
const onMsg = (m) => {
  if (m.t === 'register' && m.kind === 4 && relay && !net) {   // the virtual LAN's mailbox (wasi/net.c)
    const hello = { build: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16), name,
                    client: clientId, lan };
    net = new Worker(new URL('./node/net-worker.mjs', import.meta.url), { workerData: { memory, ptr: m.ptr, url: relay, hello } });
    net.on('message', onMsg);
    net.on('error', onError('net worker'));
    workers.push(net);
  }
  else if (m.t === 'net') { if (!m.s.tick && (m.s.state !== 'joined' || m.s.ip)) process.stderr.write(`[net] ${JSON.stringify(m.s)}\n`); }
  else if (m.t === 'log') (m.fd === 1 ? process.stdout : process.stderr).write(m.s + '\n');
  else if (m.t === 'note') process.stderr.write(m.s + '\n');
  else if (m.t === 'trap') process.stderr.write(`[host] TRAP in thread ${m.tid}: ${m.msg}\n${m.stack ?? ''}\n`);
  else if (m.t === 'exit') { process.stderr.write(`[host] exit ${m.code}; ${Atomics.load(ctl, CTL_NEXT_TID) - 1} threads were started\n`); exit(m.code); }
};
const onError = (what) => (e) => { process.stderr.write(`[host] ${what}: ${e?.stack ?? e}\n`); exit(134); };

const io = new Worker(new URL('./node/io-worker.mjs', import.meta.url), { workerData: { memory, ctl: ctlBuf, rpc, mounts } });
workers.push(io);
io.on('error', onError('I/O worker'));
await new Promise((res) => io.on('message', (m) => (m.t === 'io-ready' ? res() : onMsg(m))));

t0 = performance.now();
const ready = [];
for (let s = 0; s < pool; s++) {
  const w = new Worker(new URL('./node/game-worker.mjs', import.meta.url), {
    workerData: { mod, memory, ctl: ctlBuf, rpc, slot: s, pool, cfg },
    resourceLimits: { stackSizeMb: stackMb },
  });
  w.on('error', onError(`game worker ${s}`));
  ready.push(new Promise((res) => w.on('message', (m) => (m.t === 'ready' ? res() : onMsg(m)))));
  workers.push(w);
}
await Promise.all(ready);
console.error(`[host] ${pool} threads instantiated in ${(performance.now() - t0).toFixed(0)} ms; starting`);
Atomics.store(ctl, CTL_POOL, POOL_RUN_MAIN); Atomics.notify(ctl, CTL_POOL);
void CTL_EXIT;
