#!/usr/bin/env python3
"""The deepest lifted nesting stackmark saw, frame by frame, native against wasm.

    python3 -I spike/frames/compare.py out/frames.json out/stackmark/lifted-*.txt

A lifted-<pid>.txt (spike/stackmark) is one native chain, a line a frame:
bytes, L for lifted code, the symbol, the image. FRAMES.json is wasmframes.py
--json of the module. For each chain the lifted frames' native bytes are set
against their wasm frames: engine stack (the Liftoff estimate) and shadow
stack (linear memory) apart, since only the first counts against a worker's
~1 MB. Frames not lifted (the runtime, libraries) are left out: in wasm they
are different code, or none.
"""
import json
import sys


def main():
    frames = {f['name']: f for f in json.load(open(sys.argv[1]))}
    worst = None
    for path in sys.argv[2:]:
        nat = eng = sh = n = missing = 0
        for line in open(path):
            parts = line.split()
            if len(parts) < 3 or parts[1] != 'L':
                continue
            name = parts[2]
            n += 1
            nat += int(parts[0])
            f = frames.get(name)
            if f is None:
                missing += 1
                continue
            eng += f['liftoff']
            sh += f['shadow']
        row = (eng, path, n, nat, sh, missing)
        print('%s: %d lifted frames, native %d B -> wasm engine %d B + shadow %d B%s' %
              (path.rsplit('/', 1)[-1], n, nat, eng, sh, ' (%d not in the module)' % missing if missing else ''))
        if worst is None or row > worst:
            worst = row
    if worst:
        eng, path, n, nat, sh, _ = worst
        print('largest: %d lifted frames, %.1f KB native, %.1f KB engine stack (%.1fx), %.1f KB shadow stack'
              % (n, nat / 1024, eng / 1024, eng / nat if nat else 0, sh / 1024))


if __name__ == '__main__':
    sys.exit(main())
