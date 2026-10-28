// The page's log, the whole of it, to hand on: every line the page and the game
// print (play.html's log()), held for the session (the last MAX_LINES),
// downloaded as a text file or copied whole, a header of the page and the
// browser first. The page's own thread keeps it, so a game that hangs (it runs
// in workers) leaves it to be had.
//   const pl = pageLog()
//   pl.add(line)                  a line (play.html's log() calls it)
//   pl.text()                     the session's, the header first
//   pl.download(), pl.copy() -> true | false
const MAX_LINES = 20000;

export function pageLog() {
  const lines = [], started = new Date();
  const text = () => [
    `ra2web log, the page opened ${started.toString()}, taken ${new Date().toString()}`,
    `page ${location.href}`,
    `browser ${navigator.userAgent}`,
    '',
    ...lines,
    '',
  ].join('\n');
  const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
  return {
    add(line) { lines.push(line); if (lines.length > MAX_LINES) lines.shift(); },
    text,
    download() {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text()], { type: 'text/plain;charset=utf-8' }));
      a.download = `ra2-log-${stamp()}.txt`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    },
    async copy() {
      try { await navigator.clipboard.writeText(text()); return true; } catch { return false; }
    },
  };
}
