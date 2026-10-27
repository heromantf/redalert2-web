// The page's side of the virtual LAN (wasi/net.c): the game's datagrams
// between its mailbox in shared memory and the relay (relay/main.go), over a
// WebSocket. One runs per page, in a worker of its own (web/net-worker.js;
// host/node/net-worker.mjs under Node): a worker is not throttled the way a
// page in a background tab is, and lockstep play holds every player up while
// one of them is late.
//
// The mailbox (wasi/net.c net_mailbox_t; the same numbers there): a 256-byte
// header of 32-bit words, then the TX ring (the game's, to send; slots) and
// the RX ring (ours, received; records of their own length, rx_bytes of them,
// none wrapping: a length of 0xFFFF says the rest of the ring is unused). A
// slot or a record: u16 length, u16 flags (in: 1 sent as a broadcast), u32 the
// peer (host order: the destination going out, the source coming in), u16
// source port, u16 destination port, the payload (a record's to a multiple of
// 4); little-endian, as wasm is. On the WebSocket the same datagram is
// [1][the peer][source port][destination port][payload], big-endian ([2] from
// the relay: a broadcast). What comes while the game has no socket bound
// (rx_open 0) is not kept; what finds the ring full is lost (net.c's rule: the
// ring holds more than its sockets do).
//
// runNet({ memory, ptr, url, hello, status, log }) joins the LAN and keeps it
// joined: on a drop it reconnects with the relay's token (the same address,
// so the game, which only sees datagrams, goes on). hello: { build, name,
// client, lan }. status({ state, ip, peers, why }) as it changes: state
// 'connecting', 'joined', 'dropped' (and reconnecting) or 'refused' (and
// stopped: why 'name', 'client', 'version', 'full' or 'bad').
const H = { magic: 0, version: 1, txSlots: 2, rxBytes: 3, slotBytes: 4, link: 5, ip: 6, txHead: 7, txTail: 8,
            rxHead: 9, rxTail: 10, txBell: 11, txLost: 12, rxLost: 13,
            rxLostOwn: 14, sockLost: 15, sockLostOwn: 16, rxPeak: 17, sockPeak: 18, rxOpen: 19, rxClosed: 20 };   // wasi/net.c's net_hdr_t
const MAGIC = 0x31544e52, VERSION = 2, HDR_BYTES = 256, SLOT_HDR = 12, MAX_DATA = 1472, WRAP = 0xffff;

