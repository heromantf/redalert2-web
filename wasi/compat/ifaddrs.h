/* ifaddrs.h for WASI preview1, which has none: no interfaces (compat.c). */
#ifndef RA2WEB_IFADDRS_H
#define RA2WEB_IFADDRS_H
#include <sys/socket.h>
struct ifaddrs {
    struct ifaddrs *ifa_next;
    char *ifa_name;
    unsigned ifa_flags;
    struct sockaddr *ifa_addr;
    struct sockaddr *ifa_netmask;
    struct sockaddr *ifa_broadaddr;
    void *ifa_data;
};
int getifaddrs(struct ifaddrs **);
void freeifaddrs(struct ifaddrs *);
#endif
