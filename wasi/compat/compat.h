/*
 * compat.h - what win32hle and the RA2 host use that WASI (wasm32-wasip1-threads)
 * does not have. Force-included (-include) into every runtime and host file of
 * the WASI build, not into the generated C. Implemented in ../compat.c.
 *
 * - Threads: pthread_exit. wasi-libc has none (a thread ends by returning), so
 *   every thread starts through a setjmp that pthread_exit jumps back to
 *   (setjmp/longjmp are wasm exceptions here). New threads also get a larger
 *   shadow stack than wasi-libc's default unless they ask for one.
 * - Memory: mmap and friends, for guest_mem.c's flat memory and
 *   kernel32_ext.c's file views. A guest address is a linear-memory address;
 *   the guest owns the linear memory below the link's --global-base, and
 *   compat.c hands out ranges of it (see there).
 * - Signals: WASI has none to deliver. The names exist (-D_WASI_EMULATED_SIGNAL)
 *   and handlers are accepted and never called: a fault in wasm is a trap.
 * - Processes: popen fails (the recorder pipes to an ffmpeg there is none of).
 * - Sockets: preview1 declares only the calls on a socket already open, so
 *   socket(), bind() and the rest are declared here; net.c has them, UDP on
 *   the page's virtual LAN (off unless the page joins one: then the game sees
 *   a PC without a network). wsock32.c alone is built with RA2WEB_NET_SHIM,
 *   which sends its close, fcntl, ioctl, poll, getsockopt, send and recv to
 *   net.c too (its sockets are all net.c's; every other file's fds are
 *   preview1's own).
 */
#ifndef RA2WEB_COMPAT_H
#define RA2WEB_COMPAT_H

#ifndef _WASI_EMULATED_SIGNAL
#define _WASI_EMULATED_SIGNAL
#endif
#ifndef _WASI_EMULATED_MMAN
#define _WASI_EMULATED_MMAN
#endif
#ifndef _WASI_EMULATED_PROCESS_CLOCKS
#define _WASI_EMULATED_PROCESS_CLOCKS
#endif
#ifndef _WASI_EMULATED_GETPID
#define _WASI_EMULATED_GETPID
#endif

#include <stddef.h>
#include <stdio.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <pthread.h>

/* ---- threads */
int ra2web_pthread_create(pthread_t *__restrict, const pthread_attr_t *__restrict, void *(*)(void *), void *__restrict);
_Noreturn void ra2web_pthread_exit(void *);
#ifndef RA2WEB_COMPAT_IMPL
#define pthread_create ra2web_pthread_create
#define pthread_exit   ra2web_pthread_exit
#endif

/* ---- signals: accepted, never delivered. wasi-libc's signal.h names the
 * signals but leaves siginfo_t and sigaction out under preview1. */
#ifndef SA_SIGINFO
#define SA_SIGINFO 4
#endif
#ifndef SA_ONSTACK
#define SA_ONSTACK 0x08000000
#endif
typedef struct { void *ss_sp; int ss_flags; size_t ss_size; } stack_t;
typedef struct { int si_signo, si_errno, si_code; void *si_addr; } siginfo_t;
struct sigaction {
    union { void (*sa_handler)(int); void (*sa_sigaction)(int, siginfo_t *, void *); } ra2web_u;
    unsigned long sa_mask;
    int sa_flags;
};
#define sa_handler   ra2web_u.sa_handler
#define sa_sigaction ra2web_u.sa_sigaction
int sigaltstack(const stack_t *__restrict, stack_t *__restrict);
int sigaction(int, const struct sigaction *__restrict, struct sigaction *__restrict);

/* ---- paths: wasi-libc's realpath fails in a preopened directory. This one
 * makes the path absolute (wasi-libc keeps a current directory), folds "."
 * and "..", and checks that it exists; links are the host's to follow. */
#include <stdlib.h>
char *ra2web_realpath(const char *__restrict, char *__restrict);
#ifndef RA2WEB_COMPAT_IMPL
#define realpath ra2web_realpath
#endif

/* ---- processes: there are none to start */
FILE *popen(const char *, const char *);
int pclose(FILE *);
int execv(const char *, char *const[]);

/* ---- sockets: declared where preview1 leaves them out, and failing. The
 * flags and options preview1 does not name get Linux's numbers: nothing
 * reads them but the failing calls. */
#ifndef MSG_DONTWAIT
#define MSG_DONTWAIT 0x0040
#endif
#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0x4000
#endif
#ifndef SO_REUSEADDR
#define SO_REUSEADDR 2
#endif
#ifndef SO_ERROR
#define SO_ERROR 4
#endif
#ifndef SO_BROADCAST
#define SO_BROADCAST 6
#endif
#ifndef SO_SNDBUF
#define SO_SNDBUF 7
#endif
#ifndef SO_RCVBUF
#define SO_RCVBUF 8
#endif
int socket(int, int, int);
int connect(int, const struct sockaddr *, socklen_t);
int bind(int, const struct sockaddr *, socklen_t);
int listen(int, int);
int getsockname(int, struct sockaddr *__restrict, socklen_t *__restrict);
ssize_t sendto(int, const void *, size_t, int, const struct sockaddr *, socklen_t);
ssize_t recvfrom(int, void *__restrict, size_t, int, struct sockaddr *__restrict, socklen_t *__restrict);
int setsockopt(int, int, int, const void *, socklen_t);
int gethostname(char *, size_t);

#ifdef RA2WEB_NET_SHIM
#include <fcntl.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>
int net_close(int);
int net_fcntl(int, int, ...);
int net_ioctl(int, int, ...);
int net_poll(struct pollfd *, nfds_t, int);
int net_getsockopt(int, int, int, void *__restrict, socklen_t *__restrict);
ssize_t net_send(int, const void *, size_t, int);
ssize_t net_recv(int, void *, size_t, int);
#define close net_close
#define fcntl net_fcntl
#define ioctl net_ioctl
#define poll net_poll
#define getsockopt net_getsockopt
#define send net_send
#define recv net_recv
#endif

#endif
