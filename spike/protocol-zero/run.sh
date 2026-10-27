#!/bin/bash
# run.sh [WATCHDOG_S] [TAG...]: Protocol Zero against the game's own timing (RESULT.md): tools/lan/pair.sh, two
# players under Node through a relay of this Mac, with each protocol at each of the relay's test conditions (a round
# trip of 0, 50, 100, 200 ms; 100 ms with 10 ms of jitter and 1 % lost). The logs: work/runs/lan-node-TAG/; then
#   .venv/bin/python spike/protocol-zero/summarize.py
# TAGs: only those (orig-0 pz-0 orig-25 pz-25 orig-50 pz-50 orig-100 pz-100 orig-50j pz-50j); the delay in a TAG is the
# relay's hold, one way. spam-TAG: with both players' orders across Protocol Zero's first switch (pair.sh SPAM=1);
# TAG.2: a second run of TAG.
WEB="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$WEB" && . tools/env.sh
WD=${1:-300}; shift
ALL=(orig-0 pz-0 orig-25 pz-25 orig-50 pz-50 orig-100 pz-100 orig-50j pz-50j)
TAGS=("$@"); [ ${#TAGS[@]} = 0 ] && TAGS=("${ALL[@]}")
for t in "${TAGS[@]}"; do
  b=${t#spam-}; spam=""; [ "$b" != "$t" ] && spam=1; b=${b%.*}
  d=${b#*-}; relay=""
  case $d in
    0) ;;
    *j) relay="-test-delay ${d%j}ms -test-jitter 10ms -test-loss 1" ;;
    *) relay="-test-delay ${d}ms" ;;
  esac
  game=""; [ "${b%%-*}" = orig ] && game="--protocol-zero off"
  echo "== $t: relay [$relay] game [$game] spam [$spam] $(date +%H:%M:%S)"
  TAG=$t RELAY="$relay" GAME="$game" SPAM=$spam tools/lan/pair.sh "$WD" 2>&1 | grep -a "^== \|battle"
done
