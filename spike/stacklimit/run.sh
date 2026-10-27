#!/bin/bash
# probe.js in Node (a worker_threads worker at 1 MB, the host's --stack-mb
# default, at 4 MB, Node's own default for a worker, and the main thread) and in
# headless Chrome (a dedicated worker and the page), so that host/run.mjs's
# 1 MB can be set against a Chrome worker's stack with numbers.
#   spike/stacklimit/run.sh   -> result lines on stdout
# Chrome runs with a profile of its own under work/ (not the user's).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
WEB="$(cd "$HERE/../.." && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE="$(cat "$HERE/probe.js")"
OUT="$WEB/out/stacklimit"
mkdir -p "$OUT"

echo "node $(node --version)"
for mb in 1 4; do
  node -e "
    const { Worker } = require('node:worker_threads');
    const code = $(node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(process.argv[1], "utf8")))' "$HERE/probe.js") +
      ';require(\"node:worker_threads\").parentPort.postMessage(runProbe());';
    const w = new Worker(code, { eval: true, resourceLimits: { stackSizeMb: $mb } });
    w.on('message', (r) => { console.log('  node worker, stackSizeMb $mb:', JSON.stringify(r)); w.terminate(); });
  "
done
node -e "$PROBE; console.log('  node main thread:', JSON.stringify(runProbe()))"

# Chrome: the probe in a worker made from a Blob (a file:// page may not load a
# worker script), and on the page; both results into the page, which
# --dump-dom prints once the virtual time budget has run.
cat > "$OUT/probe.html" <<EOF
<!doctype html><meta charset="utf-8"><body><pre id="out">waiting</pre><script>
const src = $(node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(process.argv[1], "utf8")))' "$HERE/probe.js");
const lines = [];
const done = () => { document.getElementById('out').textContent = lines.join('\n'); };
const w = new Worker(URL.createObjectURL(new Blob([src + ';postMessage(runProbe());'], { type: 'text/javascript' })));
w.onmessage = (e) => { lines.push('  chrome worker: ' + JSON.stringify(e.data)); eval(src); lines.push('  chrome page: ' + JSON.stringify(runProbe())); done(); };
w.onerror = (e) => { lines.push('  chrome worker error: ' + e.message); done(); };
</script>
EOF
echo "$("$CHROME" --version)"
"$CHROME" --headless=new --disable-gpu --no-first-run --user-data-dir="$WEB/work/chrome-probe" \
  --virtual-time-budget=60000 --dump-dom "file://$OUT/probe.html" 2>/dev/null |
  sed -n 's/.*<pre id="out">//; /chrome/p' | sed 's/<\/pre>.*//; s/&quot;/"/g'
