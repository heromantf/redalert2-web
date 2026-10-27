/* tools/lan/lobby-eval.js: an expression for tools/chrome.mjs --eval (two-rooms.sh): the game's own LAN lobby,
   its players (0xA8DA44), its rooms (0xA8DA5C, each open or in progress) and this room's players (0xA8DA74).
   A block comment: the script joins the lines into one. */
(() => { const dv = new DataView(ra2web.memory.buffer), u = (a) => dv.getUint32(a, true);
  const names = (vec) => { const items = u(vec + 4), n = u(vec + 0x10), out = []; for (let i = 0; i < n; i++) { const p = u(items + 4 * i); let s = ''; for (let j = 0; p && j < 20; j++) { const c = dv.getUint16(p + 2 * j, true); if (!c) break; s += String.fromCharCode(c); } out.push(s || '-'); } return out; };
  const open = (vec) => { const items = u(vec + 4), n = u(vec + 0x10), out = []; for (let i = 0; i < n; i++) { const p = u(items + 4 * i); out.push(p ? dv.getUint8(p + 52) : '-'); } return out.join(''); };
  return `lobby ${u(0xA8DA54)}: ${names(0xA8DA44).join(',')} | rooms ${u(0xA8DA6C)}: ${names(0xA8DA5C).join(',')} (open ${open(0xA8DA5C)}) | this room ${u(0xA8DA84)}: ${names(0xA8DA74).join(',')}`; })()
