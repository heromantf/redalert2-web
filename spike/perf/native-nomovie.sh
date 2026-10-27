#!/bin/bash
# NEEDS THE NATIVE BUILD: redalert2-recomp's (build-macos/ra2, its checkout beside this one), which this
# repository does not carry (NOTICE.md). Kept as the record of what was measured, as RESULT.md is.
# A native host without movies, the way the WASI build is (bink.c without
# HLE_WITH_FFMPEG: BinkOpen fails, "no movie decoder on this host"), to tell a
# behaviour of that path from one of wasm. Builds nothing in the native
# checkout: bink.c is compiled again into out/native-nomovie/, and the native
# build's other objects are linked with it there.
#   spike/perf/native-nomovie.sh            -> out/native-nomovie/ra2: pcrecomp's bink.c (BinkOpen fails)
#   spike/perf/native-nomovie.sh black      -> out/native-black/ra2: wasi/bink.c (black movies)
set -eu
WEB="$(cd "$(dirname "$0")/../.." && pwd)"
B="$WEB/../redalert2-recomp/build-macos"
R="$WEB/../pcrecomp/runtime"
SRC="$R/win32hle/bink.c" OUT="$WEB/out/native-nomovie"
[ "${1:-}" = black ] && SRC="$WEB/wasi/bink.c" OUT="$WEB/out/native-black"
mkdir -p "$OUT"
cc -O2 -g -DNDEBUG -arch arm64 -fno-strict-aliasing -fwrapv -D_THREAD_SAFE \
   -DRECOMP_LOCAL_REGS -DRECOMP_MEM_BASE=0x100000000000ull -DRECOMP_RETADDR=0u \
   -I"$R/win32hle" -I"$R/recomp32" -c "$SRC" -o "$OUT/bink.o"
# the native link line, from build.ninja, with this bink.o in place of the native one
OBJS=$(sed -n 's/^build ra2: C_EXECUTABLE_LINKER__ra2_RelWithDebInfo \(.*\)/\1/p' "$B/build.ninja" | sed 's/ |.*//')
LIBS=$(awk '/^build ra2: /{f=1} f && /LINK_LIBRARIES/{sub(/.*LINK_LIBRARIES = /,""); print; exit}' "$B/build.ninja")
cd "$B"
# shellcheck disable=SC2086  # lists
cc -O2 -arch arm64 -Wl,-search_paths_first -Wl,-framework,Cocoa \
   $(echo $OBJS | tr ' ' '\n' | grep -v '/bink.c.o$') "$OUT/bink.o" $LIBS -o "$OUT/ra2" 2>&1 | grep -v "reducing alignment" || true
ls -la "$OUT/ra2"
