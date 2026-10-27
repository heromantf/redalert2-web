#!/usr/bin/env node
// The local server for the browser build: this checkout's pages and host code,
// the game module, and the game data, on 127.0.0.1 only.
//   node web/server.mjs [--port 8780] [--data DIR] [--throttle KBPS[,MS]] [--drop N] [--log-data]
//     /                        the game's page (/web/play.html)
//     /web/...                 web/ (the pages, their workers)
//     /host/...                host/ (the hosts' shared core: proto.mjs, core/)
//     /spike/...               spike/ (measurements that need a page)
//     /out/ra2.wasm            the WASI build (wasi/build.sh)
//     /data/manifest.json      every file and folder of DIR: { files: [{ p, s, m, d }] } (path, size, mtime ms, folder)
//     /data/<path>             a file of DIR, with byte ranges (206)
//     /blocks/<path>?b=F&n=N&s=SIZE&m=MTIME
//                              blocks F .. F+N-1 of a file of DIR (1 MiB each, N at most 16) in one
//                              answer (200) of exactly their bytes, compressed where the client takes it
//                              and it pays: zstd 3, else brotli 1, else gzip 1 (fast enough for any LAN;
//                              the core archives cross in 40%: spike/opfs/RESULT.md); 409 when the file
//                              is not the SIZE and MTIME the page's manifest gave
// DIR defaults to work/game; the browser only reads it (the game's writes stay in
// the page's overlay, web/http-backend.js), so it may be the game folder itself.
// Caching: the game data and the manifest never (no-store: the page keeps the
// blocks in OPFS, web/data-cache.js). The pages, scripts and the module are
// revalidated (no-cache, an ETag of size and mtime): a page load that changes
// nothing fetches only 304s. The module goes compressed, brotli 5 else zstd else
// gzip (120 MB in 13), compressed once a build.
// Every answer is cross-origin isolated (COOP same-origin, COEP require-corp:
// SharedArrayBuffer needs both).
// Tests of a slow network: --throttle KBPS[,MS] holds all the answers together
// to KBPS kilobytes a second (one link), each MS later; --drop N cuts every Nth
// answer of game data (/blocks/, /data/) halfway. --log-data: a line for each
// answer of game data, its file and blocks or range (which files a game reads when).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const WEB = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const av = process.argv.slice(2);
const opt = (name, def) => { const i = av.indexOf(name); return i >= 0 && i + 1 < av.length ? av[i + 1] : def; };
const PORT = +opt('--port', 8780);
const DATA = path.resolve(opt('--data', path.join(WEB, 'work/game')));
const [KBPS, LATENCY = 0] = (opt('--throttle', '') || '0').split(',').map(Number);
const DROP = +opt('--drop', 0);
const LOG_DATA = av.includes('--log-data');
const logData = (full, what) => LOG_DATA && console.log(`[data-req] ${path.relative(DATA, full)} ${what}`);
const ROOTS = { web: path.join(WEB, 'web'), host: path.join(WEB, 'host'), out: path.join(WEB, 'out'), spike: path.join(WEB, 'spike') };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png' };
const BLOCK = 1 << 20, RUN_MAX = 16;

const Z = zlib.constants;
const compressors = {
  block: {
    zstd: zlib.zstdCompress && promisify(zlib.zstdCompress),
    br: (b) => promisify(zlib.brotliCompress)(b, { params: { [Z.BROTLI_PARAM_QUALITY]: 1, [Z.BROTLI_PARAM_SIZE_HINT]: b.length } }),
    gzip: (b) => promisify(zlib.gzip)(b, { level: 1 }),
  },
  module: {
    br: (b) => promisify(zlib.brotliCompress)(b, { params: { [Z.BROTLI_PARAM_QUALITY]: 5, [Z.BROTLI_PARAM_SIZE_HINT]: b.length } }),
    zstd: zlib.zstdCompress && promisify(zlib.zstdCompress),
    gzip: (b) => promisify(zlib.gzip)(b, { level: 6 }),
  },
};
// what the client takes, in our order of preference
function encoding(req, kind) {
  const ae = String(req.headers['accept-encoding'] ?? '').toLowerCase();
  for (const [enc, fn] of Object.entries(compressors[kind])) if (fn && new RegExp(`\\b${enc}\\b`).test(ae)) return enc;
  return null;
}

