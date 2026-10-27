#!/bin/bash
# Phase 0, step 2: does the lifted game build for the browser, and how big is it?
#   spike/compile/build.sh            compile every generated file, then link
#   OPT=-O3 JOBS=6 spike/compile/build.sh
# Compiles out/lift/gen/*.c (tools/lift.sh) for wasm32-wasip1-threads into
# out/gen/ (one log line per file: seconds, object size), then links them alone
# into out/gen.wasm: no runtime, every undefined symbol left as an import, the
# dispatch table exported so nothing is dropped. The module's size is the
# game's; the runtime (win32hle) comes on top of it later.
# Flags are nfsu2-web's (web/build.sh) where they apply: tail calls, exnref
# exceptions (recomp_types.h includes setjmp.h; the RA2 lift uses none), SIMD,
# bulk memory, non-trapping float-to-int; guest memory flat (a guest address is a
# linear-memory address) and null pointers kept (guest address 0 is memory).
set -eu
WEB="$(cd "$(dirname "$0")/../.." && pwd)"
W="${WASI:-$(ls -d "$WEB"/deps/wasi-sdk-*-arm64-macos 2>/dev/null | tail -1)}"
[ -x "$W/bin/clang" ] || { echo "wasi-sdk not found in deps/ (set WASI=...)"; exit 1; }
G="$WEB/out/lift/gen"
OUT="$WEB/out/gen"
OPT=${OPT:--O2}
JOBS=${JOBS:-8}
mkdir -p "$OUT"
CFLAGS="--target=wasm32-wasip1-threads -pthread $OPT -w -fno-strict-aliasing -fwrapv -fno-delete-null-pointer-checks
  -msimd128 -mbulk-memory -mnontrapping-fptoint -mtail-call
  -mexception-handling -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false
  -DRECOMP_FLAT_MEMORY -DRECOMP_LOCAL_REGS -DRECOMP_RETADDR=0u -DNDEBUG
  -I$G -I$WEB/win32hle -I$WEB/recomp32"
export W OUT CFLAGS
compile() {
  local c=$1 o="$OUT/$(basename "${1%.c}").o" t0 t1
  t0=$(date +%s)
  # shellcheck disable=SC2086  # CFLAGS is a list
  if "$W/bin/clang" $CFLAGS -c "$c" -o "$o" 2> "$o.err"; then
    t1=$(date +%s); echo "ok   $(basename "$c") $((t1 - t0)) s $(stat -f %z "$o") bytes"
  else
    echo "FAIL $(basename "$c") $(head -c 300 "$o.err")"
  fi
}
export -f compile
T0=$(date +%s)
ls "$G"/*.c | xargs -P "$JOBS" -I{} bash -c 'compile "$@"' _ {} | sort -k2 > "$OUT/compile.log"
T1=$(date +%s)
echo "compiled $(grep -c '^ok' "$OUT/compile.log") ok, $(grep -c '^FAIL' "$OUT/compile.log") failed, $((T1 - T0)) s wall ($OPT, $JOBS jobs)"
grep '^FAIL' "$OUT/compile.log" | head -5 || true
"$W/bin/wasm-ld" --no-entry --allow-undefined --export=recomp_dispatch_table \
  --shared-memory --import-memory --max-memory=4294967296 \
  "$OUT"/*.o -o "$WEB/out/gen.wasm" 2> "$OUT/link.err" || { echo "link failed:"; head -20 "$OUT/link.err"; exit 1; }
echo "linked out/gen.wasm: $(stat -f %z "$WEB/out/gen.wasm") bytes, $(gzip -9 -c "$WEB/out/gen.wasm" | wc -c | tr -d ' ') gzipped"
