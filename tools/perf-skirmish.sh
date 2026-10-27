#!/bin/bash
# The same scripted skirmish (tools/playtest.py's skirmish-start: into a
# skirmish on the default map, H to centre on the base, then nothing) in the
# wasm build, under Node or in Chrome, on the game data's copy (work/game),
# headless and muted, with RA2_FRAME_STATS=1: "[frames] N ms between frame
# copies" every 2000 frame copies.
#   tools/perf-skirmish.sh [wasm|chrome] [SECONDS]
# wasm: under Node (host/run.mjs); chrome: in Chrome (tools/chrome.mjs; . tools/env.sh first).
# Once spike/perf/skirmish.sh, which ran the native build too (native, nomovie, black:
# spike/perf/native-nomovie.sh), for the comparisons docs/wasi.md records; the native build
# is not in this repository (NOTICE.md).
# FAST=1: every GameSpeed in the copy's RA2MD.INI at 0, the fastest, which is
# uncapped (no Sleep between frames), for the run, then put back: the frame
# interval is then what a frame costs.
# Logs: work/runs/perf-<which>[-fast].log
set -u
WEB="$(cd "$(dirname "$0")/.." && pwd)"
cd "$WEB"
WHICH=${1:-wasm} SECS=${2:-150}
SCRIPT=(--run --mute --debuglog --watchdog "$SECS"
        --press 0xE2:1667@1 --press 0x100:1401@2 --press 0x102:1559@3 --waitlog Capture_Mouse@4
        --move 236,240@7 --key 0x48@18)
mkdir -p work/runs
run() {
  local which=$1 log="work/runs/perf-$1${FAST:+-fast}.log" t0 t1
  if [ -n "${FAST:-}" ]; then
    cp work/game/RA2MD.INI work/runs/RA2MD.INI.keep
    perl -pi -e 's/^GameSpeed=\d+/GameSpeed=0/im' work/game/RA2MD.INI
  fi
  t0=$(date +%s)
  if [ "$which" = chrome ]; then
    # the browser build in Chrome (tools/chrome.mjs; its time is the driver's, not Chrome's: no CPU figure)
    node tools/chrome.mjs --timeout $((SECS + 60)) --env RA2_FRAME_STATS=1 -- "${SCRIPT[@]}" \
      --exe /game/gamemd.exe --game /game > "$log" 2>&1
  else
    /usr/bin/time -p node host/run.mjs --env RA2_FRAME_STATS=1 --dir work/game::/game out/ra2.wasm "${SCRIPT[@]}" \
      --exe /game/gamemd.exe --game /game > "$log" 2>&1
  fi
  local code=$?
  t1=$(date +%s)
  [ -n "${FAST:-}" ] && cp work/runs/RA2MD.INI.keep work/game/RA2MD.INI
  echo "== $which${FAST:+ (fast)}: exit $code after $((t1 - t0)) s"
  grep -m3 "\[dialog\] open 0x10[02]\|Capture_Mouse" "$log" | head -3
  grep "\[frames\]\|\[watchdog\]\|TRAP" "$log" | head -12
  # the CPU time the whole process used (every thread; for wasm also V8's compilers)
  grep -E "^(real|user|sys) " "$log" | tr '\n' ' '; echo
}
case "$WHICH" in wasm|chrome) run "$WHICH" ;; *) echo "usage: tools/perf-skirmish.sh [wasm|chrome] [SECONDS]"; exit 2 ;; esac
