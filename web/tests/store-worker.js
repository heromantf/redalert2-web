// The save store and the backend's overlay, tried out in a worker (where OPFS's
// synchronous handles are): web/tests/store.html runs it twice, the second time
// after a reload, and each pass reports { ok, fails, lines }.
//   pass 1: a fresh set; new, copied, written, truncated, renamed (an overlay
//           file and a data file), deleted (both), a folder made with a file in
//           it; a file opened twice at once.
//   pass 2: what pass 1 left is there, with its bytes; what it deleted is gone.
import { httpBackend } from '../http-backend.js';

const te = new TextEncoder(), td = new TextDecoder();
onmessage = async (e) => {
  const pass = e.data.pass, lines = [];
  let fails = 0;
  const ok = (what, c) => { lines.push(`${c ? 'ok  ' : 'FAIL'} ${what}`); if (!c) fails++; };
  try {
    const b = await httpBackend({ save: 'store-test', fresh: pass === 1, note: (s) => lines.push('     ' + s) });
    const text = async (rel) => {
      const st = await b.stat(0, rel); if (!st) return null;
      const h = await b.open(0, rel, { read: true }), d = new Uint8Array(st.size);
      const k = await b.read(h, 0, d); await b.close(h);
      return td.decode(d.subarray(0, k));
    };
    const put = async (rel, s, o = { write: true, create: true, trunc: true }) => {
      const h = await b.open(0, rel, o); await b.write(h, 0, te.encode(s)); await b.close(h);
    };
    if (pass === 1) {
      await put('new.txt', 'hello');
      ok('a new file reads back', await text('new.txt') === 'hello');
      const h = await b.open(0, 'RA2MD.INI', { write: true, read: true });   // a data file, copied first
      const size = await b.size(h);
      await b.write(h, size, te.encode('\n; web\n')); await b.close(h);
      ok('a data file written keeps its own bytes', (await text('RA2MD.INI')).endsWith('\n; web\n') && (await text('RA2MD.INI')).length === size + 7);
      await put('short.txt', 'abcdef');
      const t = await b.open(0, 'short.txt', { write: true }); await b.truncate(t, 3); await b.close(t);
      ok('truncated', await text('short.txt') === 'abc');
      await put('from.txt', 'moved'); await b.rename(0, 'from.txt', 0, 'to.txt');
      ok('renamed: the new name has it', await text('to.txt') === 'moved');
      ok('renamed: the old name is gone', !(await b.stat(0, 'from.txt')));
      await b.rename(0, 'readmeyuri3.txt', 0, 'readme-renamed.txt');            // a data file renamed
      ok('a data file renamed', (await text('readme-renamed.txt'))?.length > 0 && !(await b.stat(0, 'readmeyuri3.txt')));
      await put('doomed.txt', 'x'); await b.unlink(0, 'doomed.txt');
      ok('an overlay file deleted', !(await b.stat(0, 'doomed.txt')));
      await b.unlink(0, 'readmeyuri4.txt');
      ok('a data file deleted', !(await b.stat(0, 'readmeyuri4.txt')) && !(await b.list(0, '')).some((x) => x.name === 'readmeyuri4.txt'));
      await b.mkdir(0, 'Saved'); await put('Saved/game1.sav', 'save one');
      ok('a folder and a file in it', (await b.list(0, 'Saved')).some((x) => x.name === 'game1.sav') && await text('Saved/game1.sav') === 'save one');
      const h1 = await b.open(0, 'twice.txt', { write: true, create: true }), h2 = await b.open(0, 'twice.txt', { read: true });
      await b.write(h1, 0, te.encode('both')); const d = new Uint8Array(4); await b.read(h2, 0, d); await b.close(h1); await b.close(h2);
      ok('a file open twice at once', td.decode(d) === 'both');
    } else {
      ok('kept: new.txt', await text('new.txt') === 'hello');
      ok('kept: RA2MD.INI with its change', (await text('RA2MD.INI'))?.endsWith('\n; web\n'));
      ok('kept: truncated', await text('short.txt') === 'abc');
      ok('kept: renamed', await text('to.txt') === 'moved' && !(await b.stat(0, 'from.txt')));
      ok('kept: the data file renamed', (await text('readme-renamed.txt'))?.length > 0 && !(await b.stat(0, 'readmeyuri3.txt')));
      ok('kept: the data file deleted', !(await b.stat(0, 'readmeyuri4.txt')));
      ok('kept: the folder and its file', await text('Saved/game1.sav') === 'save one');
      ok('untouched: other data files', (await b.stat(0, 'readmeyuri5.txt'))?.size > 0);
    }
    lines.push(`store: ${b.stats().store}`);
  } catch (x) { fails++; lines.push(`FAIL ${x?.stack ?? x}`); }
  postMessage({ ok: !fails, fails, lines });
};