function manifest() {
  const files = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name), p = rel ? rel + '/' + e.name : e.name;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) { files.push({ p, d: 1, m: Math.round(st.mtimeMs) }); walk(full, p); }
      else if (st.isFile()) files.push({ p, s: st.size, m: Math.round(st.mtimeMs) });
    }
  };
  walk(DATA, '');
  return { files };
}

function within(root, rel) {
  const full = path.resolve(root, '.' + path.sep + rel);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

// ---- answers, through the test's slow link where there is one ----
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
let linkFree = 0, dataAnswers = 0;
async function send(res, code, headers, body, { data = false, head = false } = {}) {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  if (LATENCY) await sleep(LATENCY);
  res.writeHead(code, { 'Content-Length': buf.length, ...headers });
  if (head || !buf.length) return res.end();
  const cut = data && DROP && ++dataAnswers % DROP === 0 ? buf.length >> 1 : -1;
  if (!KBPS && cut < 0) return res.end(buf);
  for (let o = 0; o < buf.length;) {
    if (cut >= 0 && o >= cut) {      // once what came before is out: a cut the client sees mid-answer, not one it asks again for itself
      await new Promise((r) => res.write(Buffer.alloc(0), () => r()));
      res.destroy();
      return undefined;
    }
    const c = buf.subarray(o, Math.min(o + 16384, cut >= 0 ? cut : buf.length));
    o += c.length;
    if (KBPS) {
      const now = Date.now();
      linkFree = Math.max(linkFree, now) + (c.length / (KBPS * 1024)) * 1000;
      if (linkFree - now > 2) await sleep(linkFree - now);
    }
    if (res.destroyed) return undefined;
    if (!res.write(c)) await new Promise((r) => res.once('drain', r));
  }
  return res.end();
}
const plain = (res, code, msg) => send(res, code, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }, msg);

async function readRange(full, start, len) {
  const fh = await fs.promises.open(full, 'r');
  try {
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) { const { bytesRead } = await fh.read(buf, got, len - got, start + got); if (!bytesRead) break; got += bytesRead; }
    return buf.subarray(0, got);
  } finally { await fh.close(); }
}

// a file of DIR, or a range of it
async function dataFile(req, res, full) {
  let st;
  try { st = fs.statSync(full); } catch { return plain(res, 404, 'not found'); }
  if (!st.isFile()) return plain(res, 404, 'not a file');
  const type = 'application/octet-stream', head = req.method === 'HEAD';
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  if (m) {
    const start = +m[1], end = Math.min(m[2] ? +m[2] : st.size - 1, st.size - 1);
    if (start > end || start >= st.size) return send(res, 416, { 'Content-Type': 'text/plain', 'Content-Range': `bytes */${st.size}` }, '');
    const h = { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    if (head) return send(res, 206, h, Buffer.alloc(0), { head: true });
    logData(full, `bytes ${start}-${end}`);
    return send(res, 206, h, await readRange(full, start, end - start + 1), { data: true });
  }
  if (!head) logData(full, 'whole');
  if (KBPS || DROP) return send(res, 200, { 'Content-Type': type, 'Cache-Control': 'no-store' }, head ? Buffer.alloc(0) : await fs.promises.readFile(full), { data: true, head });
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
  if (head) return res.end();
  return fs.createReadStream(full).pipe(res);
}

// blocks of a file of DIR, as one answer
async function blocks(req, res, full, q) {
  let st;
  try { st = fs.statSync(full); } catch { return plain(res, 404, 'not found'); }
  if (!st.isFile()) return plain(res, 404, 'not a file');
  const b = Number(q.get('b')), n = Number(q.get('n') ?? 1), s = q.get('s'), mt = q.get('m');
  if (!Number.isInteger(b) || !Number.isInteger(n) || b < 0 || n < 1 || n > RUN_MAX) return plain(res, 400, 'b, n: blocks');
  if ((s !== null && Number(s) !== st.size) || (mt !== null && Number(mt) !== Math.round(st.mtimeMs))) return plain(res, 409, 'the file changed');
  const start = b * BLOCK;
  if (start >= st.size) return send(res, 416, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }, '');
  logData(full, `blocks ${b}+${n}`);
  const raw = await readRange(full, start, Math.min(st.size, (b + n) * BLOCK) - start);
  const enc = encoding(req, 'block');
  let body = raw, h = {};
  if (enc) {
    const c = await compressors.block[enc](raw);
    if (c.length < raw.length * 0.97) { body = c; h = { 'Content-Encoding': enc }; }
  }
  return send(res, 200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...h }, body, { data: true, head: req.method === 'HEAD' });
}

