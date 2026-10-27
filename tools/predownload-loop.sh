#!/bin/bash
# tools/predownload-loop.sh N [LOAD]: N fresh-site predownloads in Chrome (direct mode, &download), one after another;
# LOAD=1: a Node game running alongside the whole time (as Alice's in pair.sh). Prints each run's outcome.
WEB="$(cd "$(dirname "$0")/.." && pwd)"; cd "$WEB" && . tools/env.sh
N=${1:-10}; OUT=$TMPDIR/predl; mkdir -p $OUT
if [ "${LOAD:-0}" = 1 ]; then
  tools/lan/farm.sh $PWD/work/lan-a > /dev/null
  node host/run.mjs --dir work/lan-a::/game out/ra2.wasm --run --mute --debuglog --watchdog 3000 --exe /game/gamemd.exe --game /game \
    --press 0xE2:1667@1 --press 0x100:1401@2 --press 0x102:1559@3 > $OUT/load.log 2>&1 &
  LP=$!; sleep 20
fi
for i in $(seq 1 $N); do
  t0=$(date +%s)
  node tools/chrome.mjs --page play --timeout 150 --query download -- --run --mute --debuglog --watchdog 3 \
    --exe /game/gamemd.exe --game /game > $OUT/run$i.log 2>&1
  t1=$(date +%s)
  d=$(grep -a -o "predownload\] done: .* in [0-9.]* s" $OUT/run$i.log | grep -o "in [0-9.]* s")
  s=$(grep -a -c "nothing kept\|TIMEOUT" $OUT/run$i.log)
  echo "run $i: $((t1 - t0)) s, download ${d:-NOT DONE}, stall lines $s"
done
[ -n "$LP" ] && kill $LP 2>/dev/null
