// The relay on wss:// and its certificate renewed under it (main.go certFiles): run by test-tls.sh,
// which makes two certificates (A, B) for 127.0.0.1 and starts the relay with A.
//   node test-tls.mjs DIR RELAY_PID   (NODE_EXTRA_CA_CERTS=DIR/both.crt)
import tls from 'node:tls';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
const D = process.argv[2], PID = +process.argv[3], PORT = 8795, URL = `wss://127.0.0.1:${PORT}/net`;
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const served = () => new Promise((res, rej) => {
  const s = tls.connect({ host: '127.0.0.1', port: PORT, servername: undefined, ca: fs.readFileSync(`${D}/both.crt`) }, () => {
    const cn = s.getPeerCertificate().subject.CN; s.end(); res(cn);
  });
  s.on('error', rej);
});
const ws = new WebSocket(URL);
const got = [];
ws.onmessage = (e) => got.push(JSON.parse(e.data));
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({ t: 'hello', v: 1, build: 'aaaabbbbccccdddd', lan: 'tls', name: 'Alice', client: 'client-tls-1' }));
await sleep(500);
check(got.some((m) => m.t === 'welcome'), 'a page joined over wss:// (certificate A)');
check((await served()) === 'relay-A', 'a handshake gets A');
fs.copyFileSync(`${D}/B.crt`, `${D}/cert.pem`); fs.copyFileSync(`${D}/B.key`, `${D}/key.pem`);
check((await served()) === 'relay-A', 'the files changed, no signal yet: still A');
process.kill(PID, 'SIGHUP'); await sleep(500);
check((await served()) === 'relay-B', 'SIGHUP: a handshake gets B, no restart');
ws.send(JSON.stringify({ t: 'ping', n: 7 })); await sleep(500);
check(ws.readyState === 1 && got.some((m) => m.t === 'pong' && m.n === 7), 'the page joined before is still there, its ping answered');
fs.writeFileSync(`${D}/cert.pem`, 'not a certificate');
process.kill(PID, 'SIGHUP'); await sleep(500);
check((await served()) === 'relay-B', 'a renewal that does not load: B kept');
ws.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
