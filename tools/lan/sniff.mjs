// tools/lan/sniff.mjs URL OUT SECONDS [LAN]: join the relay's LAN as "Sniff" (the build of out/ra2.wasm) and write
// each datagram it gets, one a line: ms src sport dport payload-hex. A tool for working out the lobby's packets.
import crypto from 'node:crypto';
import fs from 'node:fs';
const [url, out, secs, lan = 'main'] = process.argv.slice(2);
const build = crypto.createHash('sha256').update(fs.readFileSync(new URL('../../out/ra2.wasm', import.meta.url))).digest('hex').slice(0, 16);
const f = fs.openSync(out, 'w'), t0 = Date.now();
const ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: 1, build, name: 'Sniff', client: 'sniff-' + process.pid, lan }));
ws.onmessage = (e) => {
  if (typeof e.data === 'string') { fs.writeSync(f, `# ${e.data}\n`); return; }
  const b = new Uint8Array(e.data), dv = new DataView(e.data);
  const src = [1, 2, 3, 4].map((i) => b[i]).join('.');
  fs.writeSync(f, `${Date.now() - t0} ${src} ${dv.getUint16(5)} ${dv.getUint16(7)} ${Buffer.from(b.subarray(9)).toString('hex')}\n`);
};
setTimeout(() => { ws.close(); process.exit(0); }, +secs * 1000);
