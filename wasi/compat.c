/*
 * compat.c - the POSIX that win32hle and the RA2 host use and WASI lacks, for
 * the WASI build (compat/compat.h says what and why).
 *
 * The memory map. A guest address is a linear-memory address (flat, as on a
 * 32-bit host), and the guest owns the linear memory below __global_base, the
 * link's --global-base: the C runtime's data, stacks and malloc heap all sit
 * above it. mmap hands out ranges of [GUEST_LO, __global_base):
 *   - at a fixed address (MAP_FIXED_NOREPLACE: the PE image at 0x00400000), or
 *   - anywhere at or above ANY_LO (thread stacks, VirtualAlloc, file views),
 * in 64 KB units, Windows' allocation granularity. Nothing is ever
 * inaccessible (wasm has no protection): mprotect succeeds and does nothing,
 * and a guest NULL reads what is at linear address 0 instead of faulting.
 * A file view is the file read into its range; a writable shared one is
 * written back when it is unmapped.
 */
#define RA2WEB_COMPAT_IMPL
#include "compat/compat.h"
#include <errno.h>
#include <ifaddrs.h>
#include <netdb.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

/* ================================================================ threads */

#define THREAD_STACK (1u << 20)   /* a new thread's shadow stack unless it asks: wasi-libc's default is 128 KB */

typedef struct { void *(*fn)(void *); void *arg; } start_t;
static __thread jmp_buf *t_exit;
static __thread void *t_ret;

static void *trampoline(void *p) {
    start_t s = *(start_t *)p;
    free(p);
    jmp_buf jb;
    t_exit = &jb;
    if (setjmp(jb)) return t_ret;                  /* pthread_exit */
    return s.fn(s.arg);
}

int ra2web_pthread_create(pthread_t *__restrict t, const pthread_attr_t *__restrict attr,
                          void *(*fn)(void *), void *__restrict arg) {
    start_t *s = (start_t *)malloc(sizeof *s);
    if (!s) return EAGAIN;
    s->fn = fn, s->arg = arg;
    pthread_attr_t a;
    if (!attr) pthread_attr_init(&a), pthread_attr_setstacksize(&a, THREAD_STACK);
    int r = pthread_create(t, attr ? attr : &a, trampoline, s);
    if (!attr) pthread_attr_destroy(&a);
    if (r) free(s);
    return r;
}

_Noreturn void ra2web_pthread_exit(void *v) {
    if (t_exit) { t_ret = v; longjmp(*t_exit, 1); }
    exit(0);                                        /* the main thread: nothing to return to */
}

/* ============================================================ the memory map */

#define GUEST_LO   0x00010000u
#define ANY_LO     0x10000000u   /* "anywhere" starts above the images */
#define GRAN       0x10000u
#define MAX_RANGES 8192
#ifndef MAP_FIXED_NOREPLACE
#define MAP_FIXED_NOREPLACE 0x100000   /* guest_mem.c's fallback value: WASI does not name it */
#endif

extern unsigned char __global_base;
static pthread_mutex_t g_map = PTHREAD_MUTEX_INITIALIZER;
static struct { uint32_t lo, hi; } g_rng[MAX_RANGES];   /* reserved, sorted by lo */
static int g_nrng;
#define MAX_VIEWS 64
static struct { uint32_t lo, len; int fd; off_t off; } g_view[MAX_VIEWS];   /* writable shared file views */

static uint32_t guest_hi(void) { return (uint32_t)(uintptr_t)&__global_base & ~(GRAN - 1); }
static uint32_t up(uint32_t n) { return (n + GRAN - 1) & ~(GRAN - 1); }

static int overlaps(uint32_t lo, uint32_t hi) {
    for (int i = 0; i < g_nrng; i++)
        if (lo < g_rng[i].hi && hi > g_rng[i].lo) return 1;
    return 0;
}
static int add_range(uint32_t lo, uint32_t hi) {
    if (g_nrng >= MAX_RANGES) return -1;
    int i = g_nrng;
    while (i > 0 && g_rng[i - 1].lo > lo) { g_rng[i] = g_rng[i - 1]; i--; }
    g_rng[i].lo = lo, g_rng[i].hi = hi;
    g_nrng++;
    return 0;
}
static uint32_t find_gap(uint32_t size) {
    uint32_t at = ANY_LO, top = guest_hi();
    for (int i = 0; i < g_nrng; i++) {
        if (g_rng[i].hi <= at) continue;
        if (g_rng[i].lo >= at + size) break;
        at = up(g_rng[i].hi);
    }
    return at + size <= top && at + size > at ? at : 0;
}
static int read_file(int fd, uint8_t *p, size_t len, off_t off) {
    size_t got = 0;
    while (got < len) {
        ssize_t n = pread(fd, p + got, len - got, off + (off_t)got);
        if (n < 0) return -1;
        if (n == 0) break;
        got += (size_t)n;
    }
    memset(p + got, 0, len - got);                 /* past the end of the file: zeros, as a mapping reads */
    return 0;
}

