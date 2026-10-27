#!/bin/bash
# pair.sh [WATCHDOG_S] [chrome]: a LAN game on a relay of this Mac (out/relay, 127.0.0.1:8791): Alice hosts under
# Node, Bob joins under Node (or, with "chrome", in a page in Chrome), both through the game's own Network lobby
# (the dialogs' controls as tools/playtest.py presses them), then both build (play-args.py). The sync check: the game's own,
# a frame CRC each FrameSendRate; out of sync it opens dialog 0xCE and writes SYNCn.TXT.
# POKE=1 (chrome): Bob's scenario random table scrambled 60 s into the battle: the check must catch it.
# Bob's page downloads the game data first (&download): online play needs it (web/online.js onlineData).
#   . tools/env.sh && (cd relay && go build -o ../out/relay .) && tools/lan/pair.sh 480 [chrome]
WEB="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$WEB" && . tools/env.sh
WD=${1:-480}; MODE=${2:-node}; L=tools/lan; OUT=work/runs/lan-$MODE; mkdir -p $OUT
$L/farm.sh $PWD/work/lan-a; [ $MODE = node ] && $L/farm.sh $PWD/work/lan-b
HA=(); JA=(); while IFS= read -r l; do HA+=("$l"); done < <(python3 $L/play-args.py 141); while IFS= read -r l; do JA+=("$l"); done < <(python3 $L/play-args.py 32)
JOIN=(--press 0xE2:1400@1 --select 0xBB:1353=1@25 --press 0xBB:1741@27 --press 0xBD:1439@31 --waitlog Capture_Mouse@32 "${JA[@]}")
pkill -f "out/relay -addr 127.0.0.1:8791"; out/relay -addr 127.0.0.1:8791 > $OUT/relay.log 2>&1 &
RELAY=$!; sleep 1
node host/run.mjs --relay ws://127.0.0.1:8791/net --name Alice --dir work/lan-a::/game out/ra2.wasm --run --mute --debuglog --watchdog $WD \
  --exe /game/gamemd.exe --game /game --press 0xE2:1400@1 --press 0xBB:1740@4 --press 0xBC:1416@140 --waitlog Capture_Mouse@141 "${HA[@]}" > $OUT/alice.log 2>&1 &
A=$!; sleep 4
if [ $MODE = chrome ]; then
  POKE_JS="(() => { const dv = new DataView(ra2web.memory.buffer), sc = dv.getUint32(0xA8B230, true), r = sc + 0x218; for (let i = 0; i < 0xFA; i++) dv.setUint32(r + 0x0C + 4 * i, dv.getUint32(r + 0x0C + 4 * i, true) ^ 0x5A5A5A5A, true); return 'scenario random scrambled'; })()"
  EV=(); [ -n "$POKE" ] && EV=(--mark Capture_Mouse --eval "$POKE_JS@60")
  node tools/chrome.mjs --page play --timeout $((WD + 90)) --query download --query relay=ws://127.0.0.1:8791/net --query name=Bob "${EV[@]}" -- \
    --run --mute --debuglog --watchdog $((WD - 20)) --exe /game/gamemd.exe --game /game "${JOIN[@]}" > $OUT/bob.log 2>&1
else
  node host/run.mjs --relay ws://127.0.0.1:8791/net --name Bob --dir work/lan-b::/game out/ra2.wasm --run --mute --debuglog --watchdog $WD \
    --exe /game/gamemd.exe --game /game "${JOIN[@]}" > $OUT/bob.log 2>&1
fi
wait $A; kill $RELAY 2>/dev/null
for p in alice bob; do
  echo "== $p: battle $(grep -a -c 'Capture_Mouse()' $OUT/$p.log); out of sync (0xCE) $(grep -a -c 'dialog\] open 0xCE' $OUT/$p.log); sync dumps $(grep -a -c 'Writing sync data' $OUT/$p.log)"
  echo "   events:$(grep -a -o 'Adding event [A-Z_]*' $OUT/$p.log | sort | uniq -c | tr -s ' ' | tr '\n' ';')"
  echo "   $(grep -a -E '\[record\].*game frame' $OUT/$p.log | tail -1)"
  echo "   $(grep -a '\[net\] [0-9]* datagrams' $OUT/$p.log | tail -1)"
done
