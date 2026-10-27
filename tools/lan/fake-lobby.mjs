// tools/lan/fake-lobby.mjs URL N SECONDS [LAN]: N light lobby members on the relay's LAN, Fake1..FakeN, each
// broadcasting the game's "here in the lobby" datagram (type 4, as a real one sends it every ~1.3 s: 475 bytes,
// worked out from a real one's with sniff.mjs) with its own name, unique id (SessionClass UniqueID, 0xA8B37C:
// the lobby tells itself apart by it), packet number, and checksum (Westwood's CRC engine over bytes 4 on:
// rotl 1 + each little-endian dword). They answer nothing. Prints each one's count sent at the end.
// The datagram: [0..3] the checksum, [4..7] 36 12 01 00, [8..11] the packet number, [18..19] the product
// (0xAA04, what the lobby checks), then the game's packet: [20] its type, [24..43] the name, [67..70] the
// unique id, [71] 2; the rest 0.
// FAKE_MS: the interval (1300 by default, a real one's type 4; 770: its type 4 and type 0 together).
import crypto from 'node:crypto';
import fs from 'node:fs';
const [url, n, secs, lan = 'main'] = process.argv.slice(2);
const build = crypto.createHash('sha256').update(fs.readFileSync(new URL('../../out/ra2.wasm', import.meta.url))).digest('hex').slice(0, 16);
const base = Buffer.alloc(475);
base.set([0x36, 0x12, 0x01, 0x00], 4); base.writeUInt16LE(0xAA04, 18); base[20] = 4; base[71] = 2;
const crc = (b) => { let c = 0; for (let i = 4; i < b.length; i += 4) { const w = b.length - i >= 4 ? b.readUInt32LE(i) : Buffer.concat([b.subarray(i), Buffer.alloc(4)]).readUInt32LE(0); c = (((c << 1) | (c >>> 31)) + w) >>> 0; } return c; };
const fakes = [], MS = +(process.env.FAKE_MS ?? 1300);
for (let k = 1; k <= +n; k++) {
  const name = `Fake${k}`, p = Buffer.from(base), f = { name, sent: 0, id: 0, ws: new WebSocket(url) };
  p.fill(0, 24, 44); p.write(name, 24, 'latin1');
  p.writeUInt32LE(crypto.randomBytes(4).readUInt32LE(0), 67);
  f.ws.binaryType = 'arraybuffer';
  f.ws.onopen = () => f.ws.send(JSON.stringify({ t: 'hello', v: 1, build, name, client: `fake-${process.pid}-${k}`, lan }));
  f.ws.onmessage = (e) => {
    if (typeof e.data !== 'string' || JSON.parse(e.data).t !== 'welcome') return;
    const send = () => {
      p.writeUInt32LE(f.id++, 8); p.writeUInt32LE(crc(p), 0);
      const fr = Buffer.alloc(9 + p.length); fr[0] = 1; fr.writeUInt32BE(0x0A2FFFFF, 1); fr.writeUInt16BE(5000, 5); fr.writeUInt16BE(5000, 7); p.copy(fr, 9);
      f.ws.send(fr); f.sent++;
    };
    setTimeout(() => { send(); f.timer = setInterval(send, MS); }, Math.random() * MS);
  };
  fakes.push(f);
}
setTimeout(() => { for (const f of fakes) { clearInterval(f.timer); f.ws.close(); } const sent = fakes.map((f) => f.sent); console.log(`[fake] ${fakes.length}, sent ${Math.min(...sent)}-${Math.max(...sent)} each, ${sent.filter((x) => !x).length} never joined`); process.exit(0); }, +secs * 1000);