void *mmap(void *addr, size_t len, int prot, int flags, int fd, off_t off) {
    uint32_t lo = (uint32_t)(uintptr_t)addr, n = up((uint32_t)len), top = guest_hi();
    if (!len || len > 0xFFFFFFFFu) { errno = EINVAL; return MAP_FAILED; }
    pthread_mutex_lock(&g_map);
    if (flags & (MAP_FIXED | MAP_FIXED_NOREPLACE)) {
        if (lo < GUEST_LO || lo + n > top || lo + n < lo) { pthread_mutex_unlock(&g_map); errno = ENOMEM; return MAP_FAILED; }
        if (overlaps(lo, lo + n)) {
            if (flags & MAP_FIXED_NOREPLACE) { pthread_mutex_unlock(&g_map); errno = EEXIST; return MAP_FAILED; }
            /* MAP_FIXED over a reservation: a file view put over its own range */
        } else if (add_range(lo, lo + n) != 0) { pthread_mutex_unlock(&g_map); errno = ENOMEM; return MAP_FAILED; }
    } else {
        lo = find_gap(n);
        if (!lo || add_range(lo, lo + n) != 0) { pthread_mutex_unlock(&g_map); errno = ENOMEM; return MAP_FAILED; }
    }
    if (fd >= 0 && (flags & MAP_SHARED) && (prot & PROT_WRITE)) {
        int i = 0;
        while (i < MAX_VIEWS && g_view[i].len) i++;
        if (i < MAX_VIEWS) g_view[i].lo = lo, g_view[i].len = (uint32_t)len, g_view[i].fd = dup(fd), g_view[i].off = off;
    }
    pthread_mutex_unlock(&g_map);
    uint8_t *p = (uint8_t *)(uintptr_t)lo;
    if (fd >= 0) {
        if (read_file(fd, p, len, off) != 0) return MAP_FAILED;
    } else {
        memset(p, 0, n);
    }
    return p;
}

int munmap(void *addr, size_t len) {
    uint32_t lo = (uint32_t)(uintptr_t)addr, hi = lo + up((uint32_t)len);
    pthread_mutex_lock(&g_map);
    for (int i = 0; i < MAX_VIEWS; i++)
        if (g_view[i].len && g_view[i].lo >= lo && g_view[i].lo < hi) {
            const uint8_t *p = (const uint8_t *)(uintptr_t)g_view[i].lo;
            size_t done = 0;
            while (done < g_view[i].len) {
                ssize_t w = pwrite(g_view[i].fd, p + done, g_view[i].len - done, g_view[i].off + (off_t)done);
                if (w <= 0) break;
                done += (size_t)w;
            }
            close(g_view[i].fd);
            g_view[i].len = 0;
        }
    int j = 0;
    for (int i = 0; i < g_nrng; i++)
        if (!(g_rng[i].lo >= lo && g_rng[i].hi <= hi)) g_rng[j++] = g_rng[i];
    g_nrng = j;
    pthread_mutex_unlock(&g_map);
    return 0;
}

int madvise(void *addr, size_t len, int advice) {
    if (advice == MADV_DONTNEED) memset(addr, 0, len);   /* decommitted pages read as zero again */
    return 0;
}
int mprotect(void *addr, size_t len, int prot) { (void)addr, (void)len, (void)prot; return 0; }
int msync(void *addr, size_t len, int flags) { (void)addr, (void)len, (void)flags; return 0; }

/* ================================================================ signals */

int sigaction(int sig, const struct sigaction *__restrict sa, struct sigaction *__restrict old) {
    (void)sig, (void)sa;
    if (old) memset(old, 0, sizeof *old);
    return 0;
}
int sigaltstack(const stack_t *__restrict ss, stack_t *__restrict old) {
    (void)ss;
    if (old) memset(old, 0, sizeof *old);
    return 0;
}

/* ================================================================== paths */

char *ra2web_realpath(const char *__restrict path, char *__restrict resolved) {
    char abs[PATH_MAX], out[PATH_MAX];
    if (!path || !*path) { errno = ENOENT; return NULL; }
    if (path[0] == '/') snprintf(abs, sizeof abs, "%s", path);
    else {
        char cwd[PATH_MAX];
        if (!getcwd(cwd, sizeof cwd)) return NULL;
        snprintf(abs, sizeof abs, "%s/%s", cwd, path);
    }
    size_t o = 0;                                   /* out: "/a/b", no trailing slash */
    for (char *s = abs, *e; *s; s = e) {
        while (*s == '/') s++;
        for (e = s; *e && *e != '/'; e++) {}
        size_t n = (size_t)(e - s);
        if (!n || (n == 1 && s[0] == '.')) continue;
        if (n == 2 && s[0] == '.' && s[1] == '.') { while (o > 0 && out[--o] != '/') {} continue; }
        if (o + 1 + n >= sizeof out) { errno = ENAMETOOLONG; return NULL; }
        out[o++] = '/', memcpy(out + o, s, n), o += n;
    }
    if (!o) out[o++] = '/';
    out[o] = 0;
    struct stat st;
    if (stat(out, &st) != 0) return NULL;
    if (!resolved && !(resolved = (char *)malloc(PATH_MAX))) { errno = ENOMEM; return NULL; }
    memcpy(resolved, out, o + 1);
    return resolved;
}

/* ============================================================== processes */

FILE *popen(const char *cmd, const char *mode) { (void)cmd, (void)mode; errno = ENOSYS; return NULL; }
int pclose(FILE *f) { (void)f; errno = ECHILD; return -1; }
int execv(const char *path, char *const argv[]) { (void)path, (void)argv; errno = ENOSYS; return -1; }

/* ================================================================ sockets */

/* The sockets and the name lookups are the virtual LAN's: net.c. */
