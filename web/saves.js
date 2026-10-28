// The game's saves out of this browser and back: one zip of them, for another address, browser or
// machine (a site's OPFS is its own: scheme, host and port, and this browser's; save-store.js).
// The saves only, as the game names them (SAVE%04lX.SAV, 0x829EE8) at the save set's root; the
// game's settings (RA2MD.INI) and anything else it wrote stay. The start panel uses it, while the
// game is not running (it keeps its files open while it runs).
//   listSaves(set)              -> [{ name, size, date }]
//   exportSaves(set)            -> Blob, a zip (deflated: Chrome's CompressionStream)
//   readSaves(blob)             -> [{ name, data }], the zip's saves, in a folder of it or not (others left out)
//   writeSaves(set, entries)    the saves written, the same names replaced
//   claimSaves(set) -> release | null   the save set this page's alone (null: another page has it)
export const SAVE_RE = /^SAVE[0-9A-F]{4}\.SAV$/i;

// A save set is one page's at a time, a Web Lock (as online.js keeps online play one page's): two
// pages of the game on one folder would open its files at once (an OPFS file has one writer: the
// second's writes fail), and an import or an export beside a running game would meet it half-written.
// The lock is held until release() (or the page goes).
export function claimSaves(set) {
  if (!navigator.locks) return Promise.resolve(() => {});
  return new Promise((res) => navigator.locks.request(`ra2web-save:${set}`, { ifAvailable: true }, (lock) => {
    if (!lock) { res(null); return null; }
    return new Promise((release) => res(release));
  }));
}

const dir = async (set) => (await navigator.storage.getDirectory()).getDirectoryHandle(set, { create: true });

export async function listSaves(set) {
  const out = [];
  for await (const [name, h] of (await dir(set)).entries()) {
    if (h.kind !== 'file' || !SAVE_RE.test(name)) continue;
    const f = await h.getFile();
    out.push({ name, size: f.size, date: f.lastModified, file: f });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- zip, as much of it as saves need: stored or deflated, no zip64 ----
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return ~c >>> 0; }
async function through(stream, data) { return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer()); }
function dosTime(ms) {
  const d = new Date(ms);
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
           date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

export async function exportSaves(set) {
  const parts = [], central = [];
  let at = 0;
  for (const s of await listSaves(set)) {
    const data = new Uint8Array(await s.file.arrayBuffer()), packed = await through(new CompressionStream('deflate-raw'), data);
    const name = new TextEncoder().encode(s.name.toUpperCase()), crc = crc32(data), { time, date } = dosTime(s.date);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(8, 8, true);
    local.setUint16(10, time, true); local.setUint16(12, date, true); local.setUint32(14, crc, true);
    local.setUint32(18, packed.length, true); local.setUint32(22, data.length, true); local.setUint16(26, name.length, true);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true); entry.setUint16(10, 8, true);
    entry.setUint16(12, time, true); entry.setUint16(14, date, true); entry.setUint32(16, crc, true);
    entry.setUint32(20, packed.length, true); entry.setUint32(24, data.length, true); entry.setUint16(28, name.length, true);
    entry.setUint32(42, at, true);
    parts.push(local, name, packed); central.push(entry, name);
    at += 30 + name.length + packed.length;
  }
  const size = central.reduce((n, p) => n + p.byteLength, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, central.length / 2, true); end.setUint16(10, central.length / 2, true);
  end.setUint32(12, size, true); end.setUint32(16, at, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

export async function readSaves(blob) {
  try { return await unzip(new Uint8Array(await blob.arrayBuffer())); }
  catch (x) { throw x instanceof RangeError ? new Error('zip 文件损坏') : x; }    // an offset past its end
}
async function unzip(b) {
  const v = new DataView(b.buffer);
  let e = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('不是 zip 文件');
  const out = [], n = v.getUint16(e + 10, true);
  for (let i = 0, p = v.getUint32(e + 16, true); i < n; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('zip 文件损坏');
    const method = v.getUint16(p + 10, true), crc = v.getUint32(p + 16, true), csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
    const path = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nlen)), name = path.slice(path.lastIndexOf('/') + 1);
    p += 46 + nlen + xlen + clen;
    // a save, at the zip's top or in a folder of it (a folder zipped whole), stored or deflated; not macOS's
    // own entries beside it (__MACOSX/._SAVE...)
    if (!SAVE_RE.test(name) || path.startsWith('__MACOSX/') || (method !== 0 && method !== 8)) continue;
    const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true), raw = b.subarray(start, start + csize);
    const data = method === 8 ? await through(new DecompressionStream('deflate-raw'), raw).catch(() => null) : raw.slice();
    if (!data || data.length !== usize || crc32(data) !== crc) throw new Error(`${name} 损坏`);
    out.push({ name: name.toUpperCase(), data });
  }
  return out;
}

export async function writeSaves(set, entries) {
  const d = await dir(set), have = new Map((await listSaves(set)).map((s) => [s.name.toUpperCase(), s.name]));
  for (const { name, data } of entries) {          // over a save of the name in another case, if there is one (win32hle's lookup ignores case)
    const w = await (await d.getFileHandle(have.get(name) ?? name, { create: true })).createWritable();
    await w.write(data);
    await w.close();
  }
}
