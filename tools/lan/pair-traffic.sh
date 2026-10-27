#!/bin/bash
# tools/lan/pair-traffic.sh WD: tools/lan/pair.sh WD (node), the relay's /status every 5 s with the time,
# and when each side's battle began (Capture_Mouse in its log). Out: $TMPDIR/pair-traffic/
WEB="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$WEB" && . tools/env.sh
WD=${1:-300}; OUT=$TMPDIR/pair-traffic; mkdir -p $OUT; : > $OUT/status.txt
tools/lan/pair.sh $WD > $OUT/pair.txt 2>&1 &
P=$!; t0=$(date +%s); seen=0
while kill -0 $P 2>/dev/null; do
  t=$(( $(date +%s) - t0 ))
  s=$(curl -s -m 2 http://127.0.0.1:8791/status)
  b=$(grep -a -c 'Capture_Mouse()' work/runs/lan-node/alice.log 2>/dev/null)
  [ "$seen" = 0 ] && [ "${b:-0}" -gt 0 ] && { seen=1; echo "$t battle began (alice)" >> $OUT/status.txt; }
  echo "$t $s" >> $OUT/status.txt
  sleep 5
done
