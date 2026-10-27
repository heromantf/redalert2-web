#!/bin/bash
# farm.sh DIR: a private game folder for one player: hard links to work/game, its own RA2MD.INI
# (the game writes into its folder; links cost no space), as tools/playtest.py's farm().
WEB="$(cd "$(dirname "$0")/../.." && pwd)"
D=$1; rm -rf "$D"; mkdir -p "$D"
(cd "$WEB/work/game" && find . -type d -exec mkdir -p "$D/{}" \; && find . -type f ! -iname RA2MD.INI -exec ln {} "$D/{}" \;)
cp "$WEB/work/game/RA2MD.INI" "$D/RA2MD.INI"
