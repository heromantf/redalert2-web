#!/usr/bin/env node
// The relay's protocol (main.go), against a running relay:
//   go build -o ../out/relay . && ../out/relay -addr 127.0.0.1:8791 &   node test.mjs ws://127.0.0.1:8791/net
// Joins, a broadcast (the sender gets it too), a unicast, the refusals (a name
// taken, a second page of one browser, a different build on a LAN in use),
// and a reconnect with the token (the same address back).
const url = process.argv[2] ?? 'ws://127.0.0.1:8791/net';
const BUILD = 'aaaabbbbccccdddd';
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

function client(hello) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const got = [], waiters = [];
  const push = (m) => { const w = waiters.findIndex((x) => x.pred(m)); if (w >= 0) waiters.splice(w, 1)[0].res(m); else got.push(m); };
  ws.onmessage = (e) => push(typeof e.data === 'string' ? JSON.parse(e.data) : new Uint8Array(e.data));
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: 1, build: BUILD, lan: 'test', ...hello }));
  const next = (pred = () => true, ms = 2000) => {
    const i = got.findIndex(pred);
    if (i >= 0) return Promise.resolve(got.splice(i, 1)[0]);
    return new Promise((res) => { const w = { pred, res }; waiters.push(w); setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); res(null); } }, ms); });
  };
  return { ws, next, closed: new Promise((res) => (ws.onclose = res)) };
}
const ip = (s) => s.split('.').reduce((a, b) => a * 256 + +b, 0);
function datagram(dst, sport, dport, bytes) {
  const f = new Uint8Array(9 + bytes.length), v = new DataView(f.buffer);
  f[0] = 1; v.setUint32(1, dst); v.setUint16(5, sport); v.setUint16(7, dport); f.set(bytes, 9);
  return f;
}
const parse = (f) => { const v = new DataView(f.buffer, f.byteOffset); return { src: v.getUint32(1), sport: v.getUint16(5), dport: v.getUint16(7), data: [...f.subarray(9)] }; };
const isWelcome = (m) => m && m.t === 'welcome', isBinary = (m) => m instanceof Uint8Array;

const a = client({ name: 'Alice', client: 'client-aaaa-1' });
const wa = await a.next(isWelcome);
check(wa && /^10\.47\.\d+\.\d+$/.test(wa.ip), `Alice joined: ${wa?.ip}`);
const b = client({ name: 'Bob', client: 'client-bbbb-1' });
const wb = await b.next(isWelcome);
check(wb && wb.ip !== wa.ip && wb.peers.length === 2, `Bob joined: ${wb?.ip}, peers ${wb?.peers.map((p) => p.name)}`);
const pa = await a.next((m) => m.t === 'peers' && m.peers.length === 2);
check(!!pa, 'Alice told Bob came');

a.ws.send(datagram(0xffffffff, 5000, 5000, [1, 2, 3]));
const ba = await a.next(isBinary), bb = await b.next(isBinary);
check(ba && parse(ba).src === ip(wa.ip) && parse(ba).data.join() === '1,2,3', 'a broadcast back to its sender');
check(bb && parse(bb).src === ip(wa.ip) && parse(bb).dport === 5000, 'the broadcast at Bob, from Alice');
b.ws.send(datagram(ip(wa.ip), 5000, 5000, [9]));
const ua = await a.next(isBinary);
check(ua && parse(ua).src === ip(wb.ip) && parse(ua).data.join() === '9', 'a unicast Bob to Alice');
check(bb && bb[0] === 2 && ua && ua[0] === 1, 'handed on marked: a broadcast 2, a unicast 1');
check(!(await b.next(isBinary, 300)), 'the unicast not back at Bob');
b.ws.send(datagram(ip('10.47.0.250'), 5000, 5000, [7]));
check(!(await a.next(isBinary, 300)), 'a unicast to no one goes nowhere');
b.ws.send(datagram(0xffffffff, 5000, 5000, new Uint8Array(1473)));
check(!(await a.next(isBinary, 300)), 'a payload past 1472 bytes dropped');

const c = client({ name: 'alice', client: 'client-cccc-1' });
check((await c.next((m) => m.t === 'refused'))?.why === 'name', 'a name taken (any case) refused');
const d = client({ name: 'Dave', client: 'client-aaaa-1' });
check((await d.next((m) => m.t === 'refused'))?.why === 'client', "a second page of Alice's browser refused");
const e = client({ name: 'Eve', client: 'client-eeee-1', build: '1111222233334444' });
check((await e.next((m) => m.t === 'refused'))?.why === 'version', 'another build on a LAN in use refused');

a.ws.close();
await a.closed;
const pb = await b.next((m) => m.t === 'peers' && m.peers.length === 1);
check(!!pb, 'Bob told Alice went');
const a2 = client({ name: 'Alice', client: 'client-aaaa-1', token: wa.token });
const wa2 = await a2.next(isWelcome);
check(wa2 && wa2.ip === wa.ip, `Alice back with her token: ${wa2?.ip}`);
b.ws.send(datagram(ip(wa.ip), 5000, 5000, [5]));
check(!!(await a2.next(isBinary)), 'datagrams reach her again');

for (const x of [a2, b, c, d, e]) x.ws.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