// the pages, scripts and the module: revalidated, the module compressed once a build
const packed = new Map();            // full|mtime|encoding -> Promise<Buffer>
async function siteFile(req, res, full) {
  let st;
  try { st = fs.statSync(full); } catch { return plain(res, 404, 'not found'); }
  if (!st.isFile()) return plain(res, 404, 'not a file');
  const ext = path.extname(full).toLowerCase(), type = TYPES[ext] ?? 'application/octet-stream';
  const enc = ext === '.wasm' ? encoding(req, 'module') : null;
  const etag = `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}${enc ? '-' + enc : ''}"`;
  const h = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag, ...(ext === '.wasm' ? { Vary: 'Accept-Encoding' } : {}) };
  if (req.headers['if-none-match'] === etag) { if (LATENCY) await sleep(LATENCY); res.writeHead(304, h); return res.end(); }
  let body = await fs.promises.readFile(full);
  if (enc) {
    const key = `${full}|${st.mtimeMs}|${enc}`;
    if (!packed.has(key)) {
      for (const k of packed.keys()) if (k.startsWith(full + '|')) packed.delete(k);     // an older build's
      const t0 = Date.now(), size = body.length;
      packed.set(key, compressors.module[enc](body).then((c) => {
        console.log(`[server] ${path.basename(full)}: ${(size / 1048576).toFixed(1)} MB, ${enc} ${(c.length / 1048576).toFixed(1)} MB in ${Date.now() - t0} ms`);
        return c;
      }));
    }
    body = await packed.get(key);
    h['Content-Encoding'] = enc;
  }
  return send(res, 200, h, body, { head: req.method === 'HEAD' });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return await plain(res, 405, 'GET only');
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return await plain(res, 400, 'bad url'); }
    const p = decodeURIComponent(url.pathname);
    if (p === '/') { res.writeHead(302, { Location: '/web/play.html', 'Cache-Control': 'no-store' }); return res.end(); }
    if (p === '/data/manifest.json') return await send(res, 200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' }, JSON.stringify(manifest()));
    const [, top, rest = ''] = /^\/([^/]+)\/?(.*)$/.exec(p) ?? [];
    const root = top === 'data' || top === 'blocks' ? DATA : ROOTS[top];
    const full = root && within(root, rest);
    if (!full) return await plain(res, 404, 'not found');
    if (top === 'blocks') return await blocks(req, res, full, url.searchParams);
    if (top === 'data') return await dataFile(req, res, full);
    return await siteFile(req, res, full);
  } catch (x) {
    console.error(`[server] ${req.url}: ${x?.stack ?? x}`);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('server error'); } else res.destroy();
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`[server] http://127.0.0.1:${PORT}/  data ${DATA}` +
  `${KBPS ? `  (a slow link: ${KBPS} KB/s, ${LATENCY} ms)` : ''}${DROP ? `  (every ${DROP}th answer of data cut)` : ''}`));
