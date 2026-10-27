#!/bin/bash
# Play the browser build here: the local server, and a Chrome window of its own
# on web/play.html (its start panel: Play, and the game data's download ahead).
# The window has a profile and a disk cache of its own in work/ (tools/env.sh),
# apart from the Chrome you use; it
# runs in the foreground, and closing it stops the server.
#   tools/play.sh [--data DIR] [--port N]
# DIR: the game folder to serve (default work/game, the copy).
set -eu
WEB="$(cd "$(dirname "$0")/.." && pwd)"
. "$WEB/tools/env.sh"
PORT=8780 DATA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT=$2; shift 2 ;;
    --data) DATA=(--data "$2"); shift 2 ;;
    *) echo "usage: tools/play.sh [--data DIR] [--port N]"; exit 2 ;;
  esac
done
[ -f "$WEB/out/ra2.wasm" ] || { echo "no out/ra2.wasm: wasi/build.sh first"; exit 1; }
[ -n "$RA2WEB_CHROME" ] || { echo "no Chrome found: install it, or set RA2WEB_CHROME"; exit 1; }
node "$WEB/web/server.mjs" --port "$PORT" ${DATA[@]+"${DATA[@]}"} &   # (bash 3.2: an empty array is unbound under set -u)
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1
"$RA2WEB_CHROME" \
  --user-data-dir="$RA2WEB_CHROME_PROFILE-play" --disk-cache-dir="$RA2WEB_CHROME_CACHE-play" \
  --no-first-run --no-default-browser-check --disable-breakpad \
  --new-window "http://127.0.0.1:$PORT/web/play.html" >/dev/null 2>&1
