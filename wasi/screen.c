/*
 * screen.c - win32hle's display API (win32hle.h, "The SDL2 display and input")
 * for the WASI build, in place of runtime/win32hle/screen.c: the picture and
 * the input go through shared memory to and from the page.
 *
 * The page (web/presenter.js, web/input.js) learns where two structures are
 * from ra2web_register (kind 1: frames, kind 2: input), a host import:
 *
 * - Frames. The pump hands each new frame of the primary surface (or a GDI
 *   game's window surface) to the frame hook, at most every 15 ms and at least
 *   every 250 ms, as the native presenter does, and so does the game drawing
 *   into the primary on its own thread (ddraw.c's hle_dd_primary_hook): on
 *   Windows the primary is the screen, and what the game draws without
 *   pumping messages (the menus' sliding buttons, 0x6071E0) shows as it
 *   draws, as natively. Each is copied as RGB565 into
 *   the next of three buffers, then bumps seq. The page takes the newest
 *   buffer at its own pace (requestAnimationFrame): the one being written is
 *   never the newest, and three publishes go by before a buffer is written
 *   again, so a page that reads one within that time reads it whole (it checks
 *   seq after, too). The header also says whether the page shows a cursor
 *   (the game's menus are Win32 dialogs and use the Windows cursor; in a game
 *   the game draws its own) and which: its 32x32 masks, from the game's
 *   resources.
 * - The screen. The page writes its screen's size, logical and in pixels,
 *   into the frames header (screen[]): the display modes the game is offered
 *   (web_modes, below) are those of that screen.
 * - Input. A ring of 256 events the page writes (head) and the pump reads
 *   (tail): a mouse message at game pixels, or a key with its virtual key and
 *   set-1 scan code (web/input.js maps the browser's key codes).
 *
 * Under Node (the tests) nobody registers anything to read the
 * frames, and nothing reads them: the copies cost a frame a few hundred µs.
 * The host is the web's own (wasi/main.c): no native window, none of the
 * remaster's presenter features (HD vehicles, the F10 menu, the FPS display).
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include "win32hle.h"

#define RA2WEB_IMPORT(name) __attribute__((import_module("ra2web"), import_name(name)))
RA2WEB_IMPORT("register") void ra2web_register(int kind, const void *ptr, int size);
enum { RA2WEB_FRAMES = 1, RA2WEB_INPUT = 2 };

/* Shared with web/presenter.js: every field a 32-bit word, then the masks. */
typedef struct {
    uint32_t seq;            /* 0: bumped when a frame is whole in buf[which] */
    uint32_t which;          /* 1: the newest buffer */
    uint32_t w, h;           /* 2, 3: its size, RGB565, w * 2 bytes a row */
    uint32_t buf[3];         /* 4..6: the buffers' addresses */
    uint32_t cap;            /* 7: bytes a buffer holds */
    uint32_t cursor;         /* 8: 1: the page shows a cursor; 0: the game draws its own */
    uint32_t cursor_handle;  /* 9: whose (0: the system arrow) */
    int32_t hot_x, hot_y;    /* 10, 11: its hot spot */
    uint8_t and_mask[128];   /* 48: 32x32, a bit a pixel, rows of 4 bytes, top first */
    uint8_t xor_mask[128];   /* 176 */
    int32_t screen[4];       /* 304 (word 76), the page's: its screen, logical w, h, and in pixels w, h (0: not known) */
} frames_t;

#define RING 256
typedef struct {
    uint32_t head, tail;     /* the page writes ev[head % RING] then bumps head; the pump reads at tail */
    int32_t ev[RING][4];     /* { 1, message, x, y }: a mouse message; { 2, down, vk, scan }: a key */
} input_t;

static frames_t *g_frames;
static input_t *g_input;

static unsigned g_shown_seq = ~0u;
static uint32_t g_last_present;

/* The display API's hooks a host sets (win32hle.h): here only the frame hook
 * and the cursor's (wasi/main.c). The settings, the F10 menu, the FPS display
 * and HD vehicles' overlay are the native presenter's: the page has its own
 * (web/settings.js, presenter.js). */
void (*hle_screen_frame_hook)(const uint8_t *px, int w, int h, int pitch, int bpp);
int (*hle_screen_cursor_hook)(void);
int hle_screen_desktop(int *w, int *h) {
    if (!g_frames || g_frames->screen[0] <= 0) return 0;
    *w = __atomic_load_n(&g_frames->screen[0], __ATOMIC_RELAXED), *h = __atomic_load_n(&g_frames->screen[1], __ATOMIC_RELAXED);
    return 1;
}

