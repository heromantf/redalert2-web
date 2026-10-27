# Source this before any command of this project (the scripts do it themselves): what a tool caches,
# downloads or writes on the side goes into this checkout, not into the home folder or the system's
# temporary folder: .cache/ (the caches and temporaries), deps/ (tools/deps.sh), work/ (the game data,
# Chrome's test profiles), none of it committed. (On this project's Mac the checkout is on an external
# volume and the internal disk is nearly full.)
#   . tools/env.sh
#   RA2WEB_CACHE=DIR      the caches and temporaries there instead of .cache/ (shared by checkouts)
#   RA2WEB_CHROME=PATH    the Chrome (or Chromium) the tests and tools/play.sh start; else the platform's own
#   WASI=DIR              a wasi-sdk of your own; else deps/'s for this platform (tools/deps.sh)
_web="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
_cache="${RA2WEB_CACHE:-$_web/.cache}"
export TMPDIR="$_cache/tmp"                                 # mktemp, compilers' temporaries, the tests' logs
export XDG_CACHE_HOME="$_cache"                             # tools that follow it
export npm_config_cache="$_cache/npm"                       # npm's download cache (default ~/.npm)
export npm_config_update_notifier=false
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1                   # no browsers downloaded: the installed Chrome is used
export PLAYWRIGHT_BROWSERS_PATH="$_cache/ms-playwright"     # and if one ever is, here (default ~/Library/Caches)
export GOPATH="$_cache/go"                                  # Go (the relay, relay/): modules and builds here,
export GOMODCACHE="$GOPATH/pkg/mod"                         # not ~/go and ~/Library/Caches/go-build
export GOCACHE="$_cache/go-build"
export GOTELEMETRY=off
export UV_CACHE_DIR="$_cache/uv"                            # uv (the lift's Python, tools/lift.sh): its downloads,
export UV_PYTHON_INSTALL_DIR="$_cache/uv-python"            # and a Python it installs (default ~/.local/share/uv)
export PYTHONDONTWRITEBYTECODE=1                            # no __pycache__ beside lift/'s sources
case ",${no_proxy:-}," in *,127.0.0.1,*) ;; *) no_proxy="${no_proxy:+$no_proxy,}127.0.0.1,localhost" ;; esac
export no_proxy NO_PROXY="$no_proxy"                        # the tests' own servers (page, relay) not through a proxy
# This machine, as wasi-sdk's releases name it (tools/deps.sh fetches that one): arm64-macos, x86_64-macos,
# x86_64-linux, arm64-linux; empty elsewhere
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) RA2WEB_PLATFORM=arm64-macos ;;
  Darwin-x86_64) RA2WEB_PLATFORM=x86_64-macos ;;
  Linux-x86_64) RA2WEB_PLATFORM=x86_64-linux ;;
  Linux-aarch64 | Linux-arm64) RA2WEB_PLATFORM=arm64-linux ;;
  *) RA2WEB_PLATFORM= ;;
esac
export RA2WEB_PLATFORM
[ -n "${WASI:-}" ] || WASI="$(find "$_web/deps" -maxdepth 1 -type d -name "wasi-sdk-*-${RA2WEB_PLATFORM:-none}" 2>/dev/null | sort | tail -1)"
export WASI                                                 # wasi/build.sh, wasi/ffmpeg.sh (empty: not fetched yet)
# Chrome, as the tests start it: the installed one, a profile and a disk cache of its own here
if [ -z "${RA2WEB_CHROME:-}" ]; then
  case "$(uname -s)" in
    Darwin) RA2WEB_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ;;
    *) RA2WEB_CHROME="$(command -v google-chrome || command -v google-chrome-stable || command -v chromium ||
                        command -v chromium-browser || true)" ;;
  esac
fi
export RA2WEB_CHROME
export RA2WEB_CHROME_PROFILE="$_web/work/chrome-profile"
export RA2WEB_CHROME_CACHE="$_web/work/chrome-cache"
mkdir -p "$TMPDIR" "$GOPATH" "$GOCACHE"
unset _web _cache
