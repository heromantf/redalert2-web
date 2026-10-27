/*
 * net.c - the game's sockets on the page's virtual LAN.
 *
 * win32hle's wsock32.c turns the game's IPX into UDP, as IPXEmu does (an IPX
 * socket number is the port, the node's first four bytes the IPv4 address),
 * on BSD sockets. A page has none, so here they are this file's: UDP sockets
 * on a virtual LAN, 10.47.0.0/16, that the page's network worker carries to
 * the relay (relay/main.go) and back over a WebSocket, between every page of a
 * LAN. Only what the game's LAN play needs: UDP (no TCP), one address.
 *
 *   game -> wsock32.c -> sendto (here) -> TX ring -> network worker -> relay -> the other pages
 *   game <- wsock32.c <- recvfrom (here) <- a socket's queue <- RX ring <- network worker <- relay
 *
 * The rings are a mailbox in shared memory (net_mailbox_t), registered with
 * the page as kind 4 (host/core/net.mjs reads the same layout). The TX ring is
 * ours to fill and the worker's to empty; it waits on tx_bell. The RX ring the
 * worker fills, and every call here first moves what came into the queue of
 * the socket bound to its port (pump): the game polls its socket from the
 * message pump (wsock32.c hle_ws_poll), so what arrives is seen within a
 * frame, and a game that pumps no messages for a while (loading a map) leaves
 * it all in the ring meanwhile.
 *
 * How much waits, a Windows host's rule: a socket holds SO_RCVBUF bytes of
 * datagrams (what the game sets, 128 KB: gamemd 0x7B2630, 0x84DDA0, as
 * Westwood's RA1 code; IPXEmu hands it to the UDP socket; Winsock's 8 KB until
 * set), the earliest; one that does not fit is lost, counted. The RX ring is
 * only the way in: records of their own length, NET_RX_BYTES of them, more
 * than the sockets hold, so that what the sockets would keep the ring keeps
 * too. With no socket bound (the game not yet in its Network menu) the worker
 * keeps nothing (rx_open), as no one would on Windows; a socket bound starts
 * empty.
 *
 * The rules, a Windows host's as the game expects them:
 * - sendto never fails. The game keeps a datagram whose sendto failed at the
 *   head of its queue and sends it first ever after (gamemd 0x7B13D0): one
 *   failure would hold up everything. With the link down, a full TX ring or a
 *   datagram too long, the datagram is lost, as on a LAN, and sendto says it
 *   went.
 * - recvfrom with nothing queued: EWOULDBLOCK (WSAEWOULDBLOCK, which the game
 *   takes for "nothing yet"), never anything else.
 * - A broadcast (255.255.255.255, 10.47.255.255) goes to the relay, which
 *   hands it to every page of the LAN, this one too: Windows gives a host its
 *   own broadcasts back. A datagram to our own address or 127/8 stays here.
 * - Binding a port another socket holds needs SO_REUSEADDR on both; port 0
 *   or an unbound socket's first send takes one of 49152-65534.
 * The calls are wsock32.c's, made with the guest lock held; a mutex keeps the
 * sockets anyway. Sockets are numbers from NET_FD_BASE on (wsock32.c takes
 * any below 0x10000); close, fcntl, ioctl and poll on them reach here through
 * compat.h's RA2WEB_NET_SHIM, which only wsock32.c is built with.
 *
 * Off unless the page joins a LAN (RA2WEB_NET in the environment, the page's
 * when a relay is set): then socket() fails as before, and the game says the
 * PC has no network.
 */
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

#define RA2WEB_IMPORT(name) __attribute__((import_module("ra2web"), import_name(name)))
RA2WEB_IMPORT("register") void ra2web_register(int kind, const void *ptr, int size);
enum { RA2WEB_NET = 4 };

