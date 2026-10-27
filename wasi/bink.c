/*
 * bink.c - BINKW32 for the WASI build, in place of runtime/win32hle/bink.c,
 * whose ffmpeg decoder there is none of here: movies that play as black, at
 * their own size, length and frame rate.
 *
 * Without a decoder, runtime/win32hle/bink.c fails BinkOpen ("as with a movie
 * that is not there"), and Yuri's Revenge does not survive that: after the
 * main menu's background movie fails it reads through a null pointer. The
 * native host without ffmpeg (WITH_FFMPEG=OFF) faults there (SIGBUS at guest
 * address 0, spike/perf/native-nomovie.sh); in wasm address 0 is memory, so the
 * game reads zeros instead and spins in DSurface::Lock with its menu dead.
 *
 * So BinkOpen succeeds: the movie's header (ffmpeg's bink demuxer reads the
 * same fields) gives Width, Height, Frames and the frame rate, which games read
 * from the handle directly; BinkWait paces frames by that rate, BinkNextFrame
 * and BinkGoto move FrameNum, BinkCopyToBuffer paints the movie's rectangle
 * black, and there is no sound. A movie lasts as long as it would, and loops as
 * it would; the Esc that skips one still does. A decoder (ffmpeg's Bink, built
 * for wasm) would go in here.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include "win32hle.h"

#define BINKFILEHANDLE 0x00800000u

static const char *g_error = "";
static void k_GetError(void) {                           /* a copy in guest memory, made once per message */
    static const char *copied_from;
    static uint32_t va;
    if (copied_from != g_error) va = hle_guest_strdup(g_error), copied_from = g_error;
    RET(va, 0);
}
static void k_SetSoundSystem(void) { RET(1, 2); }        /* (open, param): DirectSound, which is ours */
static void k_OpenDirectSound(void) { RET(0, 1); }
static void k_DDSurfaceType(void) {                      /* BinkDDSurfaceType(surface): its BINKSURFACE type */
    uint8_t *px;
    int w, h, pitch, bpp;
    if (!hle_dd_surface_pixels(A32(0), &px, &w, &h, &pitch, &bpp)) RET(0xFFFFFFFFu, 1);
    RET(bpp == 16 ? 10u /* 565 */ : bpp == 32 ? 3u /* 32 */ : bpp == 24 ? 1u : 0u, 1);
}

/* The guest-visible struct: Bink's leading fields, then ours, out of sight. */
typedef struct {
    uint32_t Width, Height, Frames, FrameNum, LastFrameNum, FrameRate, FrameRateDiv, ReadError, OpenFlags, BinkType,
             Size, FrameSize, SndSize;
    uint32_t pad[64];
    int fd;                       /* ours: the file, if BinkOpen opened it */
    int paused;
    int at_end;                   /* the last frame done (runtime/win32hle/bink.c's k_Wait) */
    int started;                  /* the clock from the first frame (runtime/win32hle/bink.c's clock_start) */
    uint32_t start_ms, paused_at;
} bink_t;

static uint32_t le32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }

