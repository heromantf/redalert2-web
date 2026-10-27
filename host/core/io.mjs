// The process's file system, whatever stores the files: the WASI file calls
// game threads post into their RPC slots, served against a backend, with the
// results written straight into the shared wasm memory. The same code runs in
// Node's I/O worker (host/node/fs-backend.mjs: the host's directories) and the
// browser's (web/http-backend.js: the game data over HTTP, the game's writes
// in an overlay).
//
// A backend is a list of mounts (preopened directories, fd 3, 4, ... in order)
// and these calls, each of which may return a promise; a failure throws
// { errno } (a WASI errno) or a Node-style { code }:
//   stat(m, rel)            -> { dir: bool, size, mtimeNs, ino } or null (no such file)
//   list(m, rel)            -> [{ name, dir }]
//   open(m, rel, { read, write, create, excl, trunc }) -> a handle
//   read(h, pos, dst)       -> bytes put into dst (a Uint8Array over wasm memory)
//   write(h, pos, src)      -> bytes taken from src
//   size(h), truncate(h, n), sync(h), close(h), times(h | [m, rel], atimeMs, mtimeMs)
//   mkdir(m, rel), rmdir(m, rel), unlink(m, rel), rename(m, rel, m2, rel2)
// Paths stay inside their mount (a ".." above its root is refused). Names
// match exactly: win32hle (hle_path.c) does Windows' case-insensitive lookup
// itself, through fd_readdir.
//
// The RPC protocol and the WASI structures are nfsu2-web's
// (web/src/host/io-worker.ts, MIT; see ../../NOTICE.md).
import { CTL_IO_DOORBELL, E, MAX_THREADS, Op, RPC_DONE, RPC_POSTED, RPC_SLOT, RPC_TAKEN } from '../proto.mjs';

const FT_UNKNOWN = 0, FT_DIR = 3, FT_FILE = 4;
const CODES = { ENOENT: E.NOENT, EEXIST: E.EXIST, EISDIR: E.ISDIR, ENOTDIR: E.NOTDIR, EACCES: E.ACCES, EPERM: E.PERM,
  ENOTEMPTY: E.NOTEMPTY, EINVAL: E.INVAL, EBADF: E.BADF, ENOSPC: E.NOSPC, EMFILE: E.MFILE, ENAMETOOLONG: E.NAMETOOLONG,
  EROFS: E.ROFS, ESPIPE: E.SPIPE, EXDEV: 75, ELOOP: 32 };
export const errnoOf = (x) => (typeof x?.errno === 'number' && x.errno > 0 && x.errno < 100 && !x.code ? x.errno : CODES[x?.code]) ?? E.IO;