/* ---- the mailbox (web/net.js and host/core/net.mjs: the same numbers) ---- */
#define NET_MAGIC      0x31544E52u     /* "RNT1" */
#define NET_TX_SLOTS   64u
#define NET_RX_BYTES   (512u << 10)   /* the RX ring, records: four times the game's socket's 128 KB, its headers too */
#define NET_SLOT_BYTES 1536u           /* a TX slot */
#define NET_SLOT_HDR   12u             /* u16 length, u16 flags (RX: 1 sent as a broadcast), u32 peer (host order), u16 source port, u16 destination port */
#define NET_RX_WRAP    0xFFFFu         /* an RX record's length: the rest of the ring unused, the next record at its start */
#define NET_MAX_DATA   1472u           /* an Ethernet frame's UDP payload; the game sends at most ~580 */
typedef struct {
    uint32_t magic, version;           /* 0, 1 */
    uint32_t tx_slots, rx_bytes;       /* 2, 3: the TX ring's slots, the RX ring's bytes */
    uint32_t slot_bytes;               /* 4 */
    uint32_t link;                     /* 5, the worker's: 1 joined, 0 not (connecting, dropped, refused) */
    uint32_t ip;                       /* 6, the worker's: our address, host order (0 until joined) */
    uint32_t tx_head;                  /* 7, ours */
    uint32_t tx_tail;                  /* 8, the worker's */
    uint32_t rx_head;                  /* 9, the worker's */
    uint32_t rx_tail;                  /* 10, ours */
    uint32_t tx_bell;                  /* 11, ours: bumped and notified after a datagram is queued */
    uint32_t tx_lost;                  /* 12, ours: datagrams lost to a full TX ring or the link down */
    uint32_t rx_lost;                  /* 13, the worker's: lost to a full RX ring */
    uint32_t rx_lost_own;              /* 14, the worker's: of those, sent to this page alone (not broadcast) */
    uint32_t sock_lost, sock_lost_own; /* 15, 16, ours: lost to a socket's full queue, and of those to this page alone */
    uint32_t rx_peak, sock_peak;       /* 17, 18, ours: the most bytes found in the RX ring at once, and at a socket */
    uint32_t rx_open;                  /* 19, ours: sockets bound (0: the worker keeps nothing) */
    uint32_t rx_closed;                /* 20, the worker's: datagrams that came with no socket bound */
    uint32_t game_count;               /* 21, ours: a LAN game's main loop rounds (it changes: a game runs) */
    uint32_t game_rsp;                 /* 22, ours: IPX's response time in the game, 16 ms ticks */
    uint32_t game_level;               /* 23, ours: Protocol Zero's latency level (0: none yet, or off) */
    uint32_t pad[40];                  /* to 256 bytes */
} net_hdr_t;
typedef struct {
    net_hdr_t h;
    uint8_t tx[NET_TX_SLOTS][NET_SLOT_BYTES];
    uint8_t rx[NET_RX_BYTES];          /* records: NET_SLOT_HDR, the payload, to a multiple of 4; none wraps */
} net_mailbox_t;
_Static_assert(sizeof(net_hdr_t) == 256, "net_hdr_t is 256 bytes");
_Static_assert((NET_RX_BYTES & (NET_RX_BYTES - 1)) == 0, "the RX ring's byte counts wrap at 2^32");

#define NET_BROADCAST  0x0A2FFFFFu     /* 10.47.255.255 */
#define NET_FD_BASE    0x7000
#define NET_SOCKETS    16
#define NET_RCVBUF     8192            /* Winsock's SO_RCVBUF and SO_SNDBUF until set */
#define NET_RCVBUF_MAX (8 << 20)
#define EPHEMERAL_LO   49152
#define EPHEMERAL_HI   65534

typedef struct pkt { struct pkt *next; uint16_t len, port; uint32_t from; uint8_t data[]; } pkt_t;
typedef struct {
    int used, port, reuse, nonblock, rcvbuf, sndbuf;
    pkt_t *first, *last;               /* the queue, the oldest first */
    uint32_t bytes;                    /* its payloads' */
} vsock_t;

static net_mailbox_t *g_mb;
static vsock_t g_sock[NET_SOCKETS];
static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;
static int g_next_port = EPHEMERAL_LO;

static int enabled(void) { return g_mb != NULL; }
static vsock_t *vs(int fd) {
    int i = fd - NET_FD_BASE;
    return i >= 0 && i < NET_SOCKETS && g_sock[i].used ? &g_sock[i] : NULL;
}
static uint32_t own_ip(void) { return g_mb ? __atomic_load_n(&g_mb->h.ip, __ATOMIC_ACQUIRE) : 0; }

/* the page's worker starts once this is registered (main.c, at start) */
void ra2web_net_start(void) {
    if (g_mb || !getenv("RA2WEB_NET")) return;
    g_mb = (net_mailbox_t *)calloc(1, sizeof *g_mb);
    if (!g_mb) return;
    g_mb->h.magic = NET_MAGIC, g_mb->h.version = 3;
    g_mb->h.tx_slots = NET_TX_SLOTS, g_mb->h.rx_bytes = NET_RX_BYTES, g_mb->h.slot_bytes = NET_SLOT_BYTES;
    ra2web_register(RA2WEB_NET, g_mb, (int)sizeof *g_mb);
    fprintf(stderr, "[net] the virtual LAN's mailbox: %u bytes\n", (unsigned)sizeof *g_mb);
}

