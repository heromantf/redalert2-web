#!/bin/bash
# The game's code as C: lift/ on work/game/gamemd.exe, into out/lift/ (derived from the game, so never
# committed). wasi/build.sh compiles out/lift/gen/. Each step is skipped when what it makes is there
# (the lift itself when run_lift.py --check finds it current: the same exe, lifter and patches).
#   tools/lift.sh                       FULL=1 tools/lift.sh: every step again
#   RA2_GAME=DIR tools/lift.sh          another game folder (its gamemd.exe: the build this lift is for)
# The steps, as redalert2-recomp's setup.sh had them: the PE's sections and imports (pe_analyze.py),
# the vtables RTTI names (rtti.py: seeds, so that thunks reached only through a vtable are found), the
# function catalog (disasm32.py, ~3 min), the lift (run_lift.py --all, ~1.5 min), and the menus'
# dialogs (dialogs.py: the control IDs tools/playtest.py's cases press). Python and its two packages
# in .venv (uv; tools/env.sh keeps its caches in .cache/), at the versions this lift was
# made with: another capstone could disassemble differently.
set -eu
WEB="$(cd "$(dirname "$0")/.." && pwd)"; cd "$WEB"; . tools/env.sh
L=out/lift; X="${RA2_GAME:-$WEB/work/game}/gamemd.exe"; PY=.venv/bin/python; FULL=${FULL:-0}
# rtti.py and name_lift.py go through sets of class names: in an order of Python's string hashing, which
# is another each run unless fixed, and with it the class a function shared by several is named after
# (CCFileClass__virtual_1 or CDFileClass__virtual_1, the same code). Fixed, a lift is the same every time.
export PYTHONHASHSEED=0
[ -f "$X" ] || { echo "no $X (RA2_GAME: the game folder)"; exit 1; }
if ! "$PY" -c 'import capstone, pefile' 2>/dev/null; then
  command -v uv >/dev/null || { echo "uv is needed (brew install uv) for the lift's Python"; exit 1; }
  uv venv -q --python 3.12 .venv && uv pip install -q --python "$PY" capstone==5.0.9 pefile==2024.8.26
fi
mkdir -p "$L"
# step OUT LOG COMMAND...: COMMAND, its output into LOG, unless OUT is there already (FULL=1: again)
step() {
  local out=$1 log=$2; shift 2
  [ "$FULL" = 1 ] || [ ! -s "$out" ] || return 0
  echo "[lift] $(basename "$2")"
  "$@" > "$log" 2>&1 || { echo "[lift] $(basename "$2") failed: $log"; exit 1; }
}
t0=$(date +%s)
step "$L/pe_analysis.json" "$L/pe_analyze.log" "$PY" lift/pe_analyze.py "$X" --json "$L/pe_analysis.json"
step "$L/rtti_seeds.json" "$L/rtti.log" "$PY" lift/rtti.py "$X" -o "$L/rtti.json" --seeds "$L/rtti_seeds.json"
step "$L/functions.json" "$L/disasm.log" "$PY" lift/disasm32.py "$X" -o "$L/functions.json" --seed-functions "$L/rtti_seeds.json"
if [ "$FULL" = 1 ] || ! RA2_GAME="$(dirname "$X")" "$PY" lift/run_lift.py --target gamemd --check > /dev/null 2>&1; then
  echo "[lift] run_lift.py --all"
  RA2_GAME="$(dirname "$X")" "$PY" lift/run_lift.py --all --target gamemd > "$L/lift.log" 2>&1 || { echo "[lift] run_lift.py failed: $L/lift.log"; exit 1; }
fi
step "$L/dialogs.json" "$L/dialogs.log" "$PY" lift/dialogs.py --exe "$X" --out "$L/dialogs.json"
echo "[lift] $L/gen: $(ls "$L/gen" | wc -l | tr -d ' ') files ($(( $(date +%s) - t0 )) s)"
