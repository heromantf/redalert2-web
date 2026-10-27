/*
 * main.c - the web's host for Yuri's Revenge: the game as it shipped, with
 * what the Steam release's wrappers (DDrawCompat, cnc-ddraw) give it on the
 * page (web/presenter.js, settings.js), in place of the native host
 * (redalert2-recomp's src/linux/main.c: NOTICE.md) and the remaster's own features:
 * no HD vehicles, Modern controls, mods, F10 menu, FPS display or ra2.ini.
 *
 * The lift is the native one, and some of its patches call into a host
 * (run_lift.py): the remaster's features answer here as they do switched
 * off, so the game runs its own code. Its two fixes stay: the sidebar's rows
 * capped (above 1440 lines only) and the line clipper's rounds (issue #20).
 *
 * What is here: the command line, the game's own AllowHiResModes on, the
 * player's name and the virtual LAN (net.c) when the page joins one, the
 * game's debug log and this host's (ra2_log), Protocol Zero's switch
 * (--protocol-zero, protocol_zero.c), its message boxes,
 * Blowfish's COM class (src/linux/blowfish.c), the scripted input the tests
 * drive (src/linux/script.c), the cursor the page shows, a frame checksum
 * every 3.33 s, the watchdog.
 */
#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <ctype.h>
#include <string.h>
#include <strings.h>
#include <time.h>
#include <unistd.h>
#include <limits.h>
#include <pthread.h>

#include "win32hle.h"
#include "pe_loader.h"
#include "host.h"
#include "recomp_target.h"

#ifdef RA2_TARGET_GAME
#error "the web builds Yuri's Revenge (out/lift/gen): its addresses are here"
#endif

extern const uint32_t ra2_entry_va;   /* recomp_dispatch.c */
void ra2web_net_start(void);          /* net.c */

#define RA2_IMAGE_BASE 0x00400000u

static int g_debuglog;
static unsigned g_watchdog_s;
static const char *g_dump_dir;        /* --dump-frames DIR: the checksummed frames as BMPs too (tests) */

/* ---- what the lift calls into (run_lift.py HOOKS and patches) ------------- */

int  script_arg(int argc, char **argv, int i);   /* script.c */
int  script_active(void);
void script_log_line(const char *line);
void script_start(void);

/* A line of this host's own log (protocol_zero.c's [pz], [net]): to a test's
 * script, and with --debuglog (or always) to stderr. */