static void queue_to(vsock_t *s, uint32_t from, uint16_t sport, const uint8_t *data, uint32_t len, int bcast) {
    pkt_t *p = s->bytes + len <= (uint32_t)s->rcvbuf ? (pkt_t *)malloc(sizeof *p + len) : NULL;
    if (!p) {                                            /* no room: lost, as past a socket's SO_RCVBUF */
        if (g_mb) g_mb->h.sock_lost++, g_mb->h.sock_lost_own += !bcast;
        return;
    }
    p->next = NULL, p->len = (uint16_t)len, p->port = sport, p->from = from;
    memcpy(p->data, data, len);
    if (s->last) s->last->next = p; else s->first = p;
    s->last = p, s->bytes += len;
    if (g_mb && s->bytes > g_mb->h.sock_peak) g_mb->h.sock_peak = s->bytes;
}
static void queue_free(vsock_t *s) {
    for (pkt_t *p = s->first, *n; p; p = n) n = p->next, free(p);
    s->first = s->last = NULL, s->bytes = 0;
}
/* the worker keeps datagrams only while a socket is bound */
static void open_count(void) {
    int n = 0;
    for (int i = 0; i < NET_SOCKETS; i++) n += g_sock[i].used && g_sock[i].port;
    if (g_mb) __atomic_store_n(&g_mb->h.rx_open, (uint32_t)n, __ATOMIC_RELEASE);
}
/* a datagram to a port here: every socket bound to it (more than one only with SO_REUSEADDR) */
static void deliver(uint32_t from, uint16_t sport, uint16_t dport, const uint8_t *data, uint32_t len, int bcast) {
    for (int i = 0; i < NET_SOCKETS; i++)
        if (g_sock[i].used && g_sock[i].port == dport) queue_to(&g_sock[i], from, sport, data, len, bcast);
}
static uint32_t g_rx_count;               /* datagrams taken from the RX ring */
/* A LAN game's round of the main loop, and its latency as the game measures it (protocol_zero.c):
 * for the page to show (host/core/net.mjs, the status' game) */
void ra2web_net_game(int sample, uint32_t rsp_ticks, uint32_t level) {
    if (!g_mb) return;
    if (sample) {
        __atomic_store_n(&g_mb->h.game_rsp, rsp_ticks, __ATOMIC_RELAXED);
        __atomic_store_n(&g_mb->h.game_level, level, __ATOMIC_RELAXED);
    }
    __atomic_fetch_add(&g_mb->h.game_count, 1, __ATOMIC_RELEASE);
}
/* The datagrams the game has sent and been sent so far (protocol_zero.c's log of the network) */
void ra2web_net_counts(uint32_t *out, uint32_t *in) {
    *out = g_mb ? __atomic_load_n(&g_mb->h.tx_head, __ATOMIC_RELAXED) : 0;
    *in = __atomic_load_n(&g_rx_count, __ATOMIC_RELAXED);
}
/* what the worker put in the RX ring, into the sockets' queues */
static void pump(void) {
    if (!g_mb) return;
    uint32_t head = __atomic_load_n(&g_mb->h.rx_head, __ATOMIC_ACQUIRE), tail = g_mb->h.rx_tail;
    if (head - tail > g_mb->h.rx_peak) g_mb->h.rx_peak = head - tail;
    while (tail != head) {                               /* byte counts, wrapping at 2^32: NET_RX_BYTES divides it */
        uint32_t at = tail % NET_RX_BYTES;
        const uint8_t *r = g_mb->rx + at;
        uint16_t len, flags, sport, dport;
        uint32_t from;
        memcpy(&len, r, 2);
        if (len == NET_RX_WRAP) { tail += NET_RX_BYTES - at; continue; }
        memcpy(&flags, r + 2, 2), memcpy(&from, r + 4, 4), memcpy(&sport, r + 8, 2), memcpy(&dport, r + 10, 2);
        if (len <= NET_MAX_DATA) deliver(from, sport, dport, r + NET_SLOT_HDR, len, flags & 1);
        __atomic_fetch_add(&g_rx_count, 1, __ATOMIC_RELAXED);
        tail += (NET_SLOT_HDR + len + 3u) & ~3u;
    }
    __atomic_store_n(&g_mb->h.rx_tail, tail, __ATOMIC_RELEASE);
}
static int port_free(int port, int reuse) {
    for (int i = 0; i < NET_SOCKETS; i++)
        if (g_sock[i].used && g_sock[i].port == port && !(reuse && g_sock[i].reuse)) return 0;
    return 1;
}
static int ephemeral(void) {
    for (int n = 0; n < EPHEMERAL_HI - EPHEMERAL_LO; n++) {
        int p = g_next_port++;
        if (g_next_port > EPHEMERAL_HI) g_next_port = EPHEMERAL_LO;
        if (port_free(p, 0)) return p;
    }
    return 0;
}

