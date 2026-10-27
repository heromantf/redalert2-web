#!/bin/bash
# tools/lan/two-rooms.sh [FAKES]: two rooms on one LAN of a relay (-max-lan 16): Alice hosts, Bob joins; Dave comes to the
# lobby, then Carol hosts (Dave's room list: the lobby, Alice's, Carol's, in that order) and Dave joins hers
# (index 2). Both battles then run at once (a game in progress stays listed, so a later joiner's index would
# not be sure); Eve (Chrome) stays in the lobby, reading the game's lobby and room lists; FAKES lobby members
# (fake-lobby.mjs) broadcast all along. The relay's /status every 5 s. As tools/lan/pair.sh, its dialogs and clicks.
WEB="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$WEB" && . tools/env.sh
NF=${1:-8}; L=tools/lan; S=tools/lan; OUT=$TMPDIR/lan-two-rooms; rm -rf $OUT; mkdir -p $OUT
for p in a b c d; do $L/farm.sh $PWD/work/lan-$p; done
args() { python3 $L/play-args.py $1; }
HA=(); while IFS= read -r l; do HA+=("$l"); done < <(args 141)
HC=(); while IFS= read -r l; do HC+=("$l"); done < <(args 106)
JA=(); while IFS= read -r l; do JA+=("$l"); done < <(args 32)
JD=(); while IFS= read -r l; do JD+=("$l"); done < <(args 77)
JOIN=(--press 0xE2:1400@1 --select 0xBB:1353=1@25 --press 0xBB:1741@27 --press 0xBD:1439@31 --waitlog Capture_Mouse@32 "${JA[@]}")
JOIN2=(--press 0xE2:1400@1 --select 0xBB:1353=2@70 --press 0xBB:1741@72 --press 0xBD:1439@76 --waitlog Capture_Mouse@77 "${JD[@]}")
R=ws://127.0.0.1:8791/net; RUN=(out/ra2.wasm --run --mute --debuglog --exe /game/gamemd.exe --game /game)
pkill -f "out/relay -addr 127.0.0.1:8791"; out/relay -addr 127.0.0.1:8791 -max-lan 16 > $OUT/relay.log 2>&1 &
RELAY=$!; sleep 1; t0=$(date +%s)
node $S/fake-lobby.mjs $R $NF 470 > $OUT/fakes.log 2>&1 &
E="$(tr '\n' ' ' < $S/lobby-eval.js)"; EV=(); for t in 15 40 90 150 250 350; do EV+=(--eval "$E@$t"); done
node tools/chrome.mjs --page play --timeout 480 --query download --query relay=$R --query name=Eve --mark "[dialog] open 0xBB" \
  "${EV[@]}" --shot "$OUT/eve-two-rooms.png@40" --shot "$OUT/eve-battles.png@250" -- "${RUN[@]:1}" --watchdog 420 --press 0xE2:1400@1 > $OUT/eve.log 2>&1 &
EVE=$!
( while kill -0 $RELAY 2>/dev/null; do echo "$(( $(date +%s) - t0 )) $(curl -s -m 2 http://127.0.0.1:8791/status)" >> $OUT/status.txt; sleep 5; done ) &
sleep 1; node host/run.mjs --relay $R --name Alice --dir work/lan-a::/game "${RUN[@]}" --watchdog 450 \
  --press 0xE2:1400@1 --press 0xBB:1740@4 --press 0xBC:1416@140 --waitlog Capture_Mouse@141 "${HA[@]}" > $OUT/alice.log 2>&1 &
A=$!; sleep 4
node host/run.mjs --relay $R --name Bob --dir work/lan-b::/game "${RUN[@]}" --watchdog 446 "${JOIN[@]}" > $OUT/bob.log 2>&1 &
B=$!; sleep 4
node host/run.mjs --relay $R --name Dave --dir work/lan-d::/game "${RUN[@]}" --watchdog 442 "${JOIN2[@]}" > $OUT/dave.log 2>&1 &
D=$!; sleep 20
node host/run.mjs --relay $R --name Carol --dir work/lan-c::/game "${RUN[@]}" --watchdog 422 \
  --press 0xE2:1400@1 --press 0xBB:1740@4 --press 0xBC:1416@105 --waitlog Capture_Mouse@106 "${HC[@]}" > $OUT/carol.log 2>&1 &
C=$!
wait $A $B $C $D $EVE; kill $RELAY 2>/dev/null; sleep 1
for p in alice bob carol dave; do
  echo "== $p: battle $(grep -a -c 'Capture_Mouse()' $OUT/$p.log); out of sync (0xCE) $(grep -a -c 'dialog\] open 0xCE' $OUT/$p.log); sync dumps $(grep -a -c 'Writing sync data' $OUT/$p.log)"
  echo "   events:$(grep -a -o 'Adding event [A-Z_]*' $OUT/$p.log | sort | uniq -c | tr -s ' ' | tr '\n' ';')"
  echo "   $(grep -a -E '\[record\].*game frame' $OUT/$p.log | tail -1)"
  echo "   $(grep -a '\[net\] [0-9]* datagrams' $OUT/$p.log | tail -1)"
done
echo "== eve:"; grep -a -E '\-> "lobby' $OUT/eve.log | sed 's/.*-> /   /'
cat $OUT/fakes.log
