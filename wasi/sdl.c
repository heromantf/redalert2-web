/*
 * sdl.c - the SDL2 and SDL_ttf calls of dsound.c, gdidc.c and menu.c, for the
 * WASI build (compat/SDL2/SDL.h says which and why).
 *
 * The audio device is a thread that runs the mixer (the callback), and where
 * its output goes is the page's: a ring in shared memory (ra2web_register
 * kind 3) that web/audio-worklet.js plays from, on the browser's audio thread.
 *
 * Who keeps the time: while the page plays (it sets ring.active), the sound
 * card's clock, through the ring: the thread mixes another buffer whenever
 * the ring holds less than TARGET frames, so the two clocks cannot drift
 * apart and DirectSound's play cursors move as the speakers play. While
 * nobody plays (the Node host, a page before its first click: browsers start
 * sound only after a gesture), the thread mixes in real time by its own clock
 * and the output goes nowhere, as SDL's dummy driver does: the cursors move
 * all the same, and a game that streams by watching them keeps streaming.
 */
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "SDL2/SDL.h"
#include "SDL2/SDL_ttf.h"

#define RA2WEB_IMPORT(name) __attribute__((import_module("ra2web"), import_name(name)))
RA2WEB_IMPORT("register") void ra2web_register(int kind, const void *ptr, int size);
enum { RA2WEB_AUDIO = 3 };

static const char *g_error = "";

const char *SDL_GetError(void) { return g_error; }
SDL_bool SDL_SetHint(const char *name, const char *value) { (void)name, (void)value; return SDL_TRUE; }
int SDL_setenv(const char *name, const char *value, int overwrite) { return setenv(name, value, overwrite); }
int SDL_InitSubSystem(Uint32 flags) { (void)flags; return 0; }
void SDL_QuitSubSystem(Uint32 flags) { (void)flags; }

/* ================================================================== audio */

/* Shared with web/audio-worklet.js and web/audio.js: eight 32-bit words, then
 * the samples, interleaved 16-bit. write and read count frames for ever
 * (wrapping at 2^32); a frame's place is its count & (frames - 1). */
#define RING_FRAMES 16384          /* ~370 ms at 44.1 kHz */
#define TARGET      4096           /* mixed ahead of the speakers: ~93 ms (RA2WEB_AUDIO_AHEAD: another, to measure) */
static uint32_t g_target = TARGET;
typedef struct {
    uint32_t write;                /* 0: frames mixed into the ring (this thread) */
    uint32_t read;                 /* 1: frames played from it (the worklet) */
    uint32_t frames;               /* 2: RING_FRAMES */
    uint32_t rate, channels;       /* 3, 4 */
    uint32_t active;               /* 5: the page plays from the ring (it says) */
    uint32_t underruns;            /* 6: quanta the worklet found short (it counts) */
    uint32_t pad;
    int16_t pcm[RING_FRAMES * 2];  /* byte 32 */
} ring_t;

static struct {
    SDL_AudioSpec spec;
    int open, paused;
    pthread_t thread;
    int started;
    ring_t *ring;
} g_dev;

static double now_s(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (double)t.tv_sec + (double)t.tv_nsec / 1e9;
}
static void sleep_s(double s) {
    if (s <= 0) return;
    struct timespec ts = { (time_t)s, (long)((s - (double)(time_t)s) * 1e9) };
    nanosleep(&ts, NULL);
}

static void mix(Uint8 *buf, int bytes) {
    if (g_dev.paused) memset(buf, 0, (size_t)bytes);
    else g_dev.spec.callback(g_dev.spec.userdata, buf, bytes);
}

static void *audio_thread(void *arg) {
    (void)arg;
    int frames = g_dev.spec.samples, ch = g_dev.spec.channels, bytes = frames * ch * 2;
    Uint8 *buf = (Uint8 *)malloc((size_t)bytes);
    ring_t *r = g_dev.ring;
    double period = (double)frames / g_dev.spec.freq, next = now_s();
    for (;;) {
        if (r && __atomic_load_n(&r->active, __ATOMIC_ACQUIRE)) {
            uint32_t w = r->write, fill = w - __atomic_load_n(&r->read, __ATOMIC_ACQUIRE);
            if (fill > RING_FRAMES) fill = RING_FRAMES;  /* the worklet ran ahead (an underrun): count from what it read */
            if (fill + (uint32_t)frames > g_target) { sleep_s((double)(fill + frames - g_target) / g_dev.spec.freq + 0.001); continue; }
            mix(buf, bytes);
            const int16_t *in = (const int16_t *)buf;
            for (int i = 0; i < frames; i++) {
                uint32_t at = ((w + (uint32_t)i) & (RING_FRAMES - 1)) * 2;
                r->pcm[at] = in[i * ch], r->pcm[at + 1] = in[i * ch + (ch > 1)];
            }
            __atomic_store_n(&r->write, w + (uint32_t)frames, __ATOMIC_RELEASE);
            next = now_s();
            continue;
        }
        mix(buf, bytes);                                /* nobody plays: by the clock, into nothing */
        next += period;
        double wait = next - now_s();
        if (wait < -0.25) next = now_s();              /* far behind (the process was stopped): no burst to catch up */
        else sleep_s(wait);
    }
    return NULL;
}

