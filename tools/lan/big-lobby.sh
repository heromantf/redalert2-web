#!/bin/bash
# tools/lan/big-lobby.sh N: N light lobby members (fake-lobby.mjs, FAKE_MS=770: a real one's rate) on a relay with its
# defaults (no limits), and Alice and Bob playing a LAN game meanwhile (as tools/lan/pair.sh). The relay's
# /status and CPU every 5 s. Out: $TMPDIR/lan-big-N/
WEB="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$WEB" && . tools/env.sh
N=${1:-150}; L=tools/lan; S=tools/lan; OUT=$TMPDIR/lan-big-$N; rm -rf $OUT; mkdir -p $OUT
$L/farm.sh $PWD/work/lan-a; $L/farm.sh $PWD/work/lan-b
HA=(); JA=(); while IFS= read -r l; do HA+=("$l"); done < <(python3 $L/play-args.py 141); while IFS= read -r l; do JA+=("$l"); done < <(python3 $L/play-args.py 32)
R=ws://127.0.0.1:8794/net; RUN=(out/ra2.wasm --run --mute --debuglog --exe /game/gamemd.exe --game /game)
out/relay -addr 127.0.0.1:8794 > $OUT/relay.log 2>&1 &
RELAY=$!; sleep 1; t0=$(date +%s)
FAKE_MS=770 node $S/fake-lobby.mjs $R $N 345 > $OUT/fakes.log 2>&1 &
FP=$!
( while kill -0 $RELAY 2>/dev/null; do echo "$(( $(date +%s) - t0 )) relay-cpu $(ps -o time= -p $RELAY) fakes-cpu $(ps -o time= -p $FP 2>/dev/null) $(curl -s -m 2 http://127.0.0.1:8794/status | python3 -c 'import json,sys; d=json.load(sys.stdin); l=[x for x in d["lans"] if x["lan"]=="main"][0]; print(len(l["peers"]), json.dumps(l["traffic"]))' 2>/dev/null)" >> $OUT/status.txt; sleep 5; done ) &
sleep 10
node host/run.mjs --relay $R --name Alice --dir work/lan-a::/game "${RUN[@]}" --watchdog 330 \
  --press 0xE2:1400@1 --press 0xBB:1740@4 --press 0xBC:1416@140 --waitlog Capture_Mouse@141 "${HA[@]}" > $OUT/alice.log 2>&1 &
A=$!; sleep 4
node host/run.mjs --relay $R --name Bob --dir work/lan-b::/game "${RUN[@]}" --watchdog 326 \
  --press 0xE2:1400@1 --select 0xBB:1353=1@25 --press 0xBB:1741@27 --press 0xBD:1439@31 --waitlog Capture_Mouse@32 "${JA[@]}" > $OUT/bob.log 2>&1 &
B=$!
wait $A $B; wait $FP; kill $RELAY 2>/dev/null; sleep 1
for p in alice bob; do
  echo "== $p: battle $(grep -a -c 'Capture_Mouse()' $OUT/$p.log); out of sync (0xCE) $(grep -a -c 'dialog\] open 0xCE' $OUT/$p.log); events $(grep -a -c 'Adding event' $OUT/$p.log)"
  echo "   $(grep -a -E '\[record\].*game frame' $OUT/$p.log | tail -1)"
  grep -a -n -E '\[net\] [0-9]+ datagrams|Capture_Mouse\(\)|press 0xBC:1416|\[dialog\] open 0xB[BD]' $OUT/$p.log | sed 's/^/   /' | cut -c1-260
done
cat $OUT/fakes.log; tail -3 $OUT/status.txt | cut -c1-200
