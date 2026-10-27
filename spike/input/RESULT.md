# input: the map's edges, full screen, the locked mouse (2026-10-26)

The game scrolls while its cursor is at an edge of the picture. Read from the
game: the tactical view's position, `TacticalClass` at `*(0x887324)`, its x at
`+0xB0` (YRpp's layout; checked: still at rest, moving while at an edge, and
in step with the scripted host's `--move 0,240`: 1114 to -1277 in 5 s).
Through `tools/chrome.mjs --page play --eval` in the scripted skirmish:

| Mouse (the page's) | The view's x | The point sent |
|---|---|---|
| at the right edge (1279) | -1219, -723: scrolling | 639 |
| at the left edge (0) | -852, -1348: scrolling | 0 |
| beyond the window, right (1450) | -1273, -769: scrolling | 639 |
| then the window loses the focus | -499, -499: stopped | 637 |
| locked (simulated), moved +3000 CSS px | (at the map's edge) | 639, held |
| locked (simulated), moved -3000 CSS px | 712, 256: scrolling | 0, held |

A skirmish's start is at random near a corner: one way the view meets the
map's edge within ~94 units (which looked at first like scrolling that
stopped). In the black shroud screenshots do not tell scrolling from not.

Full screen in headless Chrome: Alt+Enter enters it with the keys locked,
Escape then reaches the game (the in-game menu, dialog 0xB5, opened) and the
page stays full screen, Alt+Enter leaves it. Pointer Lock headless Chrome does
not give ("The root document of this element is not valid for pointer lock",
the page focused and visible), so the locked mouse is simulated (a
`pointerLockElement` that is the canvas, pointer events with `movementX`):
the cursor starts where the game's was, moves by the scale (0.625 game pixels
a CSS pixel at 800x600 in 1280x960), stays in the picture, the page draws the
game's menu cursor where it is and none in a game (the game draws its own).
Not tested: a real lock (it would take this Mac's mouse), and any of it on
Windows (Ctrl+number and Alt there).

Escape and the locked mouse, from Chromium's source (main, 2026-10-26:
`chrome/browser/ui/exclusive_access/exclusive_access_manager.cc`,
`pointer_lock_controller.cc`): while the keys are locked and Escape is among
them, an Escape pressed goes to the page alone, not to the full screen or the
mouse lock; held 1.5 s it ends all three at once (`HandleUserHeldEscape` on
each). So the browser's own way to let the mouse go also leaves full screen:
Ctrl+Tab (and right Alt + right Ctrl, cnc-ddraw's keys) let it go and keep
full screen. Without the keys locked, an Escape is the mouse lock's and the
full screen's, and the game does not see it.

The browser's own keys in a window (no full screen, so no Keyboard Lock), from
Chromium's source (main, 2026-10-26: `chrome/browser/ui/accelerator_table.cc`
`kReservedCommandIds`, `browser_command_controller.cc`
`IsReservedCommandOrKey`): a page can keep any key from the browser by
`preventDefault` (input.js does, for every key the game has) except the
reserved: Ctrl+W and Ctrl+F4 (close the tab), Alt+F4 and Ctrl+Shift+W (the
window), Ctrl+T, Ctrl+N, Ctrl+Shift+N, Ctrl+Shift+T, Ctrl+Tab and
Ctrl+Shift+Tab, Ctrl+PageDown and Ctrl+PageUp, and quitting (on a Mac those
are Cmd's, which the game has none of). So F5 and Ctrl+R (reload), Ctrl+1-8
(tabs), Alt and F10 (the browser's menu), Alt+Left (back), F11 (the
browser's full screen), Ctrl+F, Ctrl+P, Ctrl+S go to the game. In full screen
everything but leaving full screen and quitting is the page's. The keys of
the system (Alt+Tab, the Windows key, Ctrl+Alt+Del) no page has in a window.
Not tried on Windows.

Since 2026-10-26 the mouse is kept as cnc-ddraw keeps it, in a window too
(`web/input.js`; docs/browser.md, "What the Steam release's wrappers do, taken"), so
a test that only moves the mouse gets nothing to the game until a click: in
headless Chrome that click is refused the lock and goes to the game, and from
then on the mouse is the game's as it moves (the edges above).

Menus or a battle: the game's own capture of the mouse, WWMouseClass's byte
at `*(0xB78164) + 0x10` (`wasi/main.c` `menus_use_windows_cursor`, the frames
header's word 8 for the page), the game logging each change
(`Capture_Mouse()`, `Release_Mouse()`). Sampled in Chrome through a scripted
skirmish: 0 at the main menu, Single Player, the skirmish setup and the whole
load; 1 from `Capture_Mouse()`, the battle; Escape in the battle: 0 within
the frame (`Release_Mouse()`, the in-game menu 0xB5); its Resume (1670): 1
again (`Capture_Mouse()`). Not sampled: the score screen, a campaign's
briefing, the in-game menu's save and load screens.
A window keeps the mouse in a battle only, by that capture (`web/input.js`
watch): checked with the lock simulated (granted at once; a real Chrome wants
a recent gesture and none for 1.25 s after an Escape) and refused (headless).