SDL_AudioDeviceID SDL_OpenAudioDevice(const char *device, int iscapture, const SDL_AudioSpec *desired,
                                      SDL_AudioSpec *obtained, int allowed_changes) {
    (void)device, (void)allowed_changes;
    if (iscapture || g_dev.open || !desired || !desired->callback || desired->format != AUDIO_S16SYS || desired->channels > 2) {
        g_error = "one 16-bit output device only";
        return 0;
    }
    g_dev.spec = *desired;
    const char *ahead = getenv("RA2WEB_AUDIO_AHEAD");      /* frames, a block (desired->samples) and a quantum more at least */
    if (ahead && atoi(ahead) >= desired->samples + 128 && atoi(ahead) <= RING_FRAMES / 2) {
        g_target = (uint32_t)atoi(ahead);
        fprintf(stderr, "[audio] mixed ahead: %u frames\n", g_target);
    }
    g_dev.spec.silence = 0;
    g_dev.spec.size = (Uint32)desired->samples * desired->channels * 2;
    if (obtained) *obtained = g_dev.spec;
    g_dev.open = 1, g_dev.paused = 1;
    g_dev.ring = (ring_t *)calloc(1, sizeof *g_dev.ring);
    if (g_dev.ring) {
        g_dev.ring->frames = RING_FRAMES, g_dev.ring->rate = (uint32_t)desired->freq, g_dev.ring->channels = 2;
        ra2web_register(RA2WEB_AUDIO, g_dev.ring, (int)sizeof *g_dev.ring);
    }
    return 1;
}

void SDL_PauseAudioDevice(SDL_AudioDeviceID dev, int pause_on) {
    if (dev != 1 || !g_dev.open) return;
    g_dev.paused = pause_on != 0;
    if (!g_dev.paused && !g_dev.started) {
        g_dev.started = pthread_create(&g_dev.thread, NULL, audio_thread, NULL) == 0;
        if (g_dev.started) pthread_detach(g_dev.thread);
    }
}

const char *SDL_GetCurrentAudioDriver(void) { return "wasi (the page's AudioWorklet, or silent)"; }

/* =============================================================== surfaces */

int SDL_LockSurface(SDL_Surface *s) { (void)s; return 0; }
void SDL_UnlockSurface(SDL_Surface *s) { (void)s; }
void SDL_FreeSurface(SDL_Surface *s) {
    if (!s) return;
    free(s->pixels), free(s->format), free(s);
}
SDL_RWops *SDL_RWFromConstMem(const void *mem, int size) { (void)mem, (void)size; return NULL; }

/* ========================================================== message boxes */

int SDL_ShowMessageBox(const SDL_MessageBoxData *d, int *buttonid) {
    fprintf(stderr, "[sdl] message box \"%s\": %s (answered: escape)\n", d->title ? d->title : "", d->message ? d->message : "");
    int id = -1;
    for (int i = 0; i < d->numbuttons; i++)
        if (d->buttons[i].flags & SDL_MESSAGEBOX_BUTTON_ESCAPEKEY_DEFAULT) id = d->buttons[i].buttonid;
    if (buttonid) *buttonid = id;
    return 0;
}

/* ============================================================== SDL_ttf */

static const char *const k_nofonts = "no fonts in the WASI build yet";
int TTF_Init(void) { g_error = k_nofonts; return -1; }
int TTF_WasInit(void) { return 0; }
const char *TTF_GetError(void) { return k_nofonts; }
TTF_Font *TTF_OpenFont(const char *file, int ptsize) { (void)file, (void)ptsize; return NULL; }
TTF_Font *TTF_OpenFontRW(SDL_RWops *src, int freesrc, int ptsize) { (void)src, (void)freesrc, (void)ptsize; return NULL; }
void TTF_CloseFont(TTF_Font *font) { (void)font; }
int TTF_FontHeight(const TTF_Font *font) { (void)font; return 13; }
int TTF_FontAscent(const TTF_Font *font) { (void)font; return 10; }
int TTF_FontDescent(const TTF_Font *font) { (void)font; return -3; }
const char *TTF_FontFaceFamilyName(const TTF_Font *font) { (void)font; return NULL; }
void TTF_SetFontStyle(TTF_Font *font, int style) { (void)font, (void)style; }
void TTF_SetFontHinting(TTF_Font *font, int hinting) { (void)font, (void)hinting; }
void TTF_SetFontKerning(TTF_Font *font, int allowed) { (void)font, (void)allowed; }
int TTF_SizeText(TTF_Font *font, const char *text, int *w, int *h) {
    (void)font;
    if (w) *w = 6 * (int)strlen(text);
    if (h) *h = 13;
    return 0;
}
int TTF_GlyphMetrics(TTF_Font *font, Uint16 ch, int *minx, int *maxx, int *miny, int *maxy, int *advance) {
    (void)font, (void)ch;
    if (minx) *minx = 0;
    if (maxx) *maxx = 6;
    if (miny) *miny = -3;
    if (maxy) *maxy = 10;
    if (advance) *advance = 6;
    return 0;
}
SDL_Surface *TTF_RenderText_Solid(TTF_Font *font, const char *text, SDL_Color fg) { (void)font, (void)text, (void)fg; return NULL; }
SDL_Surface *TTF_RenderText_Blended(TTF_Font *font, const char *text, SDL_Color fg) { (void)font, (void)text, (void)fg; return NULL; }
