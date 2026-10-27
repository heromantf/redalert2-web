#!/bin/bash
# NEEDS THE NATIVE BUILD: redalert2-recomp's (build-macos/ra2, its checkout beside this one), which this
# repository does not carry (NOTICE.md). Kept as the record of what was measured, as RESULT.md is.
# Where GDI text shows: the same screens in the native build (real fonts) and
# the WASI one (no fonts: wasi/sdl.c's TTF_* fail, and gdidc.c draws no GDI
# text and measures with its fallback metrics), frames dumped and compared.
#   spike/gditext/compare.sh            -> work/runs/gditext/<screen>-{native,wasm,diff}.png
# Screens: the skirmish's map list (Choose Map: a list control, whose rows
# GetTextMetricsA may space) and the keyboard options (a list of commands with
# key names, GetKeyNameTextA). Both builds from the same copy of the data.
set -u
WEB="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$WEB"
. tools/env.sh
OUT=work/runs/gditext
rm -rf "$OUT" && mkdir -p "$OUT"
presses() {                    # macOS's bash 3.2: no associative arrays
  case "$1" in
    maplist) echo "--press 0xE2:1667@1 --press 0x100:1401@2 --press 0x102:1450@3" ;;
    keyboard) echo "--press 0xE2:1372@1 --press 0xD5:1486@2" ;;
  esac
}
for screen in maplist keyboard; do
  for which in native wasm; do
    d="$OUT/$screen-$which"; mkdir -p "$d"
    # shellcheck disable=SC2086  # the presses are a list
    if [ "$which" = native ]; then
      ../redalert2-recomp/build-macos/ra2 --headless --run --mute --debuglog --watchdog 35 $(presses "$screen") \
        --dump-frames "$d" --exe work/game/gamemd.exe --game work/game > "$d.log" 2>&1
    else
      node host/run.mjs --dir work/game::/game --dir "$d::/dump" out/ra2.wasm --run --mute --debuglog --watchdog 35 \
        $(presses "$screen") --dump-frames /dump --exe /game/gamemd.exe --game /game > "$d.log" 2>&1
    fi
    last=$(ls "$d"/*.bmp | tail -1)
    sips -s format png "$last" --out "$OUT/$screen-$which.png" >/dev/null 2>&1
    echo "$screen $which: $(grep -a '\[dialog\] open' "$d.log" | tr '\n' ' ') -> $(basename "$last")"
  done
  ffmpeg -v error -y -i "$OUT/$screen-native.png" -i "$OUT/$screen-wasm.png" -lavfi "blend=all_mode=difference,format=gray,geq=lum='if(gt(lum(X,Y),0),255,0)'" "$OUT/$screen-diff.png"
  python3 -I - "$OUT/$screen-diff.png" <<'EOF'
import sys, zlib, struct
def png_gray(path):        # a tiny PNG reader for 8-bit gray, non-interlaced
    b = open(path, 'rb').read(); i = 8; w = h = 0; data = b''
    while i < len(b):
        n, t = struct.unpack('>I4s', b[i:i + 8]); c = b[i + 8:i + 8 + n]; i += 12 + n
        if t == b'IHDR': w, h, depth, ctype = struct.unpack('>IIBB', c[:10])
        elif t == b'IDAT': data += c
    raw = zlib.decompress(data); stride = w + 1; prev = bytearray(w); rows = []
    for y in range(h):
        f = raw[y * stride]; line = bytearray(raw[y * stride + 1:(y + 1) * stride])
        for x in range(w):
            a = line[x - 1] if x else 0; up = prev[x]; ul = prev[x - 1] if x else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + up) & 255
            elif f == 3: line[x] = (line[x] + (a + up) // 2) & 255
            elif f == 4:
                p = a + up - ul; pa, pb, pc = abs(p - a), abs(p - up), abs(p - ul)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else up if pb <= pc else ul)) & 255
        rows.append(line); prev = line
    return w, h, rows
w, h, rows = png_gray(sys.argv[1])
pts = [(x, y) for y, r in enumerate(rows) for x, v in enumerate(r) if v]
if not pts: print(f"  identical ({w}x{h})")
else:
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    print(f"  {len(pts)} of {w * h} pixels differ, within x {min(xs)}-{max(xs)}, y {min(ys)}-{max(ys)}")
EOF
done
