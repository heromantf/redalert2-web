#!/usr/bin/env node
// Run the browser build in Chrome, driven by Playwright, and stream what the
// game prints: web/server.mjs started on a free port, the installed Chrome
// opened on web/index.html with the game's arguments, its console copied to
// stdout until the page's title says EXIT or the time is up.
//   . tools/env.sh && node tools/chrome.mjs [--timeout S] [--linger S] [--data DIR] [--headed] [--env K=V]...
//        [--page index|play] [--mark TEXT] [--shot FILE@S] [--click X,Y@S] [--tap SELECTOR@S] [--key CODE@S]
//        [--mouse X,Y@S] [--eval JS@S]
//        [--wav FILE,SECONDS@S]... [--port N] [--query K=V]... [--server ARG]... -- ARG...
// --page play: the game's page (web/play.html: the picture, input); index (the
// default) the headless test page; tests/NAME a test page of web/tests; a path
// from / any page the server has (/spike/NAME/PAGE). The actions run S seconds after the first
// console line containing --mark (default the main menu, "[dialog] open 0xE2"):
// --shot a screenshot of the page into FILE, --click a click at the game's
// pixel X,Y (play only: the page says where that pixel is), --tap a click on
// the page's element (a CSS selector: #play, the start panel's), --mouse the
// mouse moved to the page's point X,Y (CSS pixels; outside the page too), --eval
// an expression evaluated on the page, its value printed, --key a key
// (Playwright's names: Escape, KeyH, Enter...), --wav SECONDS of what the page's
// speakers get, into a 16-bit stereo WAV (play only: its sound). --port: a fixed
// port (the site, and so its OPFS, is the same from run to run: the saves and
// the game data's cache stay; otherwise a free one, a site no run sees again,
// whose storage is cleared at the end), --query: more of the page's
// parameters (save=NAME, fresh, nocache, freshcache), --server: an argument
// for web/server.mjs (--server --throttle --server 2500,60: a slow link),
// --linger: the page kept S seconds after its title said EXIT (actions still run).
// The installed Chrome ($RA2WEB_CHROME: tools/env.sh finds the platform's own,
// or set it), its profile and its disk cache where tools/env.sh says
// ($RA2WEB_CHROME_PROFILE, $RA2WEB_CHROME_CACHE: in work/, never the home
// folder); no browser is downloaded (playwright-core).
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright-core';

const WEB = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CHROME = process.env.RA2WEB_CHROME;
const profile = process.env.RA2WEB_CHROME_PROFILE, cache = process.env.RA2WEB_CHROME_CACHE;
if (!profile || !cache) { console.error('source tools/env.sh first (Chrome\'s profile and cache go in work/)'); process.exit(2); }
if (!CHROME) { console.error('no Chrome found: install Chrome (or Chromium), or set RA2WEB_CHROME to it'); process.exit(2); }

const av = process.argv.slice(2), sep = av.indexOf('--');
const own = sep >= 0 ? av.slice(0, sep) : av, gameArgs = sep >= 0 ? av.slice(sep + 1) : [];
let timeout = 120, linger = 0, data = null, headed = false, pageName = 'index', mark = '[dialog] open 0xE2', fixedPort = 0;
const env = [], actions = [], query = [], serverArgs = [];
const timed = (v) => { const k = v.lastIndexOf('@'); return [v.slice(0, k), +v.slice(k + 1)]; };
for (let i = 0; i < own.length; i++) {
  if (own[i] === '--timeout') timeout = +own[++i];
  else if (own[i] === '--linger') linger = +own[++i];
  else if (own[i] === '--data') data = own[++i];
  else if (own[i] === '--headed') headed = true;
  else if (own[i] === '--env') env.push(own[++i]);
  else if (own[i] === '--page') pageName = own[++i];
  else if (own[i] === '--mark') mark = own[++i];
  else if (own[i] === '--port') fixedPort = +own[++i];
  else if (own[i] === '--query') query.push(own[++i]);
  else if (own[i] === '--server') serverArgs.push(own[++i]);
  else if (['--shot', '--click', '--tap', '--key', '--wav', '--mouse', '--eval'].includes(own[i])) { const [arg, t] = timed(own[i + 1]); actions.push({ kind: own[i].slice(2), arg, t }); i++; }
  else { console.error(`unknown option ${own[i]}`); process.exit(2); }
}

