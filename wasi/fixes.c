/*
 * fixes.c - what the game's bug fixes need of a host (lift/run_lift.py bugfix_patches; CnCNet's
 * fixes, refs/yrpp-spawner src/Misc/Bugfixes.ClampTacticalPos.cpp, read for its findings and
 * written anew).
 *
 * A map smaller than the view: the patched limits (0x6D8640) centre the view on it, and the
 * view's parts beside the map, where the tactical render draws no cell, would show whatever the
 * composite surface last held. Each such band is filled black, from the limits the game
 * computes before they are centred (the map's edges).
 */
#include <stdint.h>
#include <string.h>

#include "win32hle.h"

#define MAP_RECT_W      0x87F8DCu   /* MapClass::Instance (0x87F7E8) MapRect.Width */
#define VISIBLE_RECT    0x87F8E4u   /* MapClass VisibleRect: X, Y, Width, Height (cells) */
#define VIEW_BOUNDS     0x886FA0u   /* DSurface::ViewBounds: X, Y, Width, Height (pixels) */
#define TACTICAL        0x887324u   /* TacticalClass*; TacticalPos at +0xB0 */
#define COMPOSITE       0x88731Cu   /* DSurface* the tactical view is drawn into */
#define SURFACE_FILL_RECT 0x14u     /* Surface vtable: FillRect(RectangleStruct*, color) */

void ra2_log(int always, const char *fmt, ...) __attribute__((format(printf, 2, 3)));   /* main.c */

static uint32_t g_rect_va;          /* a RectangleStruct in guest memory */
static int32_t g_bands[4];          /* the last bands logged: left, right, top, bottom */

static void fill_black(uint32_t surface, int32_t x, int32_t y, int32_t w, int32_t h) {
    if (w <= 0 || h <= 0) return;
    if (!g_rect_va) g_rect_va = hle_va(hle_alloc(16));
    if (!g_rect_va) return;
    MEM32(g_rect_va) = (uint32_t)x, MEM32(g_rect_va + 4) = (uint32_t)y;
    MEM32(g_rect_va + 8) = (uint32_t)w, MEM32(g_rect_va + 12) = (uint32_t)h;
    uint32_t args[2] = { g_rect_va, 0 }, ecx = g_ecx;   /* thiscall: the surface in ecx, put back after */
    g_ecx = surface;
    hle_call_guest(MEM32(MEM32(surface) + SURFACE_FILL_RECT), 2, args);
    g_ecx = ecx;
}

/* The tactical render, its map drawn (0x6D4934): run as a lifted function */
void ra2_fix_map_edges(void) {
    uint32_t tactical = MEM32(TACTICAL), surface = MEM32(COMPOSITE);
    if (tactical && surface) {
        int32_t map_w = (int32_t)MEM32(MAP_RECT_W);
        int32_t vis_x = (int32_t)MEM32(VISIBLE_RECT), vis_y = (int32_t)MEM32(VISIBLE_RECT + 4);
        int32_t vis_w = (int32_t)MEM32(VISIBLE_RECT + 8), vis_h = (int32_t)MEM32(VISIBLE_RECT + 12);
        int32_t vx = (int32_t)MEM32(VIEW_BOUNDS), vy = (int32_t)MEM32(VIEW_BOUNDS + 4);
        int32_t vw = (int32_t)MEM32(VIEW_BOUNDS + 8), vh = (int32_t)MEM32(VIEW_BOUNDS + 12);
        /* the limits as 0x6D8640 computes them (cells 60 x 30 pixels) */
        int32_t min_x = vw / 2 + 30 * (2 * vis_x - map_w), max_x = min_x + 60 * vis_w - vw;
        int32_t min_y = vh / 2 + 15 * (map_w + 2 * vis_y - 5), max_y = min_y + (60 * vis_h + 270) / 2 - vh;
        int32_t pos_x = (int32_t)MEM32(tactical + 0xB0u), pos_y = (int32_t)MEM32(tactical + 0xB4u);
        int32_t left = vx + min_x - vw / 2 - pos_x, right = vx + max_x + (vw - vw / 2) - pos_x;
        int32_t top = vy + min_y - vh / 2 - pos_y, bottom = vy + max_y + (vh - vh / 2) - pos_y;
        int32_t b[4] = { left > vx ? left - vx : 0, right < vx + vw ? vx + vw - right : 0,
                         top > vy ? top - vy : 0, bottom < vy + vh ? vy + vh - bottom : 0 };
        if (memcmp(b, g_bands, sizeof b)) {
            memcpy(g_bands, b, sizeof b);
            ra2_log(0, "[fix] the map's edges in the view (%dx%d at %d,%d; x %d..%d, y %d..%d, at %d,%d): "
                    "black %d left, %d right, %d top, %d bottom", vw, vh, vx, vy, min_x, max_x, min_y, max_y,
                    pos_x, pos_y, b[0], b[1], b[2], b[3]);
        }
        fill_black(surface, vx, vy, b[0], vh);
        fill_black(surface, vx + vw - b[1], vy, b[1], vh);
        fill_black(surface, vx, vy, vw, b[2]);
        fill_black(surface, vx, vy + vh - b[3], vw, b[3]);
    }
    g_esp += 4;                        /* ret */
}
