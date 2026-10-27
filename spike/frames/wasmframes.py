#!/usr/bin/env python3
"""Per-function frame figures of a wasm module, for phase 0 step 3.

    python3 -I spike/frames/wasmframes.py out/gen.wasm [--json out/frames.json]

For every defined function: its parameters and locals (from the code section),
its body size, and its shadow-stack frame (the `global.get __stack_pointer;
i32.const N; i32.sub` a function with address-taken locals starts with). The
engine-stack estimate is V8's baseline tier, Liftoff, which gives every
parameter and local a slot of its own: 8 bytes each (16 for a v128), plus a
fixed 64 for the frame's header. That is an upper bound for the optimised tier
(TurboFan) and the right figure for a function that never tiers up, which in a
module of ~25,000 functions is most of them.

Reads the binary itself (no wabt): type, import, function, global, code and
the name section's function (1) and global (7) names.
"""
import argparse
import json
import sys


def leb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1
        r |= (x & 0x7F) << s; s += 7
        if x < 0x80:
            return r, i


def sleb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1
        r |= (x & 0x7F) << s; s += 7
        if x < 0x80:
            if x & 0x40:
                r -= 1 << s
            return r, i


def valtype(b, i):
    t = b[i]; i += 1
    if t in (0x63, 0x64):           # (ref null? heaptype)
        _, i = sleb(b, i)
    return t, i


def limits(b, i):
    f = b[i]; i += 1
    _, i = leb(b, i)
    if f & 1:
        _, i = leb(b, i)
    return i


def name(b, i):
    n, i = leb(b, i)
    return b[i:i + n].decode('utf-8', 'replace'), i + n


def parse(b):
    assert b[:4] == b'\0asm', 'not a wasm module'
    i = 8
    types, imported_funcs, imported_globals, funcs, bodies = [], 0, 0, [], []
    fnames, gnames = {}, {}
    while i < len(b):
        sid = b[i]; i += 1
        size, i = leb(b, i)
        end = i + size
        if sid == 1:                                  # types
            n, j = leb(b, i)
            for _ in range(n):
                form = b[j]; j += 1
                if form == 0x4E:                      # rec group: not expected here
                    raise SystemExit('GC rec types: not handled')
                assert form == 0x60, hex(form)
                np, j = leb(b, j)
                ps = []
                for _ in range(np):
                    t, j = valtype(b, j); ps.append(t)
                nr, j = leb(b, j)
                for _ in range(nr):
                    _, j = valtype(b, j)
                types.append(ps)
        elif sid == 2:                                # imports
            n, j = leb(b, i)
            for _ in range(n):
                _, j = name(b, j); _, j = name(b, j)
                kind = b[j]; j += 1
                if kind == 0:
                    _, j = leb(b, j); imported_funcs += 1
                elif kind == 1:
                    _, j = valtype(b, j); j = limits(b, j)
                elif kind == 2:
                    j = limits(b, j)
                elif kind == 3:
                    _, j = valtype(b, j); j += 1; imported_globals += 1
                elif kind == 4:
                    j += 1; _, j = leb(b, j)
        elif sid == 3:                                # function -> type
            n, j = leb(b, i)
            for _ in range(n):
                t, j = leb(b, j); funcs.append(t)
        elif sid == 10:                               # code
            n, j = leb(b, i)
            for _ in range(n):
                sz, j = leb(b, j)
                bodies.append((j, sz)); j += sz
        elif sid == 0:                                # custom: the name section
            nm, j = name(b, i)
            if nm == 'name':
                while j < end:
                    sub = b[j]; j += 1
                    ssz, j = leb(b, j)
                    send = j + ssz
                    if sub in (1, 7):
                        cnt, k = leb(b, j)
                        for _ in range(cnt):
                            idx, k = leb(b, k); s, k = name(b, k)
                            (fnames if sub == 1 else gnames)[idx] = s
                    j = send
        i = end
    sp = next((k for k, v in gnames.items() if v == '__stack_pointer'), None)
    out = []
    for n, ((off, sz), t) in enumerate(zip(bodies, funcs)):
        j = off
        nd, j = leb(b, j)
        nloc = nv128 = 0
        for _ in range(nd):
            c, j = leb(b, j); vt, j = valtype(b, j)
            nloc += c
            if vt == 0x7B:
                nv128 += c
        params = types[t]
        shadow = 0
        if sp is not None:                            # global.get sp; i32.const N; i32.sub
            k, stop = j, min(j + 24, off + sz)
            while k < stop:
                if b[k] == 0x23:
                    g, k2 = leb(b, k + 1)
                    if g == sp and k2 < stop and b[k2] == 0x41:
                        c, k3 = sleb(b, k2 + 1)
                        if k3 < off + sz and b[k3] == 0x6B:
                            shadow = c
                            break
                k += 1
        slots = len(params) + nloc
        liftoff = 64 + 8 * (slots - nv128) + 16 * nv128 + 8 * sum(1 for p in params if p == 0x7B)
        out.append({'name': fnames.get(imported_funcs + n, 'f%d' % (imported_funcs + n)),
                    'params': len(params), 'locals': nloc, 'body': sz,
                    'shadow': shadow, 'liftoff': liftoff})
    return out


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p / 100.0 * len(xs)))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('wasm')
    ap.add_argument('--json')
    a = ap.parse_args()
    fs = parse(open(a.wasm, 'rb').read())
    lifted = [f for f in fs if f['name'].startswith('sub_') or '__' in f['name']]
    print('defined functions: %d (named lifted-looking: %d)' % (len(fs), len(lifted)))
    print('code: %.1f MB of function bodies' % (sum(f['body'] for f in fs) / 1e6))
    for key, label in (('locals', 'locals'), ('liftoff', 'Liftoff frame estimate (bytes)'),
                       ('shadow', 'shadow-stack frame (bytes)')):
        xs = [f[key] for f in fs]
        print('%-32s median %d, p90 %d, p99 %d, max %d' % (label, pct(xs, 50), pct(xs, 90), pct(xs, 99), max(xs)))
    print('largest Liftoff frames:')
    for f in sorted(fs, key=lambda f: -f['liftoff'])[:15]:
        print('  %8d B  %6d locals  %8d B body  %6d B shadow  %s' % (f['liftoff'], f['locals'], f['body'], f['shadow'], f['name']))
    if a.json:
        json.dump(fs, open(a.json, 'w'))


if __name__ == '__main__':
    sys.exit(main())
