# Notices

What this project took from others, and on what terms; everything not named
here is this project's own. The license texts are at the end.

## Others' code in this repository

**nfsu2-web** (MIT; copyright 2026 th0mk, portions 2026 Talha Müderrisoğlu):
`host/` and `web/` follow the design of, and adapt code from, its
`web/src/host/` (its process, game-thread worker, I/O protocol and WASI
structures; the game data's block cache, its requests and the download
ahead, `datacache.ts`, `io-worker.ts` and `predownload-worker.ts`, in
`web/data-cache.js`, `web/block-fetch.js` and `web/predownload-worker.js`).

**pcrecomp and redalert2-recomp** (MIT; copyright 2026 sp00nz): copied in
(2026-10-27) from https://github.com/sp00nznet/pcrecomp at `a72bdcf` and
https://github.com/sp00nznet/redalert2-recomp at `0a3e5d7`, only what this
build uses, with this project's changes; taken from upstream since, one at a
time: pcrecomp `7f217a7` (win32hle repaints the siblings a closed window
uncovers) and `54cb21f` (name_lift skips macOS's `._*` files), 2026-10-28:

| Here | There |
|---|---|
| `win32hle/` (the files `wasi/build.sh` compiles, and `README.md`) | pcrecomp `runtime/win32hle/` |
| `recomp32/recomp_types.h` | pcrecomp `runtime/recomp32/recomp_types.h` |
| `lift/pe_analyze.py`, `lift/merge_names.py` | pcrecomp `tools/pe/` |
| `lift/rtti.py` | pcrecomp `tools/cpp/` |
| `lift/disasm32.py` | pcrecomp `tools/disasm/` |
| `lift/generate.py`, `lift/lift32.py`, `lift/lift32_sse.py`, `lift/name_lift.py` | pcrecomp `tools/lift/` |
| `lift/run_lift.py` (the RA2 lift's configuration and patches) | redalert2-recomp `run_lift.py` |
| `lift/dialogs.py` | redalert2-recomp `tools/dialogs.py` |
| `wasi/script.c`, `wasi/blowfish.c` | redalert2-recomp `src/linux/` |
| `tools/playtest.py` (its cases; the runner this build's) | redalert2-recomp `tools/playtest.py` |

What upstream has changed since, for one of these: in a pcrecomp checkout
`git log a72bdcf..origin/main -- runtime/win32hle runtime/recomp32/recomp_types.h tools/pe tools/cpp tools/disasm tools/lift`,
in a redalert2-recomp one `git log 0a3e5d7..origin/main -- run_lift.py tools/dialogs.py tools/playtest.py src/linux/script.c src/linux/blowfish.c`.
The paths in their comments (`docs/…`, `src/runtime/…`, `runtime/native32/…`)
are those repositories'.

**The screen filters** (`web/presenter.js`), those of the Steam release's two
wrappers, each computed as its source computes it:

- DDrawCompat's (https://github.com/narzoul/DDrawCompat; 0BSD): bilinear,
  point, integer, bicubic, lanczos, spline, after its `D3dDdi/ShaderBlitter.cpp`
  and `Shaders/*.hlsl`.
- cnc-ddraw's (https://github.com/FunkyFr3sh/cnc-ddraw; MIT, copyright 2025
  github.com/FunkyFr3sh): its OpenGL shaders (`inc/openglshader.h`) in GLSL ES
  3.0: bilinear, catmull, lanczos2, xbr. Three of them are others' code, each
  under the MIT license:
  - catmull: Catmull-Rom in 5 texture fetches, copyright 2019 MJP
    (https://gist.github.com/TheRealMJP/c83b8c0f46b63f3a88a5986f4fa982b1;
    the license: https://gist.github.com/TheRealMJP/bc503b0b87b643d3505d41eab8b332ae);
  - lanczos2: Hyllian's jinc windowed-jinc 2-lobe sharper with anti-ringing,
    copyright 2011-2016 Hyllian/Jararaca (libretro glsl-shaders at `09e2942`,
    `windowed/shaders/lanczos2-sharp.glsl`);
  - xbr: Hyllian's xBR-lv2, copyright 2011-2016 Hyllian (libretro
    glsl-shaders at `09e2942`, `xbr/shaders/xbr-lv2.glsl`; "Incorporates some
    of the ideas from SABR shader. Thanks to Joshua Street.").

## Linked or fetched when building, not in this repository

`tools/deps.sh` fetches these (each checked against its SHA-256):

- **FFmpeg 9.0.2** (https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz): with
  `deps/ffmpeg-wasm` built (`wasi/ffmpeg.sh`: Bink and MP3 only, without
  `--enable-gpl` or `--enable-nonfree`), the module links its libavformat,
  libavcodec, libswresample and libavutil, which are under the GNU Lesser
  General Public License 2.1 or later (the tarball's `COPYING.LGPLv2.1`).
  This project's code only calls them. Whoever is given the module is to be
  offered that source too (the tarball, `deps/ffmpeg-9.0.2.tar.xz`), and may
  rebuild the module with a FFmpeg of their own (`wasi/ffmpeg.sh`,
  `wasi/build.sh`).
- **wasi-sdk 34** (https://github.com/WebAssembly/wasi-sdk): the compiler,
  and in the module its wasi-libc (Apache-2.0 WITH LLVM-exception, Apache-2.0
  or MIT, as one chooses) and compiler-rt's builtins (Apache-2.0 WITH
  LLVM-exception, which asks nothing of compiled code). Of wasi-libc's parts
  the module has musl's (MIT, copyright 2005-2020 Rich Felker, et al.),
  cloudlibc's (BSD-2-Clause, below) and dlmalloc (CC0); not musl-fts nor
  emmalloc.
- **github.com/coder/websocket** (ISC, below): the relay's one dependency,
  in its binary (`relay/go.mod`).
- For the tests and the lift only, in nothing that is served:
  playwright-core (Apache-2.0; `npm ci`), capstone and pefile (BSD-3-Clause,
  MIT; `tools/lift.sh`'s `.venv`).

## Learned from, none of their code

- **CnCNet**: the desync fixes, the crash fixes and the online fixes in
  `lift/run_lift.py` (`desync_fix_patches`, `crash_fix_patches`,
  `online_patches`) do what CnCNet's yrpp-spawner and yr-patches found, at
  the addresses they found it (both GPL-3.0): written anew here, each checked
  against the game's code, none of their code used. So does Protocol Zero,
  the spawner's latency control (`protocol_zero_patches`,
  `wasi/protocol_zero.c`): its sites, conditions and constants, and the ten
  names of its latency levels in its message, the logic written anew. And the
  bugs of the game as shipped that the spawner and yr-patches fix
  (`bugfix_patches`, `wasi/fixes.c`: a map smaller than the view, the
  IsoMapPack5 limit, Do_Blit's wait, the wait dialog's focus, type select's
  redraw, the shell's layout): their addresses and limits, written anew.
- **YRpp**: the game's structures and addresses (facts about the game).
- **IPXEmu** (Jelle Geerts): win32hle's IPX over UDP (`win32hle/wsock32.c`)
  puts the same bytes on the wire, checked against its 1.0.4 source; none of
  its code.

## The game

*Command & Conquer: Red Alert 2* and *Yuri's Revenge* are © 2000-2001
Westwood Studios / Electronic Arts, and not this project's to license. Their
executables, data, movies, music and art are not in this repository
(`.gitignore`: `work/`). The lift (`tools/lift.sh`: `out/lift/`) is a
derivative work of the game's executable and carries whatever license that
carries: it is made from your copy and never committed. The module
(`out/ra2.wasm`) contains it, and the page's server serves the game's data:
neither is this project's to give.

## License texts

### MIT

Each of these, under the permission notice below (in each one's own copy the
same words):

- Copyright (c) 2026 th0mk; portions copyright (c) 2026 Talha Müderrisoğlu
  (the original recompiler and macOS runtime): nfsu2-web
- Copyright (c) 2026 sp00nz: pcrecomp, redalert2-recomp
- Copyright (c) 2025 github.com/FunkyFr3sh: cnc-ddraw
- Copyright (c) 2019 MJP: the Catmull-Rom filter
- Copyright (C) 2011-2016 Hyllian/Jararaca - sergiogdb@gmail.com: the
  windowed-jinc 2-lobe filter (lanczos2)
- Copyright (C) 2011-2016 Hyllian - sergiogdb@gmail.com: the xBR-lv2 filter
- Copyright © 2005-2020 Rich Felker, et al.: musl (in wasi-libc)

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### BSD-2-Clause: cloudlibc (in wasi-libc)

```text
Copyright (c) 2015-2017 Nuxi (https://nuxi.nl/) and contributors.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR AND CONTRIBUTORS ``AS IS'' AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
SUCH DAMAGE.
```

### ISC: github.com/coder/websocket (the relay)

```text
Copyright (c) 2025 Coder

Permission to use, copy, modify, and distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### 0BSD: DDrawCompat

```text
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```
