/*
 * SDL.h for the WASI build: not SDL, only the part of its API that win32hle's
 * dsound.c and gdidc.c and the RA2 host's menu.c call, implemented in
 * ../../sdl.c. screen.c, the SDL window, is replaced as a whole (../../screen.c).
 *
 * - Audio: a device is a thread that calls the callback in real time, as SDL's
 *   dummy driver does, so DirectSound's play cursors move. Its output goes
 *   nowhere yet; in the browser it is where the AudioWorklet's ring is fed.
 * - Surfaces: what a rendered string is to gdidc.c (pixels, pitch, w, h and a
 *   format's bytes per pixel).
 * - Message boxes: none to show; the answer is the escape button.
 * The layouts are this file's own (nothing here is binary-compatible with
 * SDL), except that the names and the numbers the callers use are SDL's.
 */
#ifndef RA2WEB_SDL_H
#define RA2WEB_SDL_H
#include <stdint.h>
#include <string.h>

typedef uint8_t Uint8;
typedef uint16_t Uint16;
typedef uint32_t Uint32;
typedef int32_t Sint32;
typedef enum { SDL_FALSE = 0, SDL_TRUE = 1 } SDL_bool;

#define SDL_zero(x) memset(&(x), 0, sizeof(x))
#define SDL_INIT_AUDIO 0x00000010u
#define SDL_HINT_NO_SIGNAL_HANDLERS "SDL_NO_SIGNAL_HANDLERS"

const char *SDL_GetError(void);
SDL_bool SDL_SetHint(const char *name, const char *value);
int SDL_setenv(const char *name, const char *value, int overwrite);
int SDL_InitSubSystem(Uint32 flags);
void SDL_QuitSubSystem(Uint32 flags);

/* ---- audio */
typedef Uint16 SDL_AudioFormat;
typedef Uint32 SDL_AudioDeviceID;
#define AUDIO_S16LSB 0x8010
#define AUDIO_S16SYS AUDIO_S16LSB
typedef void (*SDL_AudioCallback)(void *userdata, Uint8 *stream, int len);
typedef struct SDL_AudioSpec {
    int freq;
    SDL_AudioFormat format;
    Uint8 channels;
    Uint8 silence;
    Uint16 samples;
    Uint16 padding;
    Uint32 size;
    SDL_AudioCallback callback;
    void *userdata;
} SDL_AudioSpec;
SDL_AudioDeviceID SDL_OpenAudioDevice(const char *device, int iscapture, const SDL_AudioSpec *desired,
                                      SDL_AudioSpec *obtained, int allowed_changes);
void SDL_PauseAudioDevice(SDL_AudioDeviceID dev, int pause_on);
const char *SDL_GetCurrentAudioDriver(void);

/* ---- surfaces */
typedef struct SDL_Color { Uint8 r, g, b, a; } SDL_Color;
typedef struct SDL_PixelFormat { Uint32 format; Uint8 BitsPerPixel, BytesPerPixel; } SDL_PixelFormat;
typedef struct SDL_Surface {
    SDL_PixelFormat *format;
    int w, h, pitch;
    void *pixels;
} SDL_Surface;
typedef struct SDL_RWops SDL_RWops;
int SDL_LockSurface(SDL_Surface *s);
void SDL_UnlockSurface(SDL_Surface *s);
void SDL_FreeSurface(SDL_Surface *s);
SDL_RWops *SDL_RWFromConstMem(const void *mem, int size);

/* ---- message boxes */
typedef struct SDL_Window SDL_Window;
#define SDL_MESSAGEBOX_INFORMATION 0x00000040u
#define SDL_MESSAGEBOX_BUTTON_RETURNKEY_DEFAULT 0x00000001u
#define SDL_MESSAGEBOX_BUTTON_ESCAPEKEY_DEFAULT 0x00000002u
typedef struct { Uint32 flags; int buttonid; const char *text; } SDL_MessageBoxButtonData;
typedef struct SDL_MessageBoxColorScheme SDL_MessageBoxColorScheme;
typedef struct {
    Uint32 flags;
    SDL_Window *window;
    const char *title;
    const char *message;
    int numbuttons;
    const SDL_MessageBoxButtonData *buttons;
    const SDL_MessageBoxColorScheme *colorScheme;
} SDL_MessageBoxData;
int SDL_ShowMessageBox(const SDL_MessageBoxData *data, int *buttonid);

#include "../SDL_scancode.h"
#endif
