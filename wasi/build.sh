#!/bin/bash
# The WASI build: Yuri's Revenge's lift on win32hle, one module, out/ra2.wasm.
#   wasi/build.sh                 incremental: what changed since the last build
#   FULL=1 wasi/build.sh          everything again
#   OPT=-O1 JOBS=4 wasi/build.sh
#
# Sources:
#   out/lift/gen          the lift (tools/lift.sh makes it from work/game/gamemd.exe), as in spike/compile
#   win32hle/             the runtime (pcrecomp's: NOTICE.md), its display wasi/screen.c's here
#   recomp32/             recomp_types.h, the lift's register model and memory macros
#   deps/ffmpeg-wasm      FFmpeg (wasi/ffmpeg.sh), if built: then win32hle's bink.c and mss.c
#                         with HLE_WITH_FFMPEG, as natively (the movies play);
#                         without it wasi/bink.c instead of bink.c (black movies)
#   wasi/                 the host (main.c: the game as shipped, none of the remaster's features),
#                         what WASI lacks (compat.c, sdl.c), the display (screen.c), the LAN (net.c),
#                         its latency control (protocol_zero.c: CnCNet's Protocol Zero, run_lift.py's patches),
#                         and of redalert2-recomp's native host script.c (the tests' scripted input)
#                         and blowfish.c (the game's cipher, a COM class)
# Every runtime and host file is compiled with wasi/compat/compat.h forced in and
# wasi/compat ahead of the system headers (its SDL2/, netdb.h, ifaddrs.h, net/if.h);
# the generated C needs neither.
#
# Memory (compat.c): a guest address is a linear address; the guest owns what is
# below --global-base, the runtime's data, its stacks and malloc are above it
# (--no-stack-first, so the C stack is not put at address 0, in the guest's).
set -eu
WEB="$(cd "$(dirname "$0")/.." && pwd)"; . "$WEB/tools/env.sh"   # WASI: deps/'s wasi-sdk for this platform
export LC_COLLATE=C   # the units (below: globs) in one order whatever the locale, and so the module byte for byte
                       # the same, and its id (the relay's version: players of one build meet)
W="$WASI"
[ -x "$W/bin/clang" ] || { echo "wasi-sdk not found in deps/: tools/deps.sh (or WASI=a wasi-sdk 34)"; exit 1; }
G="$WEB/out/lift/gen"
[ -f "$G/recomp_dispatch.c" ] || { echo "no lift in $G: run tools/lift.sh first"; exit 1; }
OPT=${OPT:--O2}
JOBS=${JOBS:-8}
GUEST_TOP=$((0x28000000))      # the guest's memory ends here: 640 MB, as nfsu2-web's (wasm-ld takes decimal)
OUTG="$WEB/out/gen" OUTO="$WEB/out/wasi"
mkdir -p "$OUTG" "$OUTO"

LINKARCH="--target=wasm32-wasip1-threads -pthread -msimd128 -mbulk-memory -mnontrapping-fptoint -mtail-call -mexception-handling"
ARCH="$LINKARCH -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false"
COMMON="$ARCH $OPT -fno-strict-aliasing -fwrapv -fno-delete-null-pointer-checks
  -DRECOMP_FLAT_MEMORY -DRECOMP_LOCAL_REGS -DRECOMP_RETADDR=0u -DNDEBUG"
GENFLAGS="$COMMON -w -I$G -I$WEB/win32hle -I$WEB/recomp32"
HOSTFLAGS="$COMMON -Wall -Wno-unused-function -Wno-unused-but-set-variable -Wno-unused-variable
  -I$WEB/wasi/compat -include $WEB/wasi/compat/compat.h
  -I$G -I$WEB/win32hle -I$WEB/recomp32"
FF="$WEB/deps/ffmpeg-wasm"
FFMPEG=0; [ -f "$FF/lib/libavcodec.a" ] && FFMPEG=1
FFFLAGS="$HOSTFLAGS -DHLE_WITH_FFMPEG -I$FF/include"
NETFLAGS="$HOSTFLAGS -DRA2WEB_NET_SHIM"        # wsock32.c: its sockets are net.c's (compat.h)
# the newest of wasi/compat: a runtime or host object older than it is built again
COMPAT_NEWEST="$(find "$WEB/wasi/compat" -type f -print0 | xargs -0 ls -t | head -1)"
export W GENFLAGS HOSTFLAGS FFFLAGS NETFLAGS COMPAT_NEWEST FULL="${FULL:-0}"

