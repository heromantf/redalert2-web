#!/bin/bash
# room.sh [N] [WATCHDOG_S]: one LAN game of N players (2..8) on a relay of this Mac (out/relay, 127.0.0.1:8791), all
# under Node: Alice hosts on an 8-player map (XDeath.MAP: 88 in the game's map list, SessionClass +0x690, the index
# [LAN] ScenIndex takes), the others join her room one after another, then everyone builds (play-args.py). As
# pair.sh: the game's own sync check, its dialogs and clicks; the relay's /status each 10 s (status.txt) and at the
# end (status.json). RELAY=, GAME=, TAG= as pair.sh's. About 0.7 GB and a core a player.
#   . tools/env.sh && (cd relay && go build -o ../out/relay .) && tools/lan/room.sh 8 360
WEB="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$WEB" && . tools/env.sh
N=${1:-8}; WD=${2:-360}; L=tools/lan; OUT=work/runs/room-$N${TAG:+-$TAG}; rm -rf $OUT; mkdir -p $OUT
read -r -a RA <<< "${RELAY:-}"; read -r -a GA <<< "${GAME:-}"
NAMES=(Alice Bob Carol Dave Eve Frank Grace Heidi)
for ((i = 0; i < N; i++)); do $L/farm.sh $PWD/work/lan-${NAMES[i]}; done
python3 - work/lan-Alice/RA2MD.INI <<'EOF'
import re, sys
p = sys.argv[1]; s = open(p).read()
s = re.sub(r'(\[LAN\][^\[]*?ScenIndex=)\d+', r'\g<1>88', s, count=1)
open(p, 'w').write(s)
EOF
# Everyone's accept is cleared as each player joins (the game's room): the joiners accept together once the last
# is in (4 s apart, ~27 s to join, slower as N load at once), 15 s before the host starts.
START=$((60 + 8 * N)); ACCEPT=$((START - 15))
HA=(); while IFS= read -r l; do HA+=("$l"); done < <(python3 $L/play-args.py $((START + 1)))
R=ws://127.0.0.1:8791/net; RUN=(out/ra2.wasm --run --mute --debuglog "${GA[@]}" --exe /game/gamemd.exe --game /game)
pkill -f "out/relay -addr 127.0.0.1:8791"; out/relay -addr 127.0.0.1:8791 "${RA[@]}" > $OUT/relay.log 2>&1 &
RELAY=$!; sleep 1; t0=$(date +%s)
( while kill -0 $RELAY 2>/dev/null; do echo "$(( $(date +%s) - t0 )) $(curl -s -m 2 --noproxy '*' http://127.0.0.1:8791/status)" >> $OUT/status.txt; sleep 10; done ) &
node host/run.mjs --relay $R --name Alice --dir work/lan-Alice::/game "${RUN[@]}" --watchdog $WD \
  --press 0xE2:1400@1 --press 0xBB:1740@4 --press 0xBC:1416@$START --waitlog Capture_Mouse@$((START + 1)) "${HA[@]}" > $OUT/Alice.log 2>&1 &
PIDS=($!)
for ((i = 1; i < N; i++)); do
  sleep 4
  a=$((ACCEPT - 4 * i))                             # this player's script time for the common moment
  JA=(); while IFS= read -r l; do JA+=("$l"); done < <(python3 $L/play-args.py $((a + 1)))
  node host/run.mjs --relay $R --name ${NAMES[i]} --dir work/lan-${NAMES[i]}::/game "${RUN[@]}" --watchdog $((WD - 4 * i)) \
    --press 0xE2:1400@1 --select 0xBB:1353=1@25 --press 0xBB:1741@27 --press 0xBD:1439@$a --waitlog Capture_Mouse@$((a + 1)) \
    "${JA[@]}" > $OUT/${NAMES[i]}.log 2>&1 &
  PIDS+=($!)
done
wait "${PIDS[@]}"; curl -s --noproxy '*' http://127.0.0.1:8791/status > $OUT/status.json; kill $RELAY 2>/dev/null
for ((i = 0; i < N; i++)); do
  p=${NAMES[i]}
  echo "== $p: battle $(grep -a -c 'Capture_Mouse()' $OUT/$p.log); out of sync (0xCE) $(grep -a -c 'dialog\] open 0xCE' $OUT/$p.log); sync dumps $(grep -a -c 'Writing sync data' $OUT/$p.log)"
  echo "   $(grep -a '\[net\] frame [0-9]*: [0-9]* frames' $OUT/$p.log | tail -1)"
  echo "   $(grep -a '\[net\] [0-9]* datagrams' $OUT/$p.log | tail -1)"
done
echo "relay: $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["lans"][0]["traffic"])' $OUT/status.json 2>/dev/null)"