/* The modes the game is offered (ddraw.c's hle_dd_modes_hook) as a display
 * offers them, which the Steam release's DDrawCompat passes on ("native" in
 * EA's DDrawCompat.ini: every mode of the display): ddraw.c's table, those of
 * its sizes that fit the screen in pixels, and the screen's own sizes,
 * logical and in pixels (a Retina or scaled display has both: the pixels are
 * what DDrawCompat would offer, the logical size draws the game's sidebar and
 * text at their usual size); 640x480 and 800x600 always, as EA's ini lists
 * them. A screen past 3840x2160 adds no size of its own (ddraw.c's bound). The
 * game asks each time its Options screen lists them. */
static int web_modes(int (*out)[2]) {
    int n = hle_dd_modes(0, 0, out), sc[4] = { 0, 0, 0, 0 };
    for (int i = 0; g_frames && i < 4; i++) sc[i] = __atomic_load_n(&g_frames->screen[i], __ATOMIC_RELAXED);
    int pw = sc[2], ph = sc[3];
    if (pw < 640 || ph < 480) return n;                  /* the page has not said: the table */
    for (int e = 0; e < 2; e++) {
        int w = sc[2 * e], h = sc[2 * e + 1], have = 0;
        if (w < 640 || h < 480 || w > 3840 || h > 2160) continue;
        for (int i = 0; i < n; i++) have |= out[i][0] == w && out[i][1] == h;
        if (!have && n < HLE_DD_MAX_MODES) out[n][0] = w, out[n++][1] = h;
    }
    int k = 0;
    for (int i = 0; i < n; i++) {
        int w = out[i][0], h = out[i][1];
        if ((w <= pw && h <= ph) || (w == 640 && h == 480) || (w == 800 && h == 600)) out[k][0] = w, out[k++][1] = h;
    }
    for (int i = 1; i < k; i++)                          /* smallest first: by width, then height */
        for (int j = i; j > 0 && (out[j][0] < out[j - 1][0] || (out[j][0] == out[j - 1][0] && out[j][1] < out[j - 1][1])); j--) {
            int t0 = out[j][0], t1 = out[j][1];
            out[j][0] = out[j - 1][0], out[j][1] = out[j - 1][1], out[j - 1][0] = t0, out[j - 1][1] = t1;
        }
    static char said[1024];
    char line[1024];
    int o = snprintf(line, sizeof line, "[screen] the modes offered, a screen of %dx%d (%dx%d pixels):", sc[0], sc[1], pw, ph);
    for (int i = 0; i < k && o < (int)sizeof line - 12; i++) o += snprintf(line + o, sizeof line - o, " %dx%d", out[i][0], out[i][1]);
    if (strcmp(line, said)) { fprintf(stderr, "%s\n", line); snprintf(said, sizeof said, "%s", line); }
    return k;
}

/* ---- frames ---- */

static void publish(const uint8_t *px, int w, int h, int pitch, int bpp, const uint32_t *pal) {
    frames_t *f = g_frames;
    uint32_t need = (uint32_t)w * (uint32_t)h * 2u;
    if (need > f->cap) {                              /* a bigger mode: three new buffers */
        for (int i = 0; i < 3; i++) { free((void *)(uintptr_t)f->buf[i]); f->buf[i] = (uint32_t)(uintptr_t)malloc(need); }
        f->cap = need;
        if (!f->buf[0] || !f->buf[1] || !f->buf[2]) { f->cap = 0; return; }
    }
    uint32_t next = (f->which + 1) % 3;
    uint16_t *out = (uint16_t *)(uintptr_t)f->buf[next];
    for (int y = 0; y < h; y++) {
        const uint8_t *row = px + (ptrdiff_t)y * pitch;
        uint16_t *o = out + (size_t)y * (size_t)w;
        if (bpp == 16) memcpy(o, row, (size_t)w * 2);
        else if (bpp == 8)
            for (int x = 0; x < w; x++) {
                uint32_t e = pal ? pal[row[x]] : 0;      /* PALETTEENTRY: r, g, b in the low bytes */
                o[x] = (uint16_t)(((e & 0xFF) >> 3) << 11 | ((e >> 8 & 0xFF) >> 2) << 5 | (e >> 16 & 0xFF) >> 3);
            }
        else if (bpp == 32)
            for (int x = 0; x < w; x++) {
                uint32_t c = ((const uint32_t *)row)[x];   /* XRGB */
                o[x] = (uint16_t)((c >> 19 & 0x1F) << 11 | (c >> 10 & 0x3F) << 5 | (c >> 3 & 0x1F));
            }
        else memset(o, 0, (size_t)w * 2);
    }
    f->w = (uint32_t)w, f->h = (uint32_t)h;
    __atomic_store_n(&f->which, next, __ATOMIC_RELEASE);
    __atomic_fetch_add(&f->seq, 1, __ATOMIC_RELEASE);
}

