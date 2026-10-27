/* netdb.h for WASI preview1, which has none: what wsock32.c names. Name
 * lookups find nothing (compat.c). */
#ifndef RA2WEB_NETDB_H
#define RA2WEB_NETDB_H
struct hostent {
    char *h_name;
    char **h_aliases;
    int h_addrtype;
    int h_length;
    char **h_addr_list;
};
#define h_addr h_addr_list[0]
struct hostent *gethostbyname(const char *);
#endif