/* ---- the BSD calls wsock32.c makes ---- */

int socket(int domain, int type, int proto) {
    if (!enabled() || domain != AF_INET || (type & 0xF) != SOCK_DGRAM || (proto && proto != IPPROTO_UDP)) {
        errno = EAFNOSUPPORT;
        return -1;
    }
    pthread_mutex_lock(&g_mu);
    int fd = -1;
    for (int i = 0; i < NET_SOCKETS && fd < 0; i++)
        if (!g_sock[i].used) {
            g_sock[i] = (vsock_t){ .used = 1, .rcvbuf = NET_RCVBUF, .sndbuf = NET_RCVBUF };
            fd = NET_FD_BASE + i;
        }
    pthread_mutex_unlock(&g_mu);
    if (fd < 0) errno = EMFILE;
    return fd;
}
int net_close(int fd) {
    pthread_mutex_lock(&g_mu);
    vsock_t *s = vs(fd);
    if (s) queue_free(s), memset(s, 0, sizeof *s), open_count();
    pthread_mutex_unlock(&g_mu);
    if (!s) { errno = EBADF; return -1; }
    return 0;
}
int bind(int fd, const struct sockaddr *a, socklen_t n) {
    const struct sockaddr_in *in = (const struct sockaddr_in *)a;
    pthread_mutex_lock(&g_mu);
    vsock_t *s = vs(fd);
    int r = -1;
    if (!s || n < (socklen_t)sizeof *in) errno = s ? EINVAL : EBADF;
    else if (s->port) errno = EINVAL;
    else {
        int port = ntohs(in->sin_port);
        if (!port) port = ephemeral();
        if (!port || !port_free(port, s->reuse)) errno = EADDRINUSE;
        else pump(), s->port = port, open_count(), r = 0;   /* what came before is no one's: it starts empty */
    }
    pthread_mutex_unlock(&g_mu);
    return r;
}
int connect(int fd, const struct sockaddr *a, socklen_t n) { (void)a, (void)n; errno = vs(fd) ? EOPNOTSUPP : EBADF; return -1; }
int listen(int fd, int backlog) { (void)backlog; errno = vs(fd) ? EOPNOTSUPP : EBADF; return -1; }
int getsockname(int fd, struct sockaddr *__restrict a, socklen_t *__restrict n) {
    pthread_mutex_lock(&g_mu);
    vsock_t *s = vs(fd);
    int port = s ? s->port : 0;
    pthread_mutex_unlock(&g_mu);
    if (!s) { errno = EBADF; return -1; }
    struct sockaddr_in in = { .sin_family = AF_INET, .sin_port = htons((uint16_t)port) };   /* bound to any address, as Windows says */
    if (n && *n >= (socklen_t)sizeof in) memcpy(a, &in, sizeof in), *n = sizeof in;
    return 0;
}
ssize_t sendto(int fd, const void *buf, size_t len, int flags, const struct sockaddr *to, socklen_t n) {
    (void)flags;
    const struct sockaddr_in *in = (const struct sockaddr_in *)to;
    pthread_mutex_lock(&g_mu);
    vsock_t *s = vs(fd);
    if (!s || !in || n < (socklen_t)sizeof *in) {
        pthread_mutex_unlock(&g_mu);
        errno = s ? EDESTADDRREQ : EBADF;
        return -1;
    }
    if (!s->port) pump(), s->port = ephemeral(), open_count();
    uint32_t dst = ntohl(in->sin_addr.s_addr), me = own_ip();
    uint16_t dport = ntohs(in->sin_port);
    if (len <= NET_MAX_DATA) {
        if ((dst >> 24) == 127 || (me && dst == me)) deliver(me ? me : 0x7F000001u, (uint16_t)s->port, dport, buf, (uint32_t)len, 0);
        else if (__atomic_load_n(&g_mb->h.link, __ATOMIC_ACQUIRE)) {
            uint32_t head = g_mb->h.tx_head, tail = __atomic_load_n(&g_mb->h.tx_tail, __ATOMIC_ACQUIRE);
            if (head - tail < NET_TX_SLOTS) {
                uint8_t *slot = g_mb->tx[head % NET_TX_SLOTS];
                uint16_t l = (uint16_t)len, zero = 0, sport = (uint16_t)s->port;
                memcpy(slot, &l, 2), memcpy(slot + 2, &zero, 2), memcpy(slot + 4, &dst, 4);
                memcpy(slot + 8, &sport, 2), memcpy(slot + 10, &dport, 2), memcpy(slot + NET_SLOT_HDR, buf, len);
                __atomic_store_n(&g_mb->h.tx_head, head + 1, __ATOMIC_RELEASE);
                __atomic_fetch_add(&g_mb->h.tx_bell, 1, __ATOMIC_RELEASE);
                __builtin_wasm_memory_atomic_notify((int *)&g_mb->h.tx_bell, 1);
            } else g_mb->h.tx_lost++;
        } else g_mb->h.tx_lost++;
    }
    pthread_mutex_unlock(&g_mu);
    return (ssize_t)len;                                  /* went, as far as the game knows */
}
ssize_t recvfrom(int fd, void *__restrict buf, size_t len, int flags, struct sockaddr *__restrict from, socklen_t *__restrict n) {
    (void)flags;
    pthread_mutex_lock(&g_mu);
    vsock_t *s = vs(fd);
    if (!s) { pthread_mutex_unlock(&g_mu); errno = EBADF; return -1; }
    pump();
    if (!s->first) { pthread_mutex_unlock(&g_mu); errno = EWOULDBLOCK; return -1; }
    pkt_t *d = s->first;
    size_t take = d->len < len ? d->len : len;           /* the rest of a long one is lost, as UDP's is */
    memcpy(buf, d->data, take);
    if (from && n && *n >= (socklen_t)sizeof(struct sockaddr_in)) {
        struct sockaddr_in in = { .sin_family = AF_INET, .sin_port = htons(d->port), .sin_addr = { htonl(d->from) } };
        memcpy(from, &in, sizeof in), *n = sizeof in;
    }
    if (!(s->first = d->next)) s->last = NULL;
    s->bytes -= d->len;
    free(d);
    pthread_mutex_unlock(&g_mu);
    return (ssize_t)take;
}
ssize_t net_recv(int fd, void *buf, size_t len, int flags) { return recvfrom(fd, buf, len, flags, NULL, NULL); }
ssize_t net_send(int fd, const void *buf, size_t len, int flags) { (void)buf, (void)len, (void)flags; errno = vs(fd) ? EDESTADDRREQ : EBADF; return -1; }
int setsockopt(int fd, int level, int opt, const void *v, socklen_t n) {
    pthread_mutex_lock(&g_mu);
    vsock_t *s = vs(fd);
    int x = v && n >= (socklen_t)sizeof(int) ? *(const int *)v : 0, size = x < 0 ? 0 : x > NET_RCVBUF_MAX ? NET_RCVBUF_MAX : x;
    if (s && level == SOL_SOCKET && opt == SO_REUSEADDR && v) s->reuse = x != 0;
    if (s && level == SOL_SOCKET && opt == SO_RCVBUF && v) s->rcvbuf = size;   /* what it holds (queue_to) */
    if (s && level == SOL_SOCKET && opt == SO_SNDBUF && v) s->sndbuf = size;   /* told back only: sendto never waits */
    pthread_mutex_unlock(&g_mu);
    if (!s) { errno = EBADF; return -1; }
    return 0;                                             /* SO_BROADCAST: as asked */
}
int net_getsockopt(int fd, int level, int opt, void *__restrict v, socklen_t *__restrict n) {
    pthread_mutex_lock(&g_mu);
    vsock_t *s = vs(fd);
    int r = 0;
    if (s && level == SOL_SOCKET && opt == SO_TYPE) r = SOCK_DGRAM;
    else if (s && level == SOL_SOCKET && opt == SO_RCVBUF) r = s->rcvbuf;
    else if (s && level == SOL_SOCKET && opt == SO_SNDBUF) r = s->sndbuf;
    pthread_mutex_unlock(&g_mu);
    if (!s) { errno = EBADF; return -1; }
    if (v && n && *n >= (socklen_t)sizeof r) memcpy(v, &r, sizeof r), *n = sizeof r;
    return 0;
}
int net_fcntl(int fd, int cmd, ...) {
    va_list ap;
    va_start(ap, cmd);
    int arg = cmd == F_SETFL ? va_arg(ap, int) : 0;
    va_end(ap);
    pthread_mutex_lock(&g_mu);
    vsock_t *s = vs(fd);
    int r = -1;
    if (!s) errno = EBADF;
    else if (cmd == F_GETFL) r = O_RDWR | (s->nonblock ? O_NONBLOCK : 0);
    else if (cmd == F_SETFL) s->nonblock = (arg & O_NONBLOCK) != 0, r = 0;
    else r = 0;
    pthread_mutex_unlock(&g_mu);
    return r;
}
int net_ioctl(int fd, int req, ...) {
    va_list ap;
    va_start(ap, req);
    int *arg = va_arg(ap, int *);
    va_end(ap);
    pthread_mutex_lock(&g_mu);
    vsock_t *s = vs(fd);
    int r = -1;
    if (!s) errno = EBADF;
    else if (req == FIONREAD && arg) { pump(); *arg = s->first ? s->first->len : 0; r = 0; }
    else if (req == FIONBIO && arg) { s->nonblock = *arg != 0; r = 0; }
    else errno = EINVAL;
    pthread_mutex_unlock(&g_mu);
    return r;
}
/* readable: a datagram queued; always writable. No waiting (wsock32.c polls with 0). */
int net_poll(struct pollfd *fds, nfds_t n, int timeout) {
    (void)timeout;
    int ready = 0;
    pthread_mutex_lock(&g_mu);
    pump();
    for (nfds_t i = 0; i < n; i++) {
        vsock_t *s = vs(fds[i].fd);
        fds[i].revents = 0;
        if (!s) { fds[i].revents = POLLNVAL; ready++; continue; }
        if ((fds[i].events & POLLIN) && s->first) fds[i].revents |= POLLIN;
        if (fds[i].events & POLLOUT) fds[i].revents |= POLLOUT;
        if (fds[i].revents) ready++;
    }
    pthread_mutex_unlock(&g_mu);
    return ready;
}