void ra2_log(int always, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
void ra2_log(int always, const char *fmt, ...) {
    if (!always && !g_debuglog && !script_active()) return;
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    script_log_line(buf);
    if (always || g_debuglog) fprintf(stderr, "%s\n", buf);
}
int ra2_log_on(void) { return g_debuglog || script_active(); }
void ra2_pz_option(int on);           /* protocol_zero.c */

/* The game's debug printf, compiled out of the retail build: --debuglog
 * prints it (its arguments read off the guest stack, a %s as a guest
 * address: hle_guest_format). */
void ra2_hook_debuglog(void) {
    if (g_debuglog || script_active()) {
        char buf[1024];
        hle_guest_format(buf, sizeof buf, (const char *)hle_ptr(MEM32(g_esp + 4)), g_esp + 8);
        size_t n = strlen(buf);
        script_log_line(buf);
        if (g_debuglog) fprintf(stderr, "[game] %s%s", buf, n && buf[n - 1] == '\n' ? "" : "\n");
    }
    g_esp += 4;                        /* ret */
}

/* The two fixes: the line clipper's round count (clip_line_patches); the
 * sidebar's cap needs nothing of a host. */
unsigned ra2_clip_rounds;

/* HD vehicles (the remaster's, src/runtime/hdvox.c): off, as there with
 * ra2_vox_hd_on 0. The frame surface's copies still say the frame time with
 * RA2_FRAME_STATS=1, as hdvox.c's do (spike/perf). */
int ra2_vox_hd_on, ra2_vox_hd_passes;
int16_t ra2_vox_dx, ra2_vox_dy;
int ra2_vox_hd_begin(uint32_t rect) { (void)rect; return 0; }
int ra2_vox_hd_begin_at(uint32_t save, uint32_t len) { (void)save, (void)len; return 0; }
void ra2_vox_hd_pass(int k) { (void)k; }
uint32_t ra2_vox_hd_end(void) { return 0; }
void ra2_vox_hd_blit(uint32_t dest, uint32_t convert, uint32_t esp) { (void)dest, (void)convert, (void)esp; }
void ra2_vox_hd_blitted(void) {}
void ra2_vox_unit_copy(uint32_t dest, uint32_t esp) { (void)dest, (void)esp; }
void ra2_vox_unit_copied(void) {}
void ra2_vox_shadow_blit(uint32_t dest, uint32_t esp) { (void)dest, (void)esp; }
void ra2_vox_shadow_blitted(void) {}
void ra2_vox_anim_shadow_blit(uint32_t dest, uint32_t esp) { (void)dest, (void)esp; }
void ra2_vox_anim_shadow_blitted(void) {}
void ra2_vox_anim_blit(uint32_t dest, uint32_t convert, uint32_t esp) { (void)dest, (void)convert, (void)esp; }
void ra2_vox_anim_blitted(void) {}
#define RA2_FRAME_SURF_VA 0x00887308u   /* the battlefield's frame surface (hdvox.c FRAME_SURF, Yuri's Revenge) */
void ra2_vox_frame_blit(uint32_t dest, uint32_t argp) {
    static int stats = -1;
    static uint64_t last, sum;
    static long n;
    (void)argp;
    if (stats < 0) stats = getenv("RA2_FRAME_STATS") != NULL;
    if (!stats || dest != MEM32(RA2_FRAME_SURF_VA)) return;
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    uint64_t now = (uint64_t)t.tv_sec * 1000000000u + (uint64_t)t.tv_nsec;
    if (last) sum += now - last, n++;
    last = now;
    if (n == 2000) {
        fprintf(stderr, "[frames] %.2f ms between frame copies (HD voxels off)\n", sum / 1e6 / n);
        sum = 0, n = 0;
    }
}

/* Modern controls and Queue Five (the remaster's, src/runtime/present.c and
 * queuefive.c): the game's own input, as Classic. */
int ra2_modern_controls(void) { return 0; }
uint32_t ra2_modern_mouse_message(uint32_t message, int special) { (void)special; return message; }
uint32_t ra2_modern_radar_event_flags(uint32_t flags) { return flags; }
uint32_t ra2_modern_left_click_action(uint32_t action, uint32_t target, uint32_t target_vtable,
                                      int selected_in_group, uint32_t selection_count, int special) {
    (void)target, (void)target_vtable, (void)selected_in_group, (void)selection_count, (void)special;
    return action;
}
int ra2_modern_take_type_select(void) { return 0; }
void ra2_modern_end_left_up(void) {}
int ra2_modern_preserve_global_selection_clear(void) { return 0; }
int ra2_modern_preserve_shift_selection(void) { return 0; }
int ra2_modern_consume_right_drag_release(void) { return 0; }
int ra2_modern_shift_box_begin(void) { return 0; }
void ra2_modern_shift_box_decide(void) {}
void ra2_modern_shift_box_end(void) {}
int ra2_modern_box_object(int selected) { (void)selected; return 1; }
int ra2_queue_five_append(uint32_t event_va, uint32_t timestamp) { (void)event_va, (void)timestamp; return 0; }

/* ---- game-specific answers ------------------------------------------------ */

/* Message boxes print; a question is answered No (as the page did through
 * the native host's --headless). */
static void ra2_MessageBoxA(void) {
    uint32_t type = A32(3), buttons = type & 0xF;
    uint32_t answer = buttons == 4 || buttons == 3 ? 7u : 1u;
    fprintf(stderr, "[messagebox] %s: %s -> %u\n", ASTR(2) ? ASTR(2) : "", ASTR(1) ? ASTR(1) : "", answer);
    RET(answer, 4);
}

static const win32hle_shim g_ra2_shims[] = {
    { "MessageBoxA", ra2_MessageBoxA },
    { 0, 0 }
};

/* WinMain checks that Blowfish.dll, the Westwood cipher's COM server, can be
 * created, and the MIX archives' headers are decrypted through it: its object
 * is served by blowfish.c. */
static const uint8_t CLSID_Blowfish[16] = { 0x10, 0xAD, 0x40, 0x14, 0xA8, 0x6A, 0xD1, 0x11,
                                            0xB6, 0xF9, 0x00, 0xA0, 0x24, 0xDD, 0xAF, 0xD1 };
uint32_t ra2_blowfish_create(const uint8_t *iid, uint32_t *out);

/* ---- the watchdog --------------------------------------------------------- */
static void *watchdog(void *arg) {
    (void)arg;
    sleep(g_watchdog_s);
    fprintf(stderr, "\n[watchdog] %u s: in sub_%08X, last import %s, %u indirect calls\n",
            g_watchdog_s, g_cur_func, g_cur_import ? g_cur_import : "(none)", g_icall_count);
    fflush(stderr);
    hle_exit(4);
    return NULL;
}

/* ---- frames: a checksum every 3.33 s (the tests count distinct ones) ------ */
static long g_shown;
static void dump_bmp(const uint8_t *px, int w, int h, int pitch, int bpp, long n) {
    char path[1024];
    snprintf(path, sizeof path, "%s/frame_%05ld.bmp", g_dump_dir, n);
    FILE *f = fopen(path, "wb");
    if (!f || bpp != 16) { if (f) fclose(f); return; }
    uint32_t row = (uint32_t)(w * 3 + 3) & ~3u, size = 54 + row * (uint32_t)h;
    uint8_t hdr[54] = { 'B', 'M' };
    memcpy(hdr + 2, &size, 4);
    hdr[10] = 54, hdr[14] = 40;
    memcpy(hdr + 18, &w, 4);
    memcpy(hdr + 22, &h, 4);
    hdr[26] = 1, hdr[28] = 24;
    fwrite(hdr, 1, 54, f);
    uint8_t *line = (uint8_t *)calloc(1, row);
    for (int y = h - 1; line && y >= 0; y--) {
        const uint16_t *s = (const uint16_t *)(px + (size_t)y * pitch);
        for (int x = 0; x < w; x++) {
            uint16_t p = s[x];
            line[3 * x] = (uint8_t)((p & 31) << 3), line[3 * x + 1] = (uint8_t)((p >> 5 & 63) << 2), line[3 * x + 2] = (uint8_t)((p >> 11) << 3);
        }
        fwrite(line, 1, row, f);
    }
    free(line);
    fclose(f);
}
static uint32_t checksum(const uint8_t *px, int w, int h, int pitch, int bpp) {
    uint32_t sum = 0;
    for (int y = 0; y < h; y += 4)
        for (int x = 0; x < w * bpp / 8; x += 16) sum = sum * 31 + px[(size_t)y * pitch + x];
    return sum;
}
static void frame_pump(void) {
    static uint32_t next;
    const uint8_t *px;
    const uint32_t *pal;
    int w, h, pitch, bpp;
    hle_screen_pump();
    uint32_t now = hle_ticks_ms();
    if ((int32_t)(now - next) < 0 || !hle_dd_frame(&px, &w, &h, &pitch, &bpp, &pal, NULL)) return;
    next = now + 3333;
    fprintf(stderr, "[record] frame %ld checksum %08X game frame %u\n", g_shown * 100, checksum(px, w, h, pitch, bpp),
            MEM32(RA2_GAME_FRAME_VA));
    if (g_dump_dir) dump_bmp(px, w, h, pitch, bpp, g_shown);
    g_shown++;
}

/* The cursor, as on Windows: the menus are Win32 dialogs and use the Windows
 * cursor the game sets (the page draws it); in a battle the mouse is
 * captured (WWMouseClass's +0x10 byte) and the game draws its own. */
#define RA2_MOUSE_VA 0x00B78164u   /* the mouse object (WWMouseClass), set by its constructor */
static int menus_use_windows_cursor(void) {
    uint32_t mouse = MEM32(RA2_MOUSE_VA);
    int game_draws_cursor = mouse && MEM8(mouse + 0x10);
    return !game_draws_cursor;
}

/* RA2MD.INI's [sec] key=val, the key added at the end of its section (the
 * section at the file's end if none), the file's last line ended (the game
 * drops a last line with no line break). keep: an existing value stays. */
static void ini_put(const char *sec, const char *key, const char *val, int keep) {
    char path[PATH_MAX], head[64];
    hle_host_path_for_write(RA2_INI_NAME, path, sizeof path, 1);
    snprintf(head, sizeof head, "[%s]", sec);
    size_t hl = strlen(head), kl = strlen(key);
    FILE *f = fopen(path, "rb");
    char *in = NULL;
    long n = 0;
    if (f) {
        fseek(f, 0, SEEK_END), n = ftell(f), rewind(f);
        in = (char *)malloc(n > 0 ? (size_t)n + 1 : 1);
        n = in ? (long)fread(in, 1, n > 0 ? (size_t)n : 0, f) : 0;
        if (in) in[n] = 0;
        fclose(f);
    }
    long at = -1, line_at = -1, line_end = -1;     /* where the section ends; the key's line */
    int in_sec = 0;
    for (long i = 0; in && i < n;) {
        long e = i;
        while (e < n && in[e] != '\n') e++;
        const char *l = in + i;
        while (*l == ' ' || *l == '\t') l++;
        if (*l == '[') {
            if (in_sec && at < 0) at = i;
            in_sec = !strncasecmp(l, head, hl);
        } else if (in_sec && !strncasecmp(l, key, kl)) {
            const char *q = l + kl;
            while (*q == ' ' || *q == '\t') q++;
            if (*q == '=') line_at = i, line_end = e < n ? e + 1 : e;
        }
        i = e + 1;
    }
    if (line_at >= 0 && keep) { free(in); return; }
    if (in_sec && at < 0) at = n;                  /* the section the file's last */
    FILE *o = fopen(path, "wb");
    if (!o) { free(in); fprintf(stderr, "[host] cannot write %s\n", path); return; }
    if (line_at >= 0) {                            /* the key's line, replaced */
        fwrite(in, 1, (size_t)line_at, o);
        fprintf(o, "%s=%s\r\n", key, val);
        fwrite(in + line_end, 1, (size_t)(n - line_end), o);
    } else if (at >= 0) {
        fwrite(in, 1, (size_t)at, o);
        if (at > 0 && in[at - 1] != '\n') fputs("\r\n", o);
        fprintf(o, "%s=%s\r\n", key, val);
        fwrite(in + at, 1, (size_t)(n - at), o);
    } else {
        if (n) fwrite(in, 1, (size_t)n, o);
        if (n && in[n - 1] != '\n') fputs("\r\n", o);
        fprintf(o, "%s\r\n%s=%s\r\n", head, key, val);
    }
    fclose(o);
    free(in);
}

/* The game's own switch, [Video] AllowHiResModes: its Options screen lists
 * every mode the display offers (wasi/screen.c: the page's screen), not only
 * 640, 800 and 1024 wide. Yes when the INI has none; a player's own value
 * stays (the native host does the same: src/linux/menu.c). */
static void allow_hires(void) { ini_put("Video", "AllowHiResModes", "yes", 1); }

/* The player's name on the LAN, the page's (RA2WEB_NAME: the relay keeps the
 * names of a LAN apart): [MultiPlayer] Handle, its characters as hex bytes,
 * each followed by a comma, as the game writes it (read into 20 wide
 * characters at 0x6980C0). Letters, digits, space, '_' and '-', 16 at most. */
static void player_name(void) {
    const char *name = getenv("RA2WEB_NAME");
    char hex[16 * 3 + 1] = "";
    if (!name || !*name || strlen(name) > 16) return;
    for (const char *c = name; *c; c++) {
        if (!(isalnum((unsigned char)*c) || *c == ' ' || *c == '_' || *c == '-')) return;
        snprintf(hex + strlen(hex), 4, "%02x,", (unsigned char)*c);
    }
    ini_put("MultiPlayer", "Handle", hex, 0);
    fprintf(stderr, "[host] the player's name: %s\n", name);
}

/* This browser's PATH, as each Windows machine has its own: the game mixes
 * its every character into the session's UniqueID (0x697AD0, after
 * timeGetTime and the free disk space), and in the LAN lobby drops a packet
 * carrying its own UniqueID as its own echo (0x5E1266). The same PATH
 * everywhere (win32hle's) left the time alone to keep two players apart: two
 * pages started alike could not see each other's games. RA2WEB_MACHINE is the
 * page's id of this browser (web/online.js, ra2web.client), letters, digits
 * and '-', 64 at most; under Node, host/run.mjs's --client or a random one. */
static void machine_path(void) {
    static char path[160];
    const char *id = getenv("RA2WEB_MACHINE");
    if (!id || !*id || strlen(id) > 64) return;
    for (const char *c = id; *c; c++)
        if (!(isalnum((unsigned char)*c) || *c == '-')) return;
    snprintf(path, sizeof path, "C:\\WINDOWS\\SYSTEM32;C:\\WINDOWS;C:\\RA2WEB\\%s", id);
    hle_guest_env_path = path;
}

static uint32_t exe_stamp(const char *path) {
    uint8_t head[4096] = { 0 };
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    size_t n = fread(head, 1, sizeof head, f);
    fclose(f);
    uint32_t nt = n >= 0x40 ? *(const uint32_t *)(head + 0x3C) : 0;
    return nt && nt < sizeof head - 12 ? *(const uint32_t *)(head + nt + 8) : 0;
}

int main(int argc, char **argv) {
    const char *game = "game";
    int run = 0;
    setvbuf(stderr, NULL, _IONBF, 0);
    for (int i = 1; i < argc; i++) {
        int n = script_arg(argc, argv, i);
        if (n) { i += n - 1; continue; }
        if (!strcmp(argv[i], "--run")) run = 1;
        else if (!strcmp(argv[i], "--debuglog")) g_debuglog = 1;
        else if (!strcmp(argv[i], "--mute")) hle_dsound_set_master(0.0f);
        else if (!strcmp(argv[i], "--game") && i + 1 < argc) game = argv[++i];
        else if (!strcmp(argv[i], "--watchdog") && i + 1 < argc) g_watchdog_s = (unsigned)strtoul(argv[++i], NULL, 0);
        else if (!strcmp(argv[i], "--trace")) win32hle_trace = 1;
        else if (!strcmp(argv[i], "--exe") && i + 1 < argc) i++;   /* the folder's gamemd.exe is the one */
        else if (!strcmp(argv[i], "--dump-frames") && i + 1 < argc) g_dump_dir = argv[++i];   /* absolute: a preopened dir */
        else if (!strcmp(argv[i], "--protocol-zero") && i + 1 < argc &&
                 (!strcmp(argv[i + 1], "on") || !strcmp(argv[i + 1], "off")))
            ra2_pz_option(!strcmp(argv[++i], "on"));   /* off: the game's own timing (protocol_zero.c) */
        else {
            printf("usage: ra2.wasm [--run] [--game DIR] [--debuglog] [--mute] [--watchdog S] [--trace] [--dump-frames DIR]\n"
                   "           [--protocol-zero on|off]\n"
                   "           [--press DLG:CTRL@s] [--select DLG:CTRL=N@s] [--waitlog TEXT@s] [--move|--click x,y@s]\n"
                   "           [--key [c][s][a]+vk@s] [--wait VA@s] [--drag x1,y1,x2,y2@s]\n");
            return !strcmp(argv[i], "--help") || !strcmp(argv[i], "-h") ? 0 : 1;
        }
    }
    char game_full[PATH_MAX], exe_host[PATH_MAX + 16];
    if (!realpath(game, game_full)) { fprintf(stderr, "no game folder at %s\n", game); return 1; }
    hle_set_drive('C', game_full);
    if (!hle_host_path("C:\\" RA2_EXE_NAME, exe_host, sizeof exe_host)) {
        fprintf(stderr, "no " RA2_EXE_NAME " in %s\n", game_full);
        return 1;
    }
    uint32_t stamp = exe_stamp(exe_host);
    if (stamp != RA2_EXE_STAMP) {
        fprintf(stderr, "%s is not the build this module was lifted from (PE timestamp 0x%08X, wanted 0x%08X)\n",
                exe_host, stamp, RA2_EXE_STAMP);
        return 1;
    }

    win32hle_register(g_ra2_shims);    /* first: the game's own answers win */
    recomp_host_init();
    hle_com_register_class(CLSID_Blowfish, ra2_blowfish_create);
    printf(RA2_TITLE " (web)\n  lifted functions in dispatch: %u\n", recomp_dispatch_count);

    pe_image img;
    if (recomp_pe_map(exe_host, &img) != 0 || img.base != RA2_IMAGE_BASE) {
        fprintf(stderr, "cannot map %s at 0x%08X\n", exe_host, RA2_IMAGE_BASE);
        return 1;
    }
    hle_module_add("C:\\" RA2_EXE_NAME, img.base, img.resource_rva, img.resource_size, 1);
    int unresolved = recomp_pe_bind(&img, hle_resolve_or_stub);
    printf("  mapped %s: 0x%08X-0x%08X, %d imports not implemented yet\n", exe_host, img.base, img.base + img.span, unresolved);
    hle_set_command_line("\"C:\\" RA2_EXE_NAME "\"");

    if (!run) {
        printf("\n(dry run: image mapped and bound; --run enters 0x%08X)\n", ra2_entry_va);
        return 0;
    }
    if (chdir(game_full) != 0) { fprintf(stderr, "cannot enter %s\n", game_full); return 1; }
    allow_hires();
    player_name();
    machine_path();
    ra2web_net_start();                          /* the virtual LAN, if the page joins one (net.c) */
    hle_screen_cursor_hook = menus_use_windows_cursor;
    if (hle_screen_open(RA2_TITLE, 0, 0) != 0) return 1;
    hle_set_pump_hook(frame_pump);
    script_start();
    if (g_watchdog_s) {
        pthread_t t;
        pthread_create(&t, NULL, watchdog, NULL);
        pthread_detach(t);
    }
    printf("  entering 0x%08X\n\n", ra2_entry_va);
    fflush(stdout);
    uint32_t rc = hle_call_guest(ra2_entry_va, 0, NULL);
    printf("\nentry returned eax=%08X\n", rc);
    hle_exit((int)rc);
    return 0;
}