# compile SRC OBJ FLAGVAR: skipped when OBJ is newer than SRC (and, for the runtime
# and the host, than wasi/compat), unless FULL is set
compile() {
  local src=$1 obj=$2 flags=${!3}
  if [ "$FULL" = 0 ] && [ -f "$obj" ] && [ "$obj" -nt "$src" ] &&
     { [ "$3" = GENFLAGS ] || [ "$obj" -nt "$COMPAT_NEWEST" ]; }; then return 0; fi
  # shellcheck disable=SC2086  # flags is a list
  if "$W/bin/clang" $flags -c "$src" -o "$obj" 2> "$obj.err"; then
    [ -s "$obj.err" ] && { echo "warnings in $(basename "$src"):"; head -20 "$obj.err"; }
    return 0
  fi
  echo "FAIL $(basename "$src")"; head -30 "$obj.err"; return 1
}
export -f compile

T0=$(date +%s)
{
  for c in "$G"/*.c; do echo "$c $OUTG/$(basename "${c%.c}").o GENFLAGS"; done
  for c in "$WEB"/win32hle/*.c; do
    n=$(basename "${c%.c}")
    if [ "$n" = bink ] || [ "$n" = mss ]; then           # FFmpeg's, objects of their own: no stale mix-up
      if [ $FFMPEG = 1 ]; then echo "$c $OUTO/hle_${n}_ff.o FFFLAGS"; continue; fi
      [ "$n" = bink ] && continue                         # wasi/bink.c instead, below
    fi
    if [ "$n" = wsock32 ]; then echo "$c $OUTO/hle_$n.o NETFLAGS"; continue; fi
    echo "$c $OUTO/hle_$n.o HOSTFLAGS"
  done
  for c in "$WEB"/wasi/script.c "$WEB"/wasi/blowfish.c; do
    echo "$c $OUTO/ra2_$(basename "${c%.c}").o HOSTFLAGS"
  done
  echo "$WEB/wasi/main.c $OUTO/wasi_main.o HOSTFLAGS"
  echo "$WEB/wasi/net.c $OUTO/wasi_net.o HOSTFLAGS"
  echo "$WEB/wasi/protocol_zero.c $OUTO/wasi_protocol_zero.o HOSTFLAGS"
  echo "$WEB/wasi/screen.c $OUTO/wasi_screen.o HOSTFLAGS"
  echo "$WEB/wasi/sdl.c $OUTO/wasi_sdl.o HOSTFLAGS"
  [ $FFMPEG = 1 ] || echo "$WEB/wasi/bink.c $OUTO/wasi_bink.o HOSTFLAGS"
} > "$OUTO/units.txt"
xargs -P "$JOBS" -L 1 bash -c 'compile "$@"' _ < "$OUTO/units.txt"
# compat.c includes compat.h itself (as the implementation), so not forced in
# shellcheck disable=SC2086
"$W/bin/clang" $COMMON -Wall -I"$WEB/wasi/compat" -c "$WEB/wasi/compat.c" -o "$OUTO/wasi_compat.o"
T1=$(date +%s)

# the units' objects, not whatever *.o an older layout of this build left behind
OBJS=("$OUTO/wasi_compat.o")
while read -r _ obj _; do OBJS+=("$obj"); done < "$OUTO/units.txt"
# shellcheck disable=SC2086
"$W/bin/clang" $LINKARCH "${OBJS[@]}" -o "$WEB/out/ra2.wasm" \
  -Wl,--global-base=$GUEST_TOP -Wl,--no-stack-first -Wl,-z,stack-size=$((8 << 20)) \
  -Wl,--import-memory -Wl,--export-memory -Wl,--shared-memory \
  -Wl,--initial-memory=$((1 << 30)) -Wl,--max-memory=$((4 << 30)) \
  $([ $FFMPEG = 1 ] && echo "-L$FF/lib -lavformat -lavcodec -lswresample -lavutil") \
  -lsetjmp -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid -lm
T2=$(date +%s)
echo "out/ra2.wasm: $(wc -c < "$WEB/out/ra2.wasm" | tr -d ' ') bytes (compile $((T1 - T0)) s, link $((T2 - T1)) s; movies: $([ $FFMPEG = 1 ] && echo FFmpeg || echo black))"