static void update_cursor(void) {
    frames_t *f = g_frames;
    int show = hle_screen_cursor_hook && hle_screen_cursor_hook();
    uint32_t handle = show ? hle_current_cursor() : 0;
    if (show && handle != f->cursor_handle) {
        const hle_cursor_image_t *img = hle_cursor_image(handle);
        if (img) memcpy(f->and_mask, img->and_mask, 128), memcpy(f->xor_mask, img->xor_mask, 128), f->hot_x = img->hot_x, f->hot_y = img->hot_y;
        else handle = 0;
        __atomic_store_n(&f->cursor_handle, handle, __ATOMIC_RELEASE);
    }
    __atomic_store_n(&f->cursor, (uint32_t)show, __ATOMIC_RELEASE);
}

static volatile uint32_t g_changes, g_given;       /* RA2WEB_FRAME_STATS's counts (below) */
static void present(void) {
    const uint8_t *px;
    const uint32_t *pal = NULL;
    int w, h, pitch, bpp;
    unsigned seq;
    if (!hle_dd_frame(&px, &w, &h, &pitch, &bpp, &pal, &seq) && !hle_gdi_window_frame(&px, &w, &h, &pitch, &bpp, &seq)) return;
    uint32_t now = hle_ticks_ms();
    if (seq == g_shown_seq && now - g_last_present < 250) return;
    if (now - g_last_present < 15) return;
    g_shown_seq = seq, g_last_present = now;
    g_given++;
    if (hle_screen_frame_hook) hle_screen_frame_hook(px, w, h, pitch, bpp);
    if (g_frames) publish(px, w, h, pitch, bpp, pal);
}

/* ---- input ---- */

static void drain_input(void) {
    input_t *in = g_input;
    uint32_t head = __atomic_load_n(&in->head, __ATOMIC_ACQUIRE), tail = in->tail;
    for (; tail != head; tail++) {
        const int32_t *e = in->ev[tail % RING];
        if (e[0] == 1) hle_input_mouse((uint32_t)e[1], e[2], e[3]);
        else if (e[0] == 2) hle_input_key(e[1] != 0, (uint32_t)e[2], (uint32_t)e[3]);
        else if (e[0] == 3) hle_input_wheel(e[1], e[2], e[3]);
    }
    __atomic_store_n(&in->tail, tail, __ATOMIC_RELEASE);
}

/* RA2WEB_FRAME_STATS=1 (a test): how often the game changes the primary (its
 * frames, as DDrawCompat counts them) and how many of those went to the page,
 * a line every 5 s. */
static uint32_t g_stats_t;
static int g_stats;
static void frame_stats(void) {
    uint32_t now = hle_ticks_ms();
    if (!g_stats_t) { g_stats_t = now; return; }
    if (now - g_stats_t < 5000) return;
    fprintf(stderr, "[frames] the primary changed %.0f times a second, %.0f of them given to the page\n",
            g_changes * 1000.0 / (now - g_stats_t), g_given * 1000.0 / (now - g_stats_t));
    g_changes = g_given = 0, g_stats_t = now;
}

/* The game drew into the primary on its own thread (the one that opened the
 * screen and pumps). A battle frame is two changes within a millisecond (two
 * DSurface::Unlock, 0x4BAF40) and then a pump, which shows it whole. Shown at
 * each change, as the native screen.c does, 21 of 1,400 battle frames went
 * out with only the first (measured in a campaign). So a change shows at
 * once only when the game has gone on drawing without pumping for 15 ms or
 * more since its first change after a pump: a loop of its own (the menus'
 * sliding buttons, 30 ms a step, 0x6071E0; a loading screen), or a frame
 * stalled between its two changes (3 in 1,400, shown whole at the second). */
static pthread_t g_game_thread;
static int g_drawn_since_pump;
static uint32_t g_first_draw_ms;
static void primary_changed(void) {
    if (g_stats) g_changes++;
    if (!pthread_equal(pthread_self(), g_game_thread)) return;
    uint32_t now = hle_ticks_ms();
    if (!g_drawn_since_pump) { g_drawn_since_pump = 1, g_first_draw_ms = now; return; }
    if (now - g_first_draw_ms < 15) return;
    present();
}

void hle_screen_pump(void) {
    if (g_input) drain_input();
    if (g_frames) update_cursor();
    present();
    g_drawn_since_pump = 0;
    if (g_stats) frame_stats();
}

int hle_screen_open(const char *title, int fullscreen, int headless) {
    (void)title, (void)fullscreen, (void)headless;   /* full screen is the page's (web/fullscreen.js) */
    hle_set_pump_hook(hle_screen_pump);
    hle_gdi_window_hook = present;
    hle_dd_modes_hook = web_modes;
    g_game_thread = pthread_self();
    hle_dd_primary_hook = primary_changed;
    g_stats = getenv("RA2WEB_FRAME_STATS") != NULL;
    g_frames = (frames_t *)calloc(1, sizeof *g_frames);
    g_input = (input_t *)calloc(1, sizeof *g_input);
    if (g_frames) ra2web_register(RA2WEB_FRAMES, g_frames, (int)sizeof *g_frames);
    if (g_input) ra2web_register(RA2WEB_INPUT, g_input, (int)sizeof *g_input);
    return 0;
}
