#!/bin/bash
# FFmpeg for the WASI build: only what win32hle's bink.c and mss.c call (with
# HLE_WITH_FFMPEG), as static libraries in deps/ffmpeg-wasm.
#   wasi/ffmpeg.sh       (deps/ffmpeg-9.0.2 unpacked: tools/deps.sh does it, and runs this)
#   WASI=... FFMPEG_SRC=... FFMPEG_PREFIX=... FFMPEG_BUILD=...   other folders than deps/ and out/
# Bink's demuxer and its video and audio decoders (the movies), MP3's (Miles'
# MP3 codec, mss.c), libswresample (both turn their sound into the mixer's
# 16-bit); no programs, no network, no assembly, no threads of its own. Built
# with the game module's wasm features (atomics for its shared memory, SIMD,
# bulk memory, non-trapping float-to-int), or the two would not link.
# FFmpeg built this way is LGPL 2.1 or later (no --enable-gpl): see NOTICE.md.
set -eu
WEB="$(cd "$(dirname "$0")/.." && pwd)"; . "$WEB/tools/env.sh"   # WASI: as set, or deps/'s for this platform
W="$WASI"
SRC="${FFMPEG_SRC:-$(ls -d "$WEB"/deps/ffmpeg-[0-9]* 2>/dev/null | grep -v '\.tar' | tail -1)}"
[ -x "$W/bin/clang" ] || { echo "wasi-sdk not found in deps/: tools/deps.sh (or WASI=a wasi-sdk 34)"; exit 1; }
[ -f "$SRC/configure" ] || { echo "FFmpeg's source not found in deps/ (deps/ffmpeg-9.0.2)"; exit 1; }
PREFIX="${FFMPEG_PREFIX:-$WEB/deps/ffmpeg-wasm}" BUILD="${FFMPEG_BUILD:-$WEB/out/ffmpeg-build}"
mkdir -p "$BUILD"
cd "$BUILD"
"$SRC/configure" --prefix="$PREFIX" \
  --enable-cross-compile --target-os=none --arch=wasm32 \
  --cc="$W/bin/wasm32-wasip1-threads-clang" --ar="$W/bin/llvm-ar" --ranlib="$W/bin/llvm-ranlib" --nm="$W/bin/llvm-nm" \
  --extra-cflags="-O2 -pthread -msimd128 -mbulk-memory -mnontrapping-fptoint" \
  --extra-ldflags="-pthread" \
  --enable-static --disable-shared --pkg-config=false \
  --disable-everything --disable-autodetect --disable-programs --disable-doc --disable-network \
  --disable-avdevice --disable-avfilter --disable-swscale \
  --disable-asm --disable-inline-asm --disable-pthreads --disable-w32threads --disable-os2threads \
  --disable-debug --disable-runtime-cpudetect \
  --enable-avformat --enable-avcodec --enable-swresample \
  --enable-demuxer=bink,mp3 --enable-decoder=bink,binkaudio_rdft,binkaudio_dct,mp3,mp3float \
  --enable-parser=mpegaudio --enable-protocol=file > configure.out 2>&1 || { tail -30 configure.out; tail -40 ffbuild/config.log; exit 1; }
grep -E "^(bink|mp3|binkaudio)" configure.out | head; sed -n '/Enabled decoders/,/Enabled hwaccels/p' configure.out | head -12
make -j"${JOBS:-8}" > make.out 2>&1 || { grep -m20 -B2 "error" make.out; exit 1; }
make install > install.out 2>&1 || { tail -20 install.out; exit 1; }
ls -la "$PREFIX/lib"
