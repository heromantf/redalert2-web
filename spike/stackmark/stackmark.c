/*
 * stackmark.c - how deep the native game thread's stack goes, and with what.
 *
 * Injected into the native host (DYLD_INSERT_LIBRARIES; the host is built
 * without the hardened runtime, so dyld honours it), it touches nothing of
 * the host's. Two measurements of the main thread, the thread that runs the
 * lifted game:
 *
 * - The deepest point, exactly. Before main the unused part of the stack is
 *   filled with a pattern, and a thread of ours rescans it every 200 ms. The
 *   deepest point is the deepest word *written*: a frame whose lowest locals
 *   are never stored to reads a little shallower than its stack pointer went.
 * - What makes it that deep. Every millisecond the main thread is suspended
 *   and its frame-pointer chain copied (arm64 macOS keeps frame pointers);
 *   after it is resumed each frame is classed as lifted or not by where its
 *   code is (see g_glo) and named (dladdr). Two chains are kept: the deepest
 *   ("chain") and the one with the most lifted frames ("lifted"), which is
 *   what turns into engine stack in wasm.
 *   A sample can miss a peak shorter than a millisecond, so this depth is at
 *   most the painted one; it says what the stack is made of near the peak.
 *   Names are dladdr's: the nearest exported symbol, so a frame of a static
 *   function in a library (ffmpeg's decoders) carries a neighbour's name; the
 *   library it is in is still right.
 *
 * Lines go to stderr (the playtest's run.log): "deepest" as the painted depth
 * grows (and every 5 s if it moved), "chain" as a sample goes 4 KB deeper
 * than the last one shown, "lifted" as the most lifted frames grow by 4 (or
 * their bytes by 1 KB). With STACKMARK_DIR set, both chains are also written
 * frame by frame to $STACKMARK_DIR/chain-<pid>.txt and lifted-<pid>.txt.
 *
 * Only in a process named ra2; anything else the environment reaches (the
 * playtest's ffmpeg) is left alone.
 */
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <mach-o/getsect.h>
#include <mach/mach.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define PATTERN 0x5A17C0DE5A17C0DEull
#define GUARD   (64u << 10)      /* left unpainted above the stack's bottom */
#define MARGIN  (16u << 10)      /* and below the constructor's own frame */
#define MAXF    8192             /* frames kept from one sample */
#define ADDRMASK 0x0000FFFFFFFFFFFFull  /* a saved lr without its pointer-auth bits */

static uint64_t *g_lo, *g_hi;    /* painted: [g_lo, g_hi) */
static uintptr_t g_top;          /* the stack's top (its highest address) */
static size_t g_size, g_max;
static mach_port_t g_main;

typedef struct { uint32_t address; void (*func)(void); } entry_t;
static const entry_t *g_table;
static uint32_t g_count;

static size_t deepest(void) {
    for (const volatile uint64_t *p = g_lo; p < g_hi; p++)
        if (*p != PATTERN) return g_top - (uintptr_t)p;
    return g_top - (uintptr_t)g_hi;
}

static void report(const char *when) {
    fprintf(stderr, "[stackmark] %s: main thread stack deepest %zu KB of %zu KB\n",
            when, g_max >> 10, g_size >> 10);
}

/* ---- the chain sampler */

static uintptr_t g_pc[MAXF], g_lo_b[MAXF];   /* frame k: code address, its frame's low end */
static int g_nf;
static uintptr_t g_best_sp = UINTPTR_MAX, g_shown_sp = UINTPTR_MAX;
static void **g_lifted;                      /* the dispatch table's functions, sorted */
/* The generated C's code, [g_glo, g_ghi): CMake links the generated objects
 * last, so from the lowest lifted function to the end of __text it is all
 * lifted code (and the lift's own helpers). The deepest *lifted* nesting is
 * what becomes engine stack in wasm; a library's big frame (ffmpeg's) mostly
 * does not, its arrays go to the shadow stack in linear memory. */
static uintptr_t g_glo, g_ghi;
static uintptr_t t_pc[MAXF], t_lo[MAXF];     /* this sample's chain */
static int t_nf;
static uintptr_t t_sp;
static uintptr_t b_pc[MAXF], b_lo[MAXF];     /* the sample with the most lifted bytes */
static int b_nf, b_frames, b_shown_frames;
static size_t b_bytes, b_shown_bytes;

static int cmp_ptr(const void *a, const void *b) {
    uintptr_t x = (uintptr_t)*(void *const *)a, y = (uintptr_t)*(void *const *)b;
    return x < y ? -1 : x > y;
}