static void k_Open(void) {                               /* (name or handle, flags) */
    uint32_t flags = A32(1);
    int fd;
    off_t base = 0;
    if (flags & BINKFILEHANDLE) {                         /* the game's own file, at the movie (inside an archive) */
        fd = hle_file_fd(A32(0));
        base = fd >= 0 ? lseek(fd, 0, SEEK_CUR) : 0;
    } else {
        char path[1024];
        hle_host_path(ASTR(0), path, sizeof path);
        fd = open(path, O_RDONLY);
    }
    if (fd < 0) { g_error = "cannot open the movie"; RET(0, 2); }
    /* 'BIK' and a revision, file size - 8, frames, largest frame, (frames), width, height, fps num, fps den */
    uint8_t h[36];
    if (pread(fd, h, sizeof h, base) != (ssize_t)sizeof h || memcmp(h, "BIK", 3) != 0) {
        if (!(flags & BINKFILEHANDLE)) close(fd);
        g_error = "not a Bink movie";
        RET(0, 2);
    }
    bink_t *b = (bink_t *)hle_alloc(sizeof *b);          /* the guest reads its leading fields */
    b->fd = flags & BINKFILEHANDLE ? -1 : fd;
    b->OpenFlags = flags;
    b->Frames = le32(h + 8), b->Width = le32(h + 20), b->Height = le32(h + 24);
    b->FrameRate = le32(h + 28), b->FrameRateDiv = le32(h + 32);
    if (!b->FrameRate || !b->FrameRateDiv) b->FrameRate = 15, b->FrameRateDiv = 1;
    if (!b->Frames) b->Frames = 1;
    b->FrameNum = 1, b->LastFrameNum = 0;
    fprintf(stderr, "[bink] %ux%u, %u frames at %u/%u fps (no decoder: black, silent)\n",
            b->Width, b->Height, b->Frames, b->FrameRate, b->FrameRateDiv);
    RETP(b, 2);
}
static void k_Close(void) {
    bink_t *b = (bink_t *)APTR(0);
    if (b) { if (b->fd >= 0) close(b->fd); hle_free(b); }
    RETV(1);
}
static void clock_start(bink_t *b) {
    if (b->started) return;
    b->started = 1;
    b->start_ms = hle_ticks_ms() - (uint32_t)((uint64_t)(b->FrameNum - 1) * 1000u * b->FrameRateDiv / b->FrameRate);
}
static void k_DoFrame(void) { bink_t *b = (bink_t *)APTR(0); clock_start(b); b->LastFrameNum = b->FrameNum; if (b->FrameNum >= b->Frames) b->at_end = 1; RET(0, 1); }
static void k_NextFrame(void) { bink_t *b = (bink_t *)APTR(0); if (b->FrameNum < b->Frames) b->FrameNum++; RETV(1); }
/* BinkWait: nonzero while it is not yet time for the next frame; never again
 * once the last is done (the game's catch-up loop, 0x432E40, ends there). */
static void k_Wait(void) {
    bink_t *b = (bink_t *)APTR(0);
    if (b->paused || b->at_end) RET(1, 1);
    if (!b->started) RET(0, 1);                          /* the first frame: due now */
    uint64_t due = (uint64_t)(b->FrameNum - 1) * 1000u * b->FrameRateDiv / b->FrameRate;
    RET(hle_ticks_ms() - b->start_ms < due ? 1u : 0u, 1);
}
static void k_Pause(void) {                              /* (bink, pause) -> the state */
    bink_t *b = (bink_t *)APTR(0);
    int p = A32(1) != 0;
    if (p && !b->paused) b->paused_at = hle_ticks_ms();
    if (!p && b->paused && b->started) b->start_ms += hle_ticks_ms() - b->paused_at;
    b->paused = p;
    RET((uint32_t)p, 2);
}
static void k_SetVolume(void) { RETV(2); }
static void k_Goto(void) {                               /* (bink, frame, flags) */
    bink_t *b = (bink_t *)APTR(0);
    uint32_t to = A32(1) ? A32(1) : 1;
    b->FrameNum = to > b->Frames ? b->Frames : to, b->at_end = 0, b->started = 1;
    b->start_ms = hle_ticks_ms() - (uint32_t)((uint64_t)(b->FrameNum - 1) * 1000u * b->FrameRateDiv / b->FrameRate);
    RETV(3);
}
/* BinkCopyToBuffer(bink, dest, pitch, height, x, y, flags): the movie's
 * rectangle of the buffer, black, at the type flags' low bits name. */
static void k_CopyToBuffer(void) {
    bink_t *b = (bink_t *)APTR(0);
    uint8_t *dst = (uint8_t *)APTR(1);
    int pitch = (int)A32(2), dh = (int)A32(3), dx = (int)A32(4), dy = (int)A32(5), type = (int)(A32(6) & 0xF);
    int bytes = type == 10 || type == 9 ? 2 : type == 3 || type == 5 ? 4 : 0;
    if (!dst || !bytes || dx < 0 || dy < 0 || pitch <= 0) RET(0, 7);
    for (int y = 0; y < (int)b->Height && dy + y < dh; y++) {
        uint8_t *row = dst + (size_t)(dy + y) * (size_t)pitch + (size_t)dx * (size_t)bytes;
        size_t n = (size_t)b->Width * (size_t)bytes;
        if ((size_t)dx * (size_t)bytes + n > (size_t)pitch) n = (size_t)pitch > (size_t)dx * (size_t)bytes ? (size_t)pitch - (size_t)dx * (size_t)bytes : 0;
        if (bytes == 4) for (size_t i = 0; i < n / 4; i++) ((uint32_t *)row)[i] = 0xFF000000u;
        else memset(row, 0, n);
    }
    RET(0, 7);
}

