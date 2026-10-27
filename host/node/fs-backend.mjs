// The I/O worker's backend under Node (../core/io.mjs): host directories as the
// mounts, through node:fs, synchronously. Symbolic links on the host are
// followed.
import fs from 'node:fs';
import path from 'node:path';

export function fsBackend(mounts) {               // [{ host, guest }]
  const roots = mounts.map((m) => m.host);
  const at = (m, rel) => (rel ? path.join(roots[m], rel) : roots[m]);
  const C = fs.constants;
  const isDir = (full) => { try { return fs.statSync(full).isDirectory(); } catch { return undefined; } };
  return {
    mounts: mounts.map((m) => m.guest),
    stat(m, rel) {
      try {
        const st = fs.statSync(at(m, rel), { bigint: true });
        return { dir: st.isDirectory(), size: st.size, mtimeNs: st.mtimeNs, ino: st.ino };
      } catch (x) { if (x.code === 'ENOENT' || x.code === 'ENOTDIR') return null; throw x; }
    },
    list(m, rel) {
      const dir = at(m, rel);
      return fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({
        name: e.name, dir: e.isDirectory() ? true : e.isFile() ? false : isDir(path.join(dir, e.name)),
      }));
    },
    open(m, rel, o) {
      let fl = o.read && o.write ? C.O_RDWR : o.write ? C.O_WRONLY : C.O_RDONLY;
      if (o.create) fl |= C.O_CREAT;
      if (o.excl) fl |= C.O_EXCL;
      if (o.trunc) fl |= C.O_TRUNC;
      return { fd: fs.openSync(at(m, rel), fl, 0o644) };
    },
    read: (h, pos, dst) => fs.readSync(h.fd, dst, 0, dst.length, pos),
    write: (h, pos, src) => fs.writeSync(h.fd, src, 0, src.length, pos),
    size: (h) => fs.fstatSync(h.fd).size,
    truncate: (h, n) => fs.ftruncateSync(h.fd, n),
    sync: (h) => fs.fsyncSync(h.fd),
    close: (h) => fs.closeSync(h.fd),
    times(t, atimeMs, mtimeMs) {
      const byPath = Array.isArray(t), st = byPath ? fs.statSync(at(...t)) : fs.fstatSync(t.fd);
      const a = (atimeMs ?? st.atimeMs) / 1000, mt = (mtimeMs ?? st.mtimeMs) / 1000;
      if (byPath) fs.utimesSync(at(...t), a, mt); else fs.futimesSync(t.fd, a, mt);
    },
    mkdir: (m, rel) => fs.mkdirSync(at(m, rel)),
    rmdir: (m, rel) => fs.rmdirSync(at(m, rel)),
    unlink: (m, rel) => fs.unlinkSync(at(m, rel)),
    rename: (m, rel, m2, rel2) => fs.renameSync(at(m, rel), at(m2, rel2)),
  };
}
