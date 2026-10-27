// How deep a wasm recursion goes before the engine's stack runs out, in
// whatever runs this: a Node worker, a Chrome worker, a main thread. The same
// code everywhere (run.sh puts it into each), so the depths compare.
//
// The module, written out by hand: one function rec(n) that calls itself n
// deep. Two kinds of frame: "small" (only its parameter) and "16 locals" (16
// i64 locals set before the call and read after it, so they live across it, as
// a lifted function's registers do). Each round searches the largest n that
// does not throw (doubling, then halving the gap); three rounds, because the
// engine moves a hot function from its baseline tier (Liftoff) to the
// optimising one (TurboFan) as it runs, and frames change size with it.

function leb(n) { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return b; }
function sleb(n) { const b = []; for (;;) { const x = n & 0x7f; n >>= 7; if ((n === 0 && !(x & 0x40)) || (n === -1 && (x & 0x40))) { b.push(x); return b; } b.push(x | 0x80); } }
function section(id, bytes) { return [id, ...leb(bytes.length), ...bytes]; }

function recModule(locals) {
  const body = [];
  body.push(...(locals ? [1, ...leb(locals), 0x7e] : [0]));          // locals: K x i64
  body.push(0x20, 0, 0x45, 0x04, 0x7f, 0x41, 0);                     // n == 0 ? 0 :
  body.push(0x05);
  for (let k = 1; k <= locals; k++) body.push(0x42, ...sleb(k), 0x21, k);   // local k = k
  body.push(0x20, 0, 0x41, 1, 0x6b, 0x10, 0);                        // rec(n - 1)
  if (locals) {
    body.push(0xac);                                                  // i64.extend_i32_s
    for (let k = 1; k <= locals; k++) body.push(0x20, k, 0x7c);      // + local k
    body.push(0xa7);                                                  // i32.wrap_i64
  }
  body.push(0x41, 1, 0x6a, 0x0b, 0x0b);                              // + 1
  const type = section(1, [1, 0x60, 1, 0x7f, 1, 0x7f]);
  const func = section(3, [1, 0]);
  const exp = section(7, [1, 3, 0x72, 0x65, 0x63, 0, 0]);            // "rec"
  const code = section(10, [1, ...leb(body.length), ...body]);
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...type, ...func, ...exp, ...code]);
}

function fits(rec, n) { try { rec(n); return true; } catch (e) { if (e instanceof RangeError) return false; throw e; } }
function deepest(rec) {
  let lo = 1, hi = 2;
  while (fits(rec, hi)) { lo = hi; hi *= 2; if (hi > 1 << 26) return lo; }
  while (hi - lo > 1) { const mid = (lo + hi) >>> 1; if (fits(rec, mid)) lo = mid; else hi = mid; }
  return lo;
}

function runProbe() {
  const out = {};
  for (const [name, locals] of [['small', 0], ['16 locals', 16]]) {
    const rec = new WebAssembly.Instance(new WebAssembly.Module(recModule(locals))).exports.rec;
    out[name] = [deepest(rec), deepest(rec), deepest(rec)];
  }
  return out;
}