/* Suspend, copy the chain, resume. Nothing that may take a lock (malloc,
 * dladdr, stdio) runs while the main thread is stopped: it may hold it. */
static int sample(void) {
    if (thread_suspend(g_main) != KERN_SUCCESS) return 0;
    arm_thread_state64_t st;
    mach_msg_type_number_t cnt = ARM_THREAD_STATE64_COUNT;
    int n = 0;
    if (thread_get_state(g_main, ARM_THREAD_STATE64, (thread_state_t)&st, &cnt) == KERN_SUCCESS) {
        uintptr_t sp = (uintptr_t)arm_thread_state64_get_sp(st);
        if (sp > g_top - g_size && sp < g_top) {
            uintptr_t fp = (uintptr_t)arm_thread_state64_get_fp(st);
            t_pc[n] = (uintptr_t)arm_thread_state64_get_pc(st) & ADDRMASK, t_lo[n] = sp, n++;
            while (n < MAXF && fp >= sp && fp + 16 <= g_top && !(fp & 7)) {
                uintptr_t next = ((uintptr_t *)fp)[0], lr = ((uintptr_t *)fp)[1] & ADDRMASK;
                t_pc[n] = lr, t_lo[n] = fp + 16, n++;    /* the caller's frame starts above this record */
                if (next <= fp) break;
                fp = next;
            }
            t_sp = sp;
        }
    }
    thread_resume(g_main);
    t_nf = n;
    return n;
}

static int is_gen(uintptr_t pc) { return pc >= g_glo && pc < g_ghi; }

/* After a sample: keep it as the deepest chain and/or as the most lifted. */
static void keep(void) {
    if (!t_nf) return;
    int deeper = t_sp < g_best_sp;
    if (deeper) {
        memcpy(g_pc, t_pc, sizeof *t_pc * t_nf), memcpy(g_lo_b, t_lo, sizeof *t_lo * t_nf);
        g_nf = t_nf, g_best_sp = t_sp;
    }
    size_t bytes = 0;
    int frames = 0;
    for (int k = 0; k < t_nf; k++)
        if (is_gen(t_pc[k])) {
            uintptr_t hi = k + 1 < t_nf ? t_lo[k + 1] : g_top;
            bytes += hi > t_lo[k] ? hi - t_lo[k] : 0, frames++;
        }
    if (frames > b_frames || (frames == b_frames && bytes > b_bytes)) {
        memcpy(b_pc, t_pc, sizeof *t_pc * t_nf), memcpy(b_lo, t_lo, sizeof *t_lo * t_nf);
        b_nf = t_nf, b_frames = frames, b_bytes = bytes;
    }
}

static void show_chain(const char *label, const uintptr_t *pcs, const uintptr_t *los, int nf, uintptr_t sp) {
    size_t lifted_b = 0, other_b = 0;
    int lifted_n = 0;
    struct { const char *name; size_t bytes; int n; } top[64];
    int ntop = 0;
    FILE *f = NULL;
    const char *dir = getenv("STACKMARK_DIR");
    char path[1024];
    if (dir) snprintf(path, sizeof path, "%s/%s-%d.txt", dir, label, (int)getpid()), f = fopen(path, "w");
    for (int k = 0; k < nf; k++) {
        uintptr_t hi = k + 1 < nf ? los[k + 1] : g_top;
        size_t bytes = hi > los[k] ? hi - los[k] : 0;
        Dl_info di;
        const char *nm = "?", *lib = "";
        int lifted = 0;
        if (pcs[k] < 0x100000000ull) nm = "(stack top: the environment, arguments, dyld)";   /* the chain's end: lr 0 */
        else if (dladdr((void *)(k ? pcs[k] - 1 : pcs[k]), &di)) {
            if (di.dli_sname) nm = di.dli_sname, lifted = is_gen(pcs[k]);
            if (di.dli_fname) lib = strrchr(di.dli_fname, '/') ? strrchr(di.dli_fname, '/') + 1 : di.dli_fname;
        }
        if (lifted) lifted_b += bytes, lifted_n++; else other_b += bytes;
        if (f) fprintf(f, "%6zu %c %-40s %s\n", bytes, lifted ? 'L' : '-', nm, lib);
        int i = 0;
        while (i < ntop && strcmp(top[i].name, nm)) i++;
        if (i == ntop && ntop < 64) top[ntop].name = nm, top[ntop].bytes = 0, top[ntop].n = 0, ntop++;
        if (i < ntop) top[i].bytes += bytes, top[i].n++;
    }
    if (f) fclose(f);
    for (int a = 0; a < ntop; a++)                       /* the five largest by bytes */
        for (int b = a + 1; b < ntop; b++)
            if (top[b].bytes > top[a].bytes) { __typeof__(top[0]) t = top[a]; top[a] = top[b]; top[b] = t; }
    fprintf(stderr, "[stackmark] %s: %zu KB in %d frames: lifted %d frames %zu KB, other %zu KB; largest:",
            label, (g_top - sp) >> 10, nf, lifted_n, lifted_b >> 10, other_b >> 10);
    for (int a = 0; a < ntop && a < 5; a++) fprintf(stderr, " %s %zu B x%d,", top[a].name, top[a].bytes, top[a].n);
    fprintf(stderr, "\n");
}

