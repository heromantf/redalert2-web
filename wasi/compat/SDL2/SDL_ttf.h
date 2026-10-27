/*
 * SDL_ttf.h for the WASI build: the SDL_ttf calls gdidc.c makes (GDI's fonts),
 * implemented in ../../sdl.c. For now there are no fonts: TTF_Init fails, and
 * gdidc.c then measures text with its fallback metrics and draws none. Real
 * glyphs (stb_truetype behind these same calls) come with the picture.
 */
#ifndef RA2WEB_SDL_TTF_H
#define RA2WEB_SDL_TTF_H
#include "SDL.h"

typedef struct TTF_Font TTF_Font;
#define TTF_STYLE_NORMAL    0x00
#define TTF_STYLE_BOLD      0x01
#define TTF_STYLE_ITALIC    0x02
#define TTF_STYLE_UNDERLINE 0x04
#define TTF_HINTING_NORMAL  0
#define TTF_HINTING_LIGHT   1
#define TTF_HINTING_MONO    2
#define TTF_HINTING_NONE    3

int TTF_Init(void);
int TTF_WasInit(void);
const char *TTF_GetError(void);
TTF_Font *TTF_OpenFont(const char *file, int ptsize);
TTF_Font *TTF_OpenFontRW(SDL_RWops *src, int freesrc, int ptsize);
void TTF_CloseFont(TTF_Font *font);
int TTF_FontHeight(const TTF_Font *font);
int TTF_FontAscent(const TTF_Font *font);
int TTF_FontDescent(const TTF_Font *font);
const char *TTF_FontFaceFamilyName(const TTF_Font *font);
void TTF_SetFontStyle(TTF_Font *font, int style);
void TTF_SetFontHinting(TTF_Font *font, int hinting);
void TTF_SetFontKerning(TTF_Font *font, int allowed);
int TTF_SizeText(TTF_Font *font, const char *text, int *w, int *h);
int TTF_GlyphMetrics(TTF_Font *font, Uint16 ch, int *minx, int *maxx, int *miny, int *maxy, int *advance);
SDL_Surface *TTF_RenderText_Solid(TTF_Font *font, const char *text, SDL_Color fg);
SDL_Surface *TTF_RenderText_Blended(TTF_Font *font, const char *text, SDL_Color fg);
#endif
