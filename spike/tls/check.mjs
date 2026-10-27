// Is a self-signed certificate enough for the game's page over the LAN?
// web/server.mjs behind an HTTPS front (a proxy: the server stays as it is),
// opened in headless Chrome as a LAN address would be (ra2.test mapped to this
// machine, the system's proxy bypassed), two ways:
//   clicked through  the certificate's error let pass (Playwright's
//                    ignoreHTTPSErrors, as a friend who clicks "Proceed")
//   trusted          the certificate taken as valid (Chrome's
//                    --ignore-certificate-errors-spki-list: as a friend who
//                    installed it, without touching this Mac's keychain)
// and over plain http for comparison. For each: a secure context, cross-origin
// isolation, SharedArrayBuffer, OPFS (a file written and read), Web Locks, and
// the module on a second fetch: from the HTTP cache (a 304) or all again.
//   . tools/env.sh && node spike/tls/check.mjs work/tls      (cert.pem, key.pem, spki.txt there)
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const WEB = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const dir = path.resolve(process.argv[2] ?? 'work/tls'), tmp = process.env.TMPDIR;
if (!tmp || !process.env.RA2WEB_CHROME_PROFILE) { console.error('source tools/env.sh first (the profiles go in its TMPDIR, .cache/tmp)'); process.exit(2); }
const HTTP = 8796, HTTPS = 8795;
const server = spawn(process.execPath, [path.join(WEB, 'web/server.mjs'), '--port', String(HTTP)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.once('data', res));
const front = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, (req, res) => {
  const p = http.request({ host: '127.0.0.1', port: HTTP, path: req.url, method: req.method, headers: req.headers }, (pr) => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); });
  p.on('error', () => res.destroy());
  req.pipe(p);
});
await new Promise((res) => front.listen(HTTPS, '127.0.0.1', res));
const spki = fs.readFileSync(path.join(dir, 'spki.txt'), 'utf8').trim();

const ways = [
  { name: 'plain http (for comparison)', url: `http://ra2.test:${HTTP}`, args: [], opts: {} },
  { name: 'https, the error clicked through', url: `https://ra2.test:${HTTPS}`, args: [], opts: { ignoreHTTPSErrors: true } },
  { name: 'https, the certificate trusted', url: `https://ra2.test:${HTTPS}`, args: [`--ignore-certificate-errors-spki-list=${spki}`], opts: {} },
];
try {
  for (const w of ways) {
    const profile = path.join(tmp, `tls-check-${ways.indexOf(w)}`);
    fs.rmSync(profile, { recursive: true, force: true });
    const ctx = await chromium.launchPersistentContext(profile, {
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, ...w.opts,
      args: ['--no-proxy-server', '--host-resolver-rules=MAP ra2.test 127.0.0.1', `--disk-cache-dir=${profile}-cache`, ...w.args],
    });
    try {
      const page = ctx.pages()[0] ?? await ctx.newPage();
      let r;
      try {
        await page.goto(`${w.url}/web/play.html?panel`);
        r = await page.evaluate(async () => {
          const out = { secure: isSecureContext, isolated: crossOriginIsolated, SAB: typeof SharedArrayBuffer === 'function', locks: !!navigator.locks };
          try {
            const d = await navigator.storage.getDirectory(), fh = await d.getFileHandle('tls-check', { create: true }), wr = await fh.createWritable();
            await wr.write('ok'); await wr.close(); out.OPFS = (await (await fh.getFile()).text()) === 'ok';
          } catch (x) { out.OPFS = `no (${x?.name ?? x})`; }
          const u = '/out/ra2.wasm';
          await (await fetch(u)).arrayBuffer();
          await new Promise((res) => setTimeout(res, 300));
          await (await fetch(u)).arrayBuffer();
          const e = performance.getEntriesByType('resource').filter((x) => x.name.endsWith(u));
          out.module = e.map((x) => `${(x.transferSize / 1048576).toFixed(2)} MB`).join(' then ');
          return out;
        });
      } catch (x) { r = { failed: String(x?.message ?? x).split('\n')[0] }; }
      console.log(`${w.name.padEnd(34)} ${JSON.stringify(r)}`);
    } finally { await ctx.close(); fs.rmSync(profile, { recursive: true, force: true }); fs.rmSync(`${profile}-cache`, { recursive: true, force: true }); }
  }
} finally { front.close(); server.kill(); }