static void load_table(void) {
    g_table = (const entry_t *)dlsym(RTLD_DEFAULT, "recomp_dispatch_table");
    const uint32_t *cnt = (const uint32_t *)dlsym(RTLD_DEFAULT, "recomp_dispatch_count");
    if (!g_table || !cnt) { fprintf(stderr, "[stackmark] no recomp_dispatch_table: frames not classed\n"); return; }
    g_count = *cnt;
    g_lifted = malloc(sizeof *g_lifted * g_count);
    for (uint32_t i = 0; i < g_count; i++) g_lifted[i] = (void *)g_table[i].func;
    qsort(g_lifted, g_count, sizeof *g_lifted, cmp_ptr);
    unsigned long sz = 0;
    uint8_t *text = getsectiondata((const struct mach_header_64 *)_dyld_get_image_header(0), "__TEXT", "__text", &sz);
    g_glo = (uintptr_t)g_lifted[0], g_ghi = (uintptr_t)text + sz;
    void *rt = dlsym(RTLD_DEFAULT, "hle_call_guest");
    fprintf(stderr, "[stackmark] lifted code %p..%p (%lu KB); the runtime's hle_call_guest at %p is %s\n",
            (void *)g_glo, (void *)g_ghi, (unsigned long)((g_ghi - g_glo) >> 10), rt, is_gen((uintptr_t)rt) ? "INSIDE: classes wrong" : "outside");
}

/* The host leaves through _exit at its watchdog, so the atexit report may
 * never come: the exact painted depth is printed again every 5 s if it moved
 * at all, and the last line in a log is right to within those 5 s. */
static void *watch(void *arg) {
    (void)arg;
    load_table();
    size_t shown = g_max;
    for (int tick = 1;; tick++) {
        for (int i = 0; i < 200; i++) {                  /* 200 samples a tick, one a millisecond */
            if (sample()) keep();
            if (g_shown_sp - g_best_sp >= (4u << 10) && g_best_sp != UINTPTR_MAX)
                g_shown_sp = g_best_sp, show_chain("chain", g_pc, g_lo_b, g_nf, g_best_sp);
            if (b_frames >= b_shown_frames + 4 || b_bytes >= b_shown_bytes + 1024)
                b_shown_frames = b_frames, b_shown_bytes = b_bytes, show_chain("lifted", b_pc, b_lo, b_nf, b_lo[0]);
            usleep(1000);
        }
        size_t d = deepest();
        if (d > g_max) g_max = d;
        if (g_max >= shown + (16u << 10) || (tick % 25 == 0 && g_max != shown)) shown = g_max, report("deepest");
    }
    return NULL;
}

static void at_exit(void) {
    size_t d = deepest();
    if (d > g_max) g_max = d;
    report("exit");
}

__attribute__((constructor)) static void stackmark_init(void) {
    if (strcmp(getprogname(), "ra2") != 0) return;
    pthread_t self = pthread_self();
    g_main = mach_thread_self();
    g_top  = (uintptr_t)pthread_get_stackaddr_np(self);
    g_size = pthread_get_stacksize_np(self);
    uintptr_t here = (uintptr_t)__builtin_frame_address(0);
    g_lo = (uint64_t *)((g_top - g_size + GUARD + 7) & ~(uintptr_t)7);
    g_hi = (uint64_t *)((here - MARGIN) & ~(uintptr_t)7);
    for (uint64_t *p = g_lo; p < g_hi; p++) *p = PATTERN;
    g_max = g_top - here;
    report("start");
    atexit(at_exit);
    pthread_t t;
    pthread_create(&t, NULL, watch, NULL);
    pthread_detach(t);
}