export const ipText = (ip) => [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.');
const ipNumber = (s) => s.split('.').reduce((a, b) => a * 256 + +b, 0) >>> 0;

export function runNet({ memory, ptr, url, hello, status = () => {}, log = () => {} }) {
  let hdr, bytes;
  const view = () => { if (!hdr || hdr.buffer !== memory.buffer) { hdr = new Int32Array(memory.buffer, ptr, HDR_BYTES / 4); bytes = new Uint8Array(memory.buffer); } };
  view();
  if (hdr[H.magic] >>> 0 !== MAGIC) throw new Error(`net: no mailbox at ${ptr}`);
  if (hdr[H.version] !== VERSION) throw new Error(`net: mailbox version ${hdr[H.version]}, this worker reads ${VERSION}`);
  const txSlots = hdr[H.txSlots], rxBytes = hdr[H.rxBytes] >>> 0, slotBytes = hdr[H.slotBytes];
  const txBase = ptr + HDR_BYTES, rxBase = txBase + txSlots * slotBytes;

  let ws = null, joined = false, token = '', stopped = false, retry = 0, sent = 0, received = 0;
  const setLink = (up) => { view(); Atomics.store(hdr, H.link, up ? 1 : 0); };

  function connect() {
    status({ state: 'connecting' });
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: 1, lan: 'main', ...hello, token }));
    ws.onmessage = (e) => (typeof e.data === 'string' ? control(JSON.parse(e.data)) : datagram(new Uint8Array(e.data)));
    ws.onclose = () => {
      joined = false;
      setLink(false);
      if (stopped) return;
      const wait = [1000, 2000, 5000, 10000][Math.min(retry++, 3)];
      status({ state: 'dropped', retryMs: wait });
      log(`[net] the relay dropped; again in ${wait / 1000} s`);
      setTimeout(connect, wait);
    };
    ws.onerror = () => {};
  }
  function control(m) {
    if (m.t === 'welcome') {
      view();
      token = m.token;
      retry = 0;
      Atomics.store(hdr, H.ip, ipNumber(m.ip) | 0);
      joined = true;
      setLink(true);
      log(`[net] joined LAN ${m.lan} as ${m.ip}: ${m.peers.map((p) => `${p.name} ${p.ip}`).join(', ')}`);
      status({ state: 'joined', ip: m.ip, peers: m.peers });
    } else if (m.t === 'peers') status({ state: 'joined', peers: m.peers });
    else if (m.t === 'refused') {
      stopped = true;
      log(`[net] the relay refused: ${m.why}`);
      status({ state: 'refused', why: m.why });
    }
  }
  // a datagram from the relay, into the RX ring (none kept with no socket bound; lost if it is full)
  function datagram(f) {
    if (f.length < 9 || (f[0] !== 1 && f[0] !== 2) || f.length - 9 > MAX_DATA) return;   // 2: sent as a broadcast
    view();
    if (!Atomics.load(hdr, H.rxOpen)) { Atomics.add(hdr, H.rxClosed, 1); return; }
    const len = f.length - 9, need = (SLOT_HDR + len + 3) & ~3;
    const head = Atomics.load(hdr, H.rxHead) >>> 0, tail = Atomics.load(hdr, H.rxTail) >>> 0;
    const off = head % rxBytes, toEnd = rxBytes - off, skip = toEnd < need ? toEnd : 0;   // a record never wraps
    if (((head - tail) >>> 0) + skip + need > rxBytes) { Atomics.add(hdr, H.rxLost, 1); if (f[0] === 1) Atomics.add(hdr, H.rxLostOwn, 1); return; }
    if (skip) new DataView(memory.buffer, rxBase + off, 2).setUint16(0, WRAP, true);
    const at = rxBase + (skip ? 0 : off), v = new DataView(memory.buffer, at, SLOT_HDR), fv = new DataView(f.buffer, f.byteOffset);
    v.setUint16(0, len, true); v.setUint16(2, f[0] === 2 ? 1 : 0, true);
    v.setUint32(4, fv.getUint32(1), true); v.setUint16(8, fv.getUint16(5), true); v.setUint16(10, fv.getUint16(7), true);
    bytes.set(f.subarray(9), at + SLOT_HDR);
    Atomics.store(hdr, H.rxHead, (head + skip + need) | 0);
    received++;
  }
  // the TX ring, to the relay, as the game fills it (its bell)
  async function send() {
    for (;;) {
      view();
      const bell = Atomics.load(hdr, H.txBell);
      let tail = Atomics.load(hdr, H.txTail);
      const head = Atomics.load(hdr, H.txHead);
      for (; tail !== head; tail = (tail + 1) | 0) {
        const at = txBase + ((tail >>> 0) % txSlots) * slotBytes, v = new DataView(memory.buffer, at, SLOT_HDR);
        const len = v.getUint16(0, true);
        if (joined && ws.readyState === 1 && len <= MAX_DATA) {
          const f = new Uint8Array(9 + len), fv = new DataView(f.buffer);
          f[0] = 1; fv.setUint32(1, v.getUint32(4, true)); fv.setUint16(5, v.getUint16(8, true)); fv.setUint16(7, v.getUint16(10, true));
          f.set(bytes.subarray(at + SLOT_HDR, at + SLOT_HDR + len), 9);
          ws.send(f);
          sent++;
        }
      }
      Atomics.store(hdr, H.txTail, tail);
      const r = Atomics.waitAsync(hdr, H.txBell, bell, 1000);
      if (r.async) await r.value;
    }
  }
  setInterval(() => {
    view();
    const a = (k) => Atomics.load(hdr, H[k]);
    log(`[net] ${sent} datagrams sent, ${received} received; lost: ${a('txLost')} going out, ${a('rxLost')} coming in ` +
        `(${a('rxLostOwn')} to this page alone), ${a('sockLost')} at a socket (${a('sockLostOwn')}); ${a('rxClosed')} with no socket; ` +
        `the most waiting: ${(a('rxPeak') / 1024).toFixed(1)} KB in the RX ring, ${(a('sockPeak') / 1024).toFixed(1)} KB at a socket`);
  }, 30000);
  connect();
  send();
  return { stop() { stopped = true; ws?.close(); setLink(false); } };
}