/* ---- names: this PC's is its address on the LAN ---- */
int gethostname(char *name, size_t n) {
    if (!n) { errno = EINVAL; return -1; }
    strncpy(name, "ra2-web", n);
    name[n - 1] = 0;
    return 0;
}
struct hostent *gethostbyname(const char *name) {
    static struct hostent he;
    static char *aliases[1], *list[2], hname[] = "ra2-web";
    static uint32_t addr;
    uint32_t me = own_ip();
    if (!name || !me || (strcasecmp(name, hname) && strcasecmp(name, "localhost"))) return NULL;
    addr = htonl(strcasecmp(name, "localhost") ? me : 0x7F000001u);
    list[0] = (char *)&addr, list[1] = NULL, aliases[0] = NULL;
    he = (struct hostent){ hname, aliases, AF_INET, 4, list };
    return &he;
}
int getifaddrs(struct ifaddrs **out) {
    uint32_t me = own_ip();
    *out = NULL;
    if (!me) return 0;
    struct { struct ifaddrs ifa; struct sockaddr_in addr, mask, bcast; char name[8]; } *i = calloc(1, sizeof *i);
    if (!i) { errno = ENOMEM; return -1; }
    i->addr = (struct sockaddr_in){ .sin_family = AF_INET, .sin_addr = { htonl(me) } };
    i->mask = (struct sockaddr_in){ .sin_family = AF_INET, .sin_addr = { htonl(0xFFFF0000u) } };
    i->bcast = (struct sockaddr_in){ .sin_family = AF_INET, .sin_addr = { htonl(NET_BROADCAST) } };
    strcpy(i->name, "vlan0");
    i->ifa = (struct ifaddrs){ NULL, i->name, IFF_UP, (struct sockaddr *)&i->addr, (struct sockaddr *)&i->mask, (struct sockaddr *)&i->bcast, NULL };
    *out = &i->ifa;
    return 0;
}
void freeifaddrs(struct ifaddrs *ifa) { free(ifa); }
