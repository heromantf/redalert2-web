# gditext: where GDI text shows in Yuri's Revenge (2026-10-26)

The WASI build has no fonts: `wasi/sdl.c`'s `TTF_Init` fails, so win32hle's
`gdidc.c` draws no GDI text (`TextOutA` returns at once) and measures with its
fallback metrics. The question: what of the game does that change?

**Answer: nothing seen. The game draws all its text itself, with its own
fonts; GDI's text is not reached in play.** Fonts for GDI text (the plan's
step 6) are not needed for RA2.

## What the game could use

- Imports (`gamemd.exe`): GDI32 `TextOutA` (the only call that draws text),
  `CreateFontIndirectA`, `GetTextMetricsA`, `SetTextColor`, `GetTextColor`;
  USER32 `SetDlgItemTextA`, `GetWindowTextA`, `GetKeyNameTextA`. No
  `DrawText*`, `ExtTextOut*`, `GetTextExtent*`, no wide-character text calls.
- Callers in the lift (the lifter's notes on each function):
  - `TextOutA`: only `sub_005BD3D0`, under `sub_005BD490`, in a window
    `sub_005BC530` makes with `CreateDialogParamA` and a "Courier" font
    (`CreateFontIndirectA`'s only caller): a developer's text console.
  - `GetTextMetricsA`: that console, `sub_00618C58` (a list control's window
    procedure, "Scrollbar") and `sub_007760B0`.
  - `SetTextColor`: `ownrdraw.cpp`'s owner-drawn controls, which draw their
    text with the game's fonts.
  - `SetDlgItemTextA`: `sub_004C83E0`, a dialog of "Sorry, you can only
    attempt an emergency..." (an error).
- win32hle itself: its standard controls do not draw a game's text ("a game
  that paints its own controls ... paints them into its own"), `DrawTextA`
  draws nothing even natively ("the game draws its own"), and a message box
  only prints and answers, natively too.

## What it does in play

`--trace` (every import call by name) through real screens, the text and font
calls counted (`TextOut`, `DrawText`, `CreateFont`, `GetTextMetrics`,
`SetTextColor`, `GetTextExtent`, `SetDlgItemText`, `GetKeyNameText`,
`MessageBox`):

| Run | Screens (dialogs) | Import calls | Text and font calls |
|---|---|---|---|
| wasm, skirmish | main menu, single player, skirmish, in game | 5.6 M | 0 |
| wasm, campaign | main menu, single player, campaign | 8.8 M | 0 |
| wasm, options | main menu, options, keyboard | 10.3 M | `GetKeyNameTextA` 2 (key names: a string, no font) |
| wasm, load | main menu, single player, load | 5.8 M | 0 |
| native, network | main menu, network | 13.7 M | 0 |
| native, LAN game | main menu, network, new LAN game (its chat) | 14.3 M | 0 |

And the screens most likely to show it, with list controls (`compare.sh`):
the skirmish's map list (dialog 0x6B) and the keyboard options (0xA3), dumped
by the native build (real fonts) and the WASI one (none): the frames are
byte-identical (the same MD5), and the screenshots show their lists full of
the game's own text. The comparison does see a difference where there is one
(two different screens: 25,000 pixels).

## Found on the way

In the browser the Network button returns to the main menu: the game creates
an IPX socket, `socket()` fails (`wasi/compat.c`: there is no network), and it
logs "Failed to create IPX socket - error code 10047" (WSAEAFNOSUPPORT). That
is the multiplayer step's (on hold), not the fonts'.

## Not covered

The developer's console (`sub_005BC530`), never opened in these runs; a
crash's "emergency" dialog; World Online's screens (its service is gone).
