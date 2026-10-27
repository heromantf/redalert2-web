#!/bin/bash
# tools/cache-churn.sh CASE...: tools/playtest.py's cases' scripts in Chrome (fresh sites), and the game's data
# cache turnover: the last "[data] ... cache files N open, M closed" line of each run, the most open.
WEB="$(cd "$(dirname "$0")/.." && pwd)"; cd "$WEB" && . tools/env.sh
OUT=$TMPDIR/churn; mkdir -p $OUT
for c in "$@"; do
  args=$(.venv/bin/python tools/playtest.py --args "$c")
  secs=$(echo "$args" | head -1); mapfile_args=(); while IFS= read -r l; do mapfile_args+=("$l"); done < <(echo "$args" | tail -n +2)
  node tools/chrome.mjs --page play --timeout $((secs + 90)) -- --run --mute --debuglog --watchdog $secs \
    --exe /game/gamemd.exe --game /game "${mapfile_args[@]}" > $OUT/$c.log 2>&1
  last=$(grep -a "cache files" $OUT/$c.log | tail -1 | grep -o "cache files.*")
  peak=$(grep -a -o "cache files [0-9]* open" $OUT/$c.log | grep -o "[0-9]*" | sort -n | tail -1)
  echo "$c ($secs s): ${last:-no cache line}; peak open ${peak:-?}; in game $(grep -a -c 'Capture_Mouse()' $OUT/$c.log)"
done
