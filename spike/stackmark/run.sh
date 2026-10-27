#!/bin/bash
# NEEDS THE NATIVE BUILD: redalert2-recomp's (build-macos/ra2, its checkout beside this one), which this
# repository does not carry (NOTICE.md). Kept as the record of what was measured, as RESULT.md is.
# Phase 0, step 1: the native game thread's deepest stack, over playtest cases.
#   spike/stackmark/run.sh [case ...]     (default: the set below)
# Builds stackmark.dylib into out/, runs the cases with it injected, and
# prints each case's result line, its deepest stack and the deepest chain
# sampled and the one with the most lifted frames (frame by frame:
# out/stackmark/chain-<pid>.txt, lifted-<pid>.txt).
set -eu
WEB="$(cd "$(dirname "$0")/../.." && pwd)"
RA2="$WEB/../redalert2-recomp"
mkdir -p "$WEB/out/stackmark"
cc -O2 -Wall -dynamiclib -o "$WEB/out/stackmark.dylib" "$WEB/spike/stackmark/stackmark.c"
CASES=${*:-"skirmish-start skirmish-build skirmish-forcefire campaign-allied campaign-soviet menu-options movies-credits skirmish-loop"}
cd "$RA2"
# shellcheck disable=SC2086  # CASES is a list
STACKMARK_DIR="$WEB/out/stackmark" DYLD_INSERT_LIBRARIES="$WEB/out/stackmark.dylib" \
  .venv/bin/python tools/playtest.py $CASES --jobs 4 | tail -n 12
for c in $CASES; do
  printf '%-20s %s\n' "$c" "$(grep '\[stackmark\] deepest' "work/tests/$c/run.log" | tail -1)"
  printf '%-20s %s\n' "" "$(grep '\[stackmark\] chain' "work/tests/$c/run.log" | tail -1)"
  printf '%-20s %s\n' "" "$(grep '\[stackmark\] lifted:' "work/tests/$c/run.log" | tail -1)"
done