/* ---- BinkBuffer: where a GDI game has Bink put the picture (bink.c's) ---- */
typedef struct {
    uint32_t Width, Height, WindowWidth, WindowHeight, SurfaceType, Buffer;
    int32_t BufferPitch;
    uint32_t ClientOffsetX, ClientOffsetY, ScreenWidth, ScreenHeight, ScreenDepth;
    uint32_t pad[48];
    int destx, desty;                                    /* ours */
} binkbuf_t;
static void k_BufferOpen(void) {                         /* (hwnd, width, height, flags) */
    binkbuf_t *b = (binkbuf_t *)hle_alloc(sizeof *b);
    int sw, sh, pitch, bpp;
    const uint8_t *px;
    b->Width = b->WindowWidth = A32(1), b->Height = b->WindowHeight = A32(2);
    b->SurfaceType = 3;                                  /* BINKSURFACE32 */
    b->BufferPitch = (int32_t)(b->Width * 4);
    b->Buffer = hle_va(hle_alloc((b->Width * b->Height + 1) * 4u));
    if (hle_gdi_window_frame(&px, &sw, &sh, &pitch, &bpp, NULL)) b->ScreenWidth = (uint32_t)sw, b->ScreenHeight = (uint32_t)sh, b->ScreenDepth = (uint32_t)bpp;
    RETP(b, 4);
}
static void k_BufferClose(void) { binkbuf_t *b = (binkbuf_t *)APTR(0); if (b) hle_free(hle_ptr(b->Buffer)), hle_free(b); RETV(1); }
static void k_BufferLock(void) { RET(A32(0) != 0, 1); }
static void k_BufferUnlock(void) { RET(1, 1); }
static void k_BufferSetOffset(void) { binkbuf_t *b = (binkbuf_t *)APTR(0); if (b) b->destx = (int)A32(1), b->desty = (int)A32(2); RET(1, 3); }
static void k_BufferBlit(void) { RETV(3); }               /* black on black: nothing to put on the window */
static void k_GetRects(void) { RET(1, 2); }              /* (bink, flags): one rectangle, the whole frame */
static void k_SetIOSize(void) { RETV(1); }

const win32hle_shim win32hle_bink[] = {
    { "_BinkBufferOpen@16", k_BufferOpen }, { "_BinkBufferClose@4", k_BufferClose },
    { "_BinkBufferLock@4", k_BufferLock }, { "_BinkBufferUnlock@4", k_BufferUnlock },
    { "_BinkBufferSetOffset@12", k_BufferSetOffset }, { "_BinkBufferBlit@12", k_BufferBlit },
    { "_BinkGetRects@8", k_GetRects }, { "_BinkSetIOSize@4", k_SetIOSize },
    { "_BinkOpen@8", k_Open }, { "_BinkClose@4", k_Close }, { "_BinkDoFrame@4", k_DoFrame },
    { "_BinkNextFrame@4", k_NextFrame }, { "_BinkWait@4", k_Wait }, { "_BinkCopyToBuffer@28", k_CopyToBuffer },
    { "_BinkGoto@12", k_Goto }, { "_BinkPause@8", k_Pause }, { "_BinkSetVolume@8", k_SetVolume },
    { "_BinkGetError@0", k_GetError }, { "_BinkSetSoundSystem@8", k_SetSoundSystem },
    { "_BinkOpenDirectSound@4", k_OpenDirectSound }, { "_BinkDDSurfaceType@4", k_DDSurfaceType },
    { 0, 0 } };