export function startIo({ memory, ctl: ctlBuf, rpc, backend, note = () => {} }) {
  const td = new TextDecoder(), te = new TextEncoder();
  const ctl = new Int32Array(ctlBuf), rpcI32 = new Int32Array(rpc), rpcI64 = new BigInt64Array(rpc);
  const u8 = () => new Uint8Array(memory.buffer);
  const dv = () => new DataView(memory.buffer);

  // { dir, m (mount), rel, h (backend handle), pos, append, preopen?, dirents? }
  const fds = new Map();
  let nextFd = 3;
  const allocFd = (f) => { while (fds.has(nextFd)) nextFd++; fds.set(nextFd, f); return nextFd++; };
  backend.mounts.forEach((g, m) => allocFd({ dir: true, m, rel: '', pos: 0, append: false, preopen: g }));

  const readPath = (p, l) => td.decode(u8().slice(p, p + l));
  function normRel(s) {
    const out = [];
    for (const p of s.split('/')) { if (!p || p === '.') continue; if (p === '..') { if (!out.length) return null; out.pop(); } else out.push(p); }
    return out.join('/');
  }
  const relIn = (dir, p, l) => normRel((dir.rel ? dir.rel + '/' : '') + readPath(p, l));
  function iovs(iov, n) {
    const d = dv(), a = [];
    for (let i = 0; i < n; i++) a.push({ ptr: d.getUint32(iov + 8 * i, true), len: d.getUint32(iov + 8 * i + 4, true) });
    return a;
  }
  const inos = new Map();
  const inoOf = (m, rel) => { const k = m + ':' + rel; let i = inos.get(k); if (!i) inos.set(k, i = inos.size + 16); return i; };
  const big = (v) => (typeof v === 'bigint' ? v : BigInt(Math.round(v ?? 0)));
  function writeFilestat(p, st, m, rel) {
    const d = dv(), ns = big(st.mtimeNs);
    d.setBigUint64(p, 1n, true); d.setBigUint64(p + 8, big(st.ino ?? inoOf(m, rel)), true); d.setUint8(p + 16, st.dir ? FT_DIR : FT_FILE);
    d.setBigUint64(p + 24, 1n, true); d.setBigUint64(p + 32, big(st.dir ? 0 : st.size), true);
    d.setBigUint64(p + 40, ns, true); d.setBigUint64(p + 48, ns, true); d.setBigUint64(p + 56, ns, true);
  }
  // fst_flags: 1 ATIM, 2 ATIM_NOW, 4 MTIM, 8 MTIM_NOW; times in ms for the backend (undefined: keep)
  const timesOf = (a, m, fl) => [fl & 2 ? Date.now() : fl & 1 ? Number(a) / 1e6 : undefined, fl & 8 ? Date.now() : fl & 4 ? Number(m) / 1e6 : undefined];

  async function op(o, a) {
    const n = (i) => Number(a[i]);
    const fdOf = (i) => fds.get(n(i));
    switch (o) {
      case Op.FdPrestatGet: {
        const f = fdOf(0); if (!f?.preopen) return E.BADF;
        const d = dv(); d.setUint8(n(1), 0); d.setUint32(n(1) + 4, te.encode(f.preopen).length, true); return 0;
      }
      case Op.FdPrestatDirName: {
        const f = fdOf(0); if (!f?.preopen) return E.BADF;
        u8().set(te.encode(f.preopen).subarray(0, n(2)), n(1)); return 0;
      }
      case Op.PathOpen: {           // (dirfd, dirflags, path, pathlen, oflags, rights_base, rights_inh, fdflags, &fd)
        const dir = fdOf(0); if (!dir?.dir) return E.BADF;
        const rel = relIn(dir, n(2), n(3)); if (rel === null) return E.PERM;
        const oflags = n(4), fdflags = n(7), rights = a[5];
        const read = (rights & 0x2n) !== 0n, write = (rights & 0x40n) !== 0n;   // FD_READ, FD_WRITE
        const st = await backend.stat(dir.m, rel);
        if (st?.dir) {
          if (oflags & 4) return E.EXIST;
          if (write) return E.ISDIR;
          dv().setUint32(n(8), allocFd({ dir: true, m: dir.m, rel, pos: 0, append: false }), true); return 0;
        }
        if (oflags & 2) return st ? E.NOTDIR : E.NOENT;
        if (!st && !(oflags & 1)) return E.NOENT;
        if (st && oflags & 4) return E.EXIST;
        const h = await backend.open(dir.m, rel, { read, write, create: !!(oflags & 1), excl: !!(oflags & 4), trunc: !!(oflags & 8) });
        dv().setUint32(n(8), allocFd({ dir: false, m: dir.m, rel, h, pos: 0, append: !!(fdflags & 1) }), true); return 0;
      }
      case Op.FdClose: {
        const f = fdOf(0); if (!f) return E.BADF;
        if (f.preopen) return 0;
        fds.delete(n(0));
        if (!f.dir) await backend.close(f.h);
        return 0;
      }
      case Op.FdRead: case Op.FdPread: {
        const f = fdOf(0); if (!f) return E.BADF; if (f.dir) return E.ISDIR;
        const pread = o === Op.FdPread, out = pread ? n(4) : n(3);
        let pos = pread ? n(3) : f.pos, got = 0;
        for (const d of iovs(n(1), n(2))) {
          if (!d.len) continue;
          const k = await backend.read(f.h, pos, new Uint8Array(memory.buffer, d.ptr, d.len));
          pos += k; got += k;
          if (k < d.len) break;
        }
        if (!pread) f.pos = pos;
        dv().setUint32(out, got, true); return 0;
      }
      case Op.FdWrite: case Op.FdPwrite: {
        const f = fdOf(0); if (!f) return E.BADF; if (f.dir) return E.ISDIR;
        const pw = o === Op.FdPwrite;
        let pos = pw ? n(3) : f.append ? await backend.size(f.h) : f.pos, put = 0;
        for (const s of iovs(n(1), n(2))) {
          if (!s.len) continue;
          const k = await backend.write(f.h, pos, new Uint8Array(memory.buffer, s.ptr, s.len));
          pos += k; put += k;
        }
        if (!pw) f.pos = pos;
        dv().setUint32(pw ? n(4) : n(3), put, true); return 0;
      }
      case Op.FdSeek: {
        const f = fdOf(0); if (!f) return E.BADF; if (f.dir) return E.ISDIR;
        const wh = n(2), base = wh === 0 ? 0 : wh === 1 ? f.pos : await backend.size(f.h);
        const np = base + Number(BigInt.asIntN(64, a[1]));
        if (np < 0) return E.INVAL;
        f.pos = np; dv().setBigUint64(n(3), BigInt(np), true); return 0;
      }
      case Op.FdTell: { const f = fdOf(0); if (!f) return E.BADF; dv().setBigUint64(n(1), BigInt(f.pos), true); return 0; }
      case Op.FdSync: { const f = fdOf(0); if (!f) return E.BADF; if (!f.dir) await backend.sync(f.h); return 0; }
      case Op.FdFdstatGet: {
        const f = fdOf(0); if (!f) return E.BADF;
        const d = dv(), p = n(1);
        d.setUint8(p, f.dir ? FT_DIR : FT_FILE); d.setUint16(p + 2, f.append ? 1 : 0, true);
        d.setBigUint64(p + 8, 0x1FFFFFFFn, true); d.setBigUint64(p + 16, 0x1FFFFFFFn, true); return 0;
      }
      case Op.FdFdstatSetFlags: { const f = fdOf(0); if (!f) return E.BADF; f.append = !!(n(1) & 1); return 0; }
      case Op.FdFilestatGet: {
        const f = fdOf(0); if (!f) return E.BADF;
        const st = f.dir ? await backend.stat(f.m, f.rel) : { ...(await backend.stat(f.m, f.rel) ?? { dir: false }), size: await backend.size(f.h) };
        if (!st) return E.NOENT;
        writeFilestat(n(1), st, f.m, f.rel); return 0;
      }
      case Op.FdFilestatSetSize: { const f = fdOf(0); if (!f || f.dir) return E.BADF; await backend.truncate(f.h, n(1)); return 0; }
      case Op.FdAllocate: {
        const f = fdOf(0); if (!f || f.dir) return E.BADF;
        const need = n(1) + n(2); if (await backend.size(f.h) < need) await backend.truncate(f.h, need); return 0;
      }
      case Op.FdFilestatSetTimes: {
        const f = fdOf(0); if (!f || f.dir) return E.BADF;
        await backend.times(f.h, ...timesOf(a[1], a[2], n(3))); return 0;
      }
      case Op.PathFilestatSetTimes: {      // (dirfd, flags, path, len, atim, mtim, fst_flags)
        const dir = fdOf(0); if (!dir?.dir) return E.BADF;
        const rel = relIn(dir, n(2), n(3)); if (rel === null) return E.PERM;
        await backend.times([dir.m, rel], ...timesOf(a[4], a[5], n(6))); return 0;
      }
      case Op.PathFilestatGet: {           // (dirfd, flags, path, len, &filestat)
        const dir = fdOf(0); if (!dir?.dir) return E.BADF;
        const rel = relIn(dir, n(2), n(3)); if (rel === null) return E.PERM;
        const st = await backend.stat(dir.m, rel); if (!st) return E.NOENT;
        writeFilestat(n(4), st, dir.m, rel); return 0;
      }
      case Op.FdReaddir: {                 // (fd, buf, len, cookie, &used)
        const f = fdOf(0); if (!f) return E.BADF; if (!f.dir) return E.NOTDIR;
        if (!f.dirents || a[3] === 0n) {
          f.dirents = [{ name: '.', type: FT_DIR }, { name: '..', type: FT_DIR }];
          for (const e of await backend.list(f.m, f.rel)) f.dirents.push({ name: e.name, type: e.dir ? FT_DIR : e.dir === false ? FT_FILE : FT_UNKNOWN });
        }
        const buf = n(1), len = n(2), mem = u8();
        let used = 0;
        for (let i = Number(a[3]); i < f.dirents.length && used < len; i++) {
          const e = f.dirents[i], nm = te.encode(e.name), rec = new Uint8Array(24 + nm.length), hv = new DataView(rec.buffer);
          hv.setBigUint64(0, BigInt(i + 1), true); hv.setBigUint64(8, BigInt(i + 1), true); hv.setUint32(16, nm.length, true); hv.setUint8(20, e.type);
          rec.set(nm, 24);
          const k = Math.min(rec.length, len - used); mem.set(rec.subarray(0, k), buf + used); used += k;
        }
        dv().setUint32(n(4), used, true); return 0;
      }
      case Op.PathCreateDirectory: {
        const dir = fdOf(0); if (!dir?.dir) return E.BADF;
        const rel = relIn(dir, n(1), n(2)); if (!rel) return E.PERM;
        await backend.mkdir(dir.m, rel); return 0;
      }
      case Op.PathRemoveDirectory: case Op.PathUnlinkFile: {
        const dir = fdOf(0); if (!dir?.dir) return E.BADF;
        const rel = relIn(dir, n(1), n(2)); if (!rel) return E.PERM;
        await (o === Op.PathRemoveDirectory ? backend.rmdir(dir.m, rel) : backend.unlink(dir.m, rel)); return 0;
      }
      case Op.PathRename: {
        const da = fdOf(0), db = fdOf(3); if (!da?.dir || !db?.dir) return E.BADF;
        const ra = relIn(da, n(1), n(2)), rb = relIn(db, n(4), n(5)); if (!ra || !rb) return E.PERM;
        await backend.rename(da.m, ra, db.m, rb); return 0;
      }
      case Op.FdRenumber: {
        const f = fdOf(0), t = fdOf(1); if (!f) return E.BADF;
        if (t && !t.preopen && !t.dir && t !== f) await backend.close(t.h);
        fds.delete(n(0)); fds.set(n(1), f); return 0;
      }
      case Op.FdAdvise: return 0;
    }
    return E.NOSYS;
  }

  // The doorbell is read before the slots are looked at, so a request posted
  // meanwhile changes it and the wait returns at once. Requests are served as
  // they come, each to its end before the next (the backends are fast, or keep
  // their own concurrency); the timeout is only a net.
  async function serve() {
    for (;;) {
      const seen = Atomics.load(ctl, CTL_IO_DOORBELL);
      let any = false;
      for (let s = 0; s < MAX_THREADS; s++) {
        const b = s * (RPC_SLOT / 4);
        if (Atomics.compareExchange(rpcI32, b, RPC_POSTED, RPC_TAKEN) !== RPC_POSTED) continue;
        any = true;
        const opc = rpcI32[b + 1], nargs = rpcI32[b + 3], b64 = s * (RPC_SLOT / 8), args = [];
        for (let i = 0; i < nargs; i++) args.push(rpcI64[b64 + 2 + i]);
        let r;
        try { r = await op(opc, args); } catch (x) { r = errnoOf(x); if (r === E.IO) note(`[io] op ${opc}: ${x?.stack ?? x}`); }
        rpcI32[b + 2] = r; Atomics.store(rpcI32, b, RPC_DONE); Atomics.notify(rpcI32, b);
      }
      if (!any) { const w = Atomics.waitAsync(ctl, CTL_IO_DOORBELL, seen, 50); if (w.async) await w.value; }
    }
  }
  return serve();
}
