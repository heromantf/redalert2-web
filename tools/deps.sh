#!/bin/bash
# What building takes and git does not keep, into deps/ (in this checkout, as tools/env.sh has it):
#   wasi-sdk 34         clang, wasm-ld and wasi-libc for wasm32-wasip1-threads (wasi/build.sh, wasi/ffmpeg.sh)
#   FFmpeg 9.0.2        its release tarball, unpacked (the LGPL's source for the module: NOTICE.md), and its
#                       wasm build, deps/ffmpeg-wasm (wasi/ffmpeg.sh: Bink and MP3 only, the movies' decoder)
#   node_modules        npm ci: playwright-core, for tools/chrome.mjs (Chrome itself is the installed one)
# Each download is checked against its SHA-256 here, the one this build was made with; what is there and
# right is kept, so a second run does nothing. The lift's Python is tools/lift.sh's, Go (the relay) yours.
#   tools/deps.sh
#   DEPS=DIR tools/deps.sh      another folder than deps/ (and no npm ci): a test of the downloads
# wasi-sdk for this machine (tools/env.sh's RA2WEB_PLATFORM): macOS on Apple silicon (the one this project
# is built and tested on) or Intel, Linux on x86-64 or arm64, each checked against the SHA-256 its release
# gives (GitHub's digest; arm64-macos's is the one this build was made with). Elsewhere: wasi-sdk 34 of
# your own, WASI=its folder.
set -eu
WEB="$(cd "$(dirname "$0")/.." && pwd)"; cd "$WEB"; . tools/env.sh
DEPS="${DEPS:-$WEB/deps}"; mkdir -p "$DEPS"
case "$RA2WEB_PLATFORM" in
  arm64-macos) WASI_SHA=9c59398106b417f8f14913380fdf0097a8cc0ff4af9eb3ce0065a859e88d49e9 ;;
  x86_64-macos) WASI_SHA=87d27fa8adc68dee59bfbf2e22a6d34ef717c34d6bf1d8af2a56fc929d9ce0eb ;;
  x86_64-linux) WASI_SHA=b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4 ;;
  arm64-linux) WASI_SHA=f7e243dff54d60bcc576e94d6166b69f410f2500ae4a9ceef34315be10e77971 ;;
  *) echo "[deps] no wasi-sdk build for $(uname -s) $(uname -m): get wasi-sdk 34 yourself, WASI=its folder"; exit 1 ;;
esac
WASI_SDK=wasi-sdk-34.0-$RA2WEB_PLATFORM
WASI_URL=https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/$WASI_SDK.tar.gz
FF=ffmpeg-9.0.2
FF_URL=https://ffmpeg.org/releases/$FF.tar.xz
FF_SHA=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e

sha() { if command -v sha256sum > /dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
# fetch URL SHA256 FILE: FILE as it should be, downloaded unless it is there already. A download goes on
# from what an earlier one left (FILE.part); one that stalls (under 20 KB/s for a minute) or fails is
# tried again, five times, from where it was.
fetch() {
  local url=$1 want=$2 file=$3
  if [ -f "$file" ] && [ "$(sha "$file")" = "$want" ]; then echo "[deps] $(basename "$file"): there"; return; fi
  if [ -f "$file.part" ] && [ "$(sha "$file.part")" = "$want" ]; then mv "$file.part" "$file"; echo "[deps] $(basename "$file"): there"; return; fi
  echo "[deps] $(basename "$file"): downloading $url"
  curl -fL --progress-bar -C - --connect-timeout 30 --speed-limit 20000 --speed-time 60 \
       --retry 5 --retry-delay 5 --retry-all-errors -o "$file.part" "$url" ||
    { echo "[deps] $(basename "$file"): the download failed (run tools/deps.sh again: it goes on from $(basename "$file").part)"; exit 1; }
  local got; got=$(sha "$file.part")
  [ "$got" = "$want" ] || { rm -f "$file.part"; echo "[deps] $(basename "$file"): SHA-256 $got, not $want"; exit 1; }
  mv "$file.part" "$file"
}

fetch "$WASI_URL" "$WASI_SHA" "$DEPS/$WASI_SDK.tar.gz"
[ -x "$DEPS/$WASI_SDK/bin/clang" ] || { echo "[deps] unpacking $WASI_SDK"; tar -xzf "$DEPS/$WASI_SDK.tar.gz" -C "$DEPS"; }
fetch "$FF_URL" "$FF_SHA" "$DEPS/$FF.tar.xz"
[ -f "$DEPS/$FF/configure" ] || { echo "[deps] unpacking $FF"; tar -xJf "$DEPS/$FF.tar.xz" -C "$DEPS"; }
if [ -f "$DEPS/ffmpeg-wasm/lib/libavcodec.a" ]; then echo "[deps] ffmpeg-wasm: there"
else
  echo "[deps] ffmpeg-wasm: building (wasi/ffmpeg.sh, a few minutes)"
  WASI="$DEPS/$WASI_SDK" FFMPEG_SRC="$DEPS/$FF" FFMPEG_PREFIX="$DEPS/ffmpeg-wasm" FFMPEG_BUILD="$DEPS/ffmpeg-build" \
    wasi/ffmpeg.sh > "$DEPS/ffmpeg-build.log" 2>&1 || { tail -20 "$DEPS/ffmpeg-build.log"; exit 1; }
fi
if [ "$DEPS" = "$WEB/deps" ]; then
  if [ -d node_modules/playwright-core ]; then echo "[deps] node_modules: there"
  else echo "[deps] node_modules: npm ci"; npm ci --no-audit --no-fund; fi
fi
echo "[deps] ready: $DEPS"
