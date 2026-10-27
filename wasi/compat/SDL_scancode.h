/* SDL_scancode.h for the WASI build: the scancodes the hosts' key hooks
 * compare against, with SDL's numbers (they reach the hooks as ints, from
 * ../screen.c as from SDL natively). */
#ifndef RA2WEB_SDL_SCANCODE_H
#define RA2WEB_SDL_SCANCODE_H
typedef enum {
    SDL_SCANCODE_UNKNOWN = 0,
    SDL_SCANCODE_F9 = 66,
    SDL_SCANCODE_F10 = 67,
    SDL_SCANCODE_F11 = 68,
    SDL_SCANCODE_F12 = 69,
} SDL_Scancode;
#endif
