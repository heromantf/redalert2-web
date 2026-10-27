#!/bin/bash
# two-games.sh: one page plays two LAN games in a row, and Protocol Zero starts again with the second (wasi/
# protocol_zero.c: its state is a game's, the spawner's a process's). Under Node, through a relay of this Mac:
# Alice hosts and Bob joins (pair.sh's lobby); Bob's process ends 40 s into the battle (a tab closed); Alice's
# game waits for him (dialog 0xEA), drops him, she wins, the score (0x108); Continue, and she hosts again in the
# Network lobby; Carol joins, the second game. Alice's log must have each game's start values, the same, and a
# first raise of the latency level in each.
#   . tools/env.sh && (cd relay && go build -o ../out/relay .) && tools/lan/two-games.sh
WEB="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$WEB" && . tools/env.sh
L=tools/lan; OUT=work/runs/two-games; rm -rf $OUT; mkdir -p $OUT
for p in a b c; do $L/farm.sh $PWD/work/lan-$p; done
R=ws://127.0.0.1:8791/net; RUN=(out/ra2.wasm --run --mute --debuglog --exe /game/gamemd.exe --game /game)
JOIN=(--press 0xE2:1400@1 --select 0xBB:1353=1@25 --press 0xBB:1741@27 --press 0xBD:1439@31 --waitlog Capture_Mouse@32)
pkill -f "out/relay -addr 127.0.0.1:8791"; out/relay -addr 127.0.0.1:8791 > $OUT/relay.log 2>&1 &
RELAY=$!; sleep 1
# Alice: the first game as pair.sh's; the score's Continue (each --press waits for its dialog); a room again, and
# its start 100 s on, Carol in and accepted by then (her process up, then 31 s)
node host/run.mjs --relay $R --name Alice --dir work/lan-a::/game "${RUN[@]}" --watchdog 800 \
  --press 0xE2:1400@1 --press 0xBB:1740@4 --press 0xBC:1416@140 --waitlog Capture_Mouse@141 \
  --press 0x108:1745@150 --press 0xBB:1740@152 --press 0xBC:1416@252 --waitlog Capture_Mouse@253 > $OUT/alice.log 2>&1 &
A=$!; sleep 4
node host/run.mjs --relay $R --name Bob --dir work/lan-b::/game "${RUN[@]}" --watchdog 196 "${JOIN[@]}" > $OUT/bob.log 2>&1 &
# Carol when Alice's second room is open
while kill -0 $A 2>/dev/null && [ "$(grep -a -c 'dialog\] open 0xBC' $OUT/alice.log)" -lt 2 ]; do sleep 2; done
echo "Alice's second room open: Carol joins"
node host/run.mjs --relay $R --name Carol --dir work/lan-c::/game "${RUN[@]}" --watchdog 240 "${JOIN[@]}" > $OUT/carol.log 2>&1 &
C=$!
wait $A $C; kill $RELAY 2>/dev/null
echo "== Alice:"
grep -a "\[pz\] a LAN game starts\|latency level [0-9] ->\|Kicking player\|dialog\] open 0x108\|dialog\] open 0xEA" $OUT/alice.log | sed 's/^/   /'
echo "   out of sync (0xCE) $(grep -a -c 'dialog\] open 0xCE' $OUT/alice.log)"
for p in bob carol; do
  echo "== $p: $(grep -a '\[pz\] a LAN game starts' $OUT/$p.log | cut -c6-) $(grep -a 'latency level [0-9] ->' $OUT/$p.log | head -1); out of sync (0xCE) $(grep -a -c 'dialog\] open 0xCE' $OUT/$p.log)"
done
starts=$(grep -a -c '\[pz\] a LAN game starts: Protocol Zero on; MaxAhead 12, FrameSendRate 2, frame rate 60' $OUT/alice.log)
raises=$(grep -a -c 'latency level 0 -> ' $OUT/alice.log)
[ "$starts" = 2 ] && [ "$raises" = 2 ] && echo "two games, each from the start: ok" || echo "FAIL: $starts starts, $raises first raises"