const port = fixedPort || await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = spawn(process.execPath, [path.join(WEB, 'web/server.mjs'), '--port', String(port), ...(data ? ['--data', data] : []), ...serverArgs],
  { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.once('data', (b) => { process.stderr.write(String(b)); res(); }));
server.stdout.on('data', (b) => process.stderr.write(String(b)));

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: !headed, viewport: { width: 1280, height: 982 },   // the canvas 1280x960: 4:3
  args: [`--disk-cache-dir=${cache}`, '--no-first-run', '--no-default-browser-check', '--disable-breakpad',
         '--autoplay-policy=no-user-gesture-required'],   // the sound starts without a click, for the tests
});
const page = ctx.pages()[0] ?? await ctx.newPage();
let marked = false;
async function act(a) {
  try {
    if (a.kind === 'shot') { await page.screenshot({ path: a.arg }); process.stderr.write(`[chrome] shot ${a.arg}\n`); }
    else if (a.kind === 'wav') {
      const [file, secs] = a.arg.split(',');
      const r = await page.evaluate(async (secs) => {
        const au = window.ra2web?.audio;
        if (!au) return null;
        const f = await au.capture(secs), pcm = new Int16Array(f.length);
        for (let i = 0; i < f.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767)));
        let s = '';
        const b = new Uint8Array(pcm.buffer);
        for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768));
        return { rate: au.rate, data: btoa(s) };
      }, +secs);
      if (!r) { process.stderr.write(`[chrome] wav: no sound on the page\n`); return; }
      const pcm = Buffer.from(r.data, 'base64'), hdr = Buffer.alloc(44);
      hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVEfmt ', 8); hdr.writeUInt32LE(16, 16);
      hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(2, 22); hdr.writeUInt32LE(r.rate, 24); hdr.writeUInt32LE(r.rate * 4, 28);
      hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
      (await import('node:fs')).writeFileSync(file, Buffer.concat([hdr, pcm]));
      process.stderr.write(`[chrome] wav ${file}: ${secs} s at ${r.rate} Hz\n`);
    }
    else if (a.kind === 'key') { await page.keyboard.press(a.arg); process.stderr.write(`[chrome] key ${a.arg}\n`); }
    else if (a.kind === 'tap') { await page.click(a.arg, { timeout: 2000 }); process.stderr.write(`[chrome] tap ${a.arg}\n`); }
    else if (a.kind === 'mouse') { const [x, y, steps = 8] = a.arg.split(',').map(Number); await page.mouse.move(x, y, { steps }); process.stderr.write(`[chrome] mouse ${a.arg}\n`); }
    else if (a.kind === 'eval') { const v = await page.evaluate(a.arg); process.stderr.write(`[chrome] eval ${a.arg} -> ${JSON.stringify(v)}\n`); }
    else if (a.kind === 'click') {
      const [x, y] = a.arg.split(',').map(Number);
      const at = await page.evaluate(([x, y]) => {
        const p = window.ra2web?.presenter, r = document.getElementById('screen').getBoundingClientRect(), c = p?.canvasAt(x, y);
        return c && [r.left + c[0], r.top + c[1]];
      }, [x, y]);
      if (!at) { process.stderr.write(`[chrome] click ${a.arg}: no picture\n`); return; }
      await page.mouse.click(at[0], at[1]);
      process.stderr.write(`[chrome] click ${a.arg} (page ${at[0].toFixed(0)},${at[1].toFixed(0)})\n`);
    }
  } catch (x) { process.stderr.write(`[chrome] ${a.kind} ${a.arg}: ${x}\n`); }
}
page.on('console', (m) => {
  const s = m.text();
  process.stdout.write(s + '\n');
  if (!marked && s.includes(mark)) { marked = true; for (const a of actions) setTimeout(() => act(a), a.t * 1000); }
});
page.on('pageerror', (e) => process.stdout.write(`[page] error: ${e}\n`));
const q = new URLSearchParams();
for (const a of gameArgs) q.append('arg', a);
for (const kv of env) q.append('env', kv);
for (const kv of query) { const k = kv.indexOf('='); q.append(k < 0 ? kv : kv.slice(0, k), k < 0 ? '' : kv.slice(k + 1)); }
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${port}${pageName.startsWith('/') ? '' : '/web/'}${pageName}.html?${q}`);
let title = 'TIMEOUT';
try {
  await page.waitForFunction(() => document.title.startsWith('EXIT'), null, { timeout: timeout * 1000, polling: 500 });
  title = await page.title();
  if (linger) await new Promise((res) => setTimeout(res, linger * 1000));
} catch {}
process.stderr.write(`[chrome] ${title} after ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
if (!fixedPort) {         // a site of its own: what it kept (the game data's cache: 137 MB to the menu) is for no other run
  try { await (await ctx.newCDPSession(page)).send('Storage.clearDataForOrigin', { origin: `http://127.0.0.1:${port}`, storageTypes: 'all' }); }
  catch (x) { process.stderr.write(`[chrome] the site's storage not cleared: ${x}\n`); }
}
await ctx.close();
server.kill();
process.exitCode = /^EXIT (\d+)$/.test(title) ? +title.slice(5) : 124;
