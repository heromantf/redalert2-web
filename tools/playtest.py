#!/usr/bin/env python3
"""Scripted play tests of the WASI build: every menu and game mode, headless under Node, in parallel.

redalert2-recomp's tools/playtest.py (NOTICE.md), its cases as they were, run
on this build under Node (host/run.mjs) instead of the native host. A case is
a list of the host's script arguments (wasi/script.c); a button is named by
its caption and resolved to a dialog and control ID with lift/dialogs.py's map
(out/lift/dialogs.json: tools/lift.sh makes it), and the host presses it once
that dialog is actually open: no pixel coordinates and no fixed times for
menus.

A run leaves work/tests/<case>/run.log (everything the host printed) and its
game folder (hard links to work/game, a RA2MD.INI of its own); the summary
line says how it ended: the exit code (4 = the watchdog, the normal end of a
timed run), any fault or not-lifted report, the dialogs that opened, and the
distinct frames in game (a checksum every 3.33 s, wasi/main.c).

    .venv/bin/python tools/playtest.py --list
    .venv/bin/python tools/playtest.py menu-skirmish
    .venv/bin/python tools/playtest.py 'menu-*' 'back-*' --jobs 4
    .venv/bin/python tools/playtest.py --args skirmish-build    # a case's seconds, then its script

Not here from the native suite: hd-scroll (HD vehicles: a native host
feature), the recordings and contact sheets, --original (the shipping code
under the native host's oracle.c), Wine.
"""
import argparse
import fnmatch
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAME = os.environ.get('RA2_GAME') or os.path.join(ROOT, 'work', 'game')   # the game folder, tools/lift.sh's
GAME_EXE, GAME_INI = 'gamemd.exe', 'RA2MD.INI'
MODULE = os.path.join(ROOT, 'out', 'ra2.wasm')
OUT = os.path.join(ROOT, 'work', 'tests')
DIALOGS = os.path.join(ROOT, 'out', 'lift', 'dialogs.json')
_VENV = os.path.join(ROOT, '.venv', 'bin', 'python')                     # dialogs.py reads the exe with pefile
PY = _VENV if os.path.exists(_VENV) else sys.executable
# The web build has a network only on a relay (wasi/net.c: without one the game's IPX socket fails, error
# 10047, and the Network screens do not open): the cases that open them join one of this Mac's, each on a LAN
# of its own. The relay is relay/'s, built into out/relay if it is not there (. tools/env.sh first: Go's caches).
RELAY = os.path.join(ROOT, 'out', 'relay')
RELAY_URL = None


def needs_network(name):
    return 'network' in name or name.startswith('lan')


def relay_up():
    global RELAY_URL
    if not os.path.exists(RELAY):
        subprocess.run(['go', 'build', '-o', RELAY, '.'], cwd=os.path.join(ROOT, 'relay'), check=True)
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    os.makedirs(OUT, exist_ok=True)
    p = subprocess.Popen([RELAY, '-addr', '127.0.0.1:%d' % port], stdout=open(os.path.join(OUT, 'relay.log'), 'w'),
                         stderr=subprocess.STDOUT)
    time.sleep(0.5)
    RELAY_URL = 'ws://127.0.0.1:%d/net' % port
    return p


# The menu screens, by the dialog resource the game builds them from
# (py -3 tools/dialogs.py --show 0xE2 lists one).
MAIN, SINGLE, SKIRMISH, CAMPAIGN, LOADGAME = 0xE2, 0x100, 0x102, 0x94, 0xB7
OPTIONS, LAN, MOVIES, KEYBOARD, CONFIRM, NEWLAN = 0xD5, 0xBB, 0x101, 0xA3, 0x120, 0xBC

_dialogs = None


def controls(dlg):
    """Dialog `dlg`'s controls, from tools/dialogs.py's map of the game's."""
    global _dialogs
    if _dialogs is None:
        if not os.path.exists(DIALOGS):
            subprocess.run([PY, os.path.join(ROOT, 'lift', 'dialogs.py'), '--exe',
                            os.path.join(GAME, GAME_EXE), '--out', DIALOGS], check=True)
        _dialogs = json.load(open(DIALOGS))
    return _dialogs['0x%X' % dlg]['controls']


def control(dlg, label):
    """Control ID of the button captioned GUI:<label> in dialog `dlg`."""
    for c in controls(dlg):
        if c['text'] == 'GUI:' + label:
            return c['id']
    raise KeyError('no GUI:%s in dialog 0x%X' % (label, dlg))


def combo_point(dlg, cid, item=None, at=(0, 0)):
    """Screen pixels for a combo box of dialog `dlg` (a menu at `at`, 0, 0
    for a full-screen one): its arrow, or with `item` that row of its list
    once dropped. Dialog units are win32hle's (6/4 across, 13/8 down); the
    field is 21 pixels and the game's list rows 23."""
    x, y, w, _ = next(c['rect'] for c in controls(dlg) if c['id'] == cid)
    left, top, right = at[0] + x * 6 // 4, at[1] + y * 13 // 8, at[0] + (x + w) * 6 // 4
    if item is None:
        return right - 8, top + 10
    return (left + right) // 2, top + 21 + 23 * item + 11


# Event times are seconds after the main menu first opened; --press and
# --select wait for their dialog on top of that, so they only need to come in
# the right order. One second apart is plenty.
class Script:
    def __init__(self):
        self.args, self.t, self.expect = [], 1.0, []

    def press(self, dlg, label, opens=None):
        """`label` is a GUI: caption, or a control ID for an uncaptioned one."""
        cid = label if isinstance(label, int) else control(dlg, label)
        self.args += ['--press', '0x%X:%d@%g' % (dlg, cid, self.t)]
        self.t += 1
        if opens is not None:
            self.expect.append(opens)
        return self

    def select(self, dlg, ctrl, n):
        self.args += ['--select', '0x%X:%d=%d@%g' % (dlg, ctrl, n, self.t)]
        self.t += 1
        return self

    def waitlog(self, text):
        """Hold until the game's debug log prints `text` (Capture_Mouse: in game)."""
        self.args += ['--waitlog', '%s@%g' % (text, self.t)]
        self.t += 1
        return self

    def move(self, x, y, after=0):
        self.t += after
        self.args += ['--move', '%d,%d@%g' % (x, y, self.t)]
        self.t += 1
        return self

    def uclick(self, x, y, after=0):
        """A left click at screen pixel x, y as the mouse gives it: to the
        window under the point (a menu's control), not the game's window
        (script.c, through win32hle's windows)."""
        self.t += after
        self.args += ['--uclick', '%d,%d@%g' % (x, y, self.t)]
        self.t += 1
        return self

    def click(self, x, y, after=0, mods=''):
        """A left click at game pixel x, y; mods 'c', 's', 'a' held with it
        (Ctrl+click is force-fire)."""
        self.t += after
        self.args += ['--click', '%s%d,%d@%g' % (mods + '+' if mods else '', x, y, self.t)]
        self.t += 1
        return self

    def drag(self, x1, y1, x2, y2, after=0):
        """A band selection from x1, y1 to x2, y2 (game pixels)."""
        self.t += after
        self.args += ['--drag', '%d,%d,%d,%d@%g' % (x1, y1, x2, y2, self.t)]
        self.t += 2
        return self

    def rdrag(self, x1, y1, x2, y2, after=0):
        """Hold the right button at x1, y1, move to x2, y2 and hold there a
        second: the game's right-drag scroll."""
        self.t += after
        self.args += ['--rdrag', '%d,%d,%d,%d@%g' % (x1, y1, x2, y2, self.t)]
        self.t += 3
        return self

    def key(self, vk, after=0):
        self.t += after
        self.args += ['--key', '%s@%g' % (vk, self.t)]
        self.t += 1
        return self


def S():
    return Script()


# name: (script, seconds the run lasts, what it must show)
#   expect 'dialogs': every listed dialog opened
#   expect 'ingame':  the game started (its own Capture_Mouse() log line) and
#                     the picture kept changing (5+ distinct sampled frames)
#   expect 'alive':   no human player was defeated
#   expect 'exit':    the exit code
#   expect 'ini':     RA2MD.INI values for the case's game folder, {section: {key: value}}
#   expect 'size':    the picture in game is this (w, h)
CASES = {}


def case(name, script, seconds=60, **expect):
    expect.setdefault('dialogs', script.expect)
    CASES[name] = (script.args, seconds, expect)


case('menu-idle', S(), 40, dialogs=[MAIN])

# Every main-menu button, and the way back from each screen it opens. Exit
# Game asks first (dialog 0x120, OK/Cancel), so an exit is two presses; a
# clean exit 0 proves the main menu came back and still works.
EXIT = lambda s: s.press(MAIN, 'ExitGame', CONFIRM).press(CONFIRM, 'OK')
for label, dlg in [('SinglePlayer', SINGLE), ('Options', OPTIONS), ('Network', LAN),
                   ('MoviesAndCredits', MOVIES), ('WWOnline', 0x10E)]:
    case('menu-' + label.lower(), S().press(MAIN, label, dlg))
case('menu-exit', EXIT(S()), 60, exit=0)
case('menu-exit-cancel', S().press(MAIN, 'ExitGame', CONFIRM).press(CONFIRM, 'Cancel', MAIN))

case('back-singleplayer', EXIT(S().press(MAIN, 'SinglePlayer', SINGLE).press(SINGLE, 'MainMenu')), 60, exit=0)
case('back-options', EXIT(S().press(MAIN, 'Options', OPTIONS).press(OPTIONS, 'MainMenu')), 60, exit=0)
case('back-movies', EXIT(S().press(MAIN, 'MoviesAndCredits', MOVIES).press(MOVIES, 'MainMenu')), 60, exit=0)
case('back-network', EXIT(S().press(MAIN, 'Network', LAN).press(LAN, 'MainMenu')), 60, exit=0)

# The LAN lobby's New Game: the host's game setup screen.
case('lan-new', S().press(MAIN, 'Network', LAN).press(LAN, 'New', NEWLAN))

# Single player's three doors.
SP = lambda: S().press(MAIN, 'SinglePlayer', SINGLE)
case('sp-skirmish', SP().press(SINGLE, 'Skirmish', SKIRMISH))
case('sp-campaign', SP().press(SINGLE, 'NewCampaign', CAMPAIGN))
case('sp-load', SP().press(SINGLE, 'LoadSavedGame', LOADGAME))

# Options' sub-screens and the movie/credit players.
case('options-keyboard', S().press(MAIN, 'Options', OPTIONS).press(OPTIONS, 'Keyboard', KEYBOARD))
# A resolution picked from the Options screen's own list (issue #24), from
# 800x600, the panel at 0, 0; the list's fourth row, 1152x864. Yuri's Revenge
# only saves it (Red Alert 2 switches there and then). The case asks for the
# large modes itself.
pick = (S().press(MAIN, 'Options', OPTIONS).uclick(*combo_point(OPTIONS, 1773), after=3)
        .uclick(*combo_point(OPTIONS, 1773, item=3), after=2))
video = {'Video': {'ScreenWidth': 800, 'ScreenHeight': 600, 'AllowHiResModes': 'yes'}}
case('options-resolution', pick.press(OPTIONS, 'MainMenu', MAIN), 90, dialogs=[OPTIONS], ini=video)
case('movies-credits', S().press(MAIN, 'MoviesAndCredits', MOVIES).press(MOVIES, 'ViewCredits'), 90)
case('movies-sneakpeeks', S().press(MAIN, 'MoviesAndCredits', MOVIES).press(MOVIES, 'SneakPeeks'), 90)

# Into the game. A skirmish on the default map and settings; each campaign
# from the campaign screen's list (0 and 1: Allied and Soviet), at the
# default difficulty. In game the screen is blitted every frame, so the frame
# count says the game is running, and the sheet says what it shows.
# A skirmish played through by nobody: in game, H (centre on base -- headless,
# the view starts off the player's base and shows only black shroud; the
# original does the same, so it is the host's), then nothing. The idle player
# is beaten (at start 52,97 in about 4.5 minutes, on the shipping code too),
# the skirmish score screen opens, and Continue goes back to the main menu:
# the whole loop, start to menu.
INGAME = 'Capture_Mouse'
case('skirmish-start', SP().press(SINGLE, 'Skirmish', SKIRMISH).press(SKIRMISH, 'StartGame')
     .waitlog(INGAME).move(236, 240, after=2).key('0x48', after=10), 180, ingame=True)
# A third player picked with the mouse, through the skirmish screen's own
# drop-down list (the third row's arrow, then its "Easy Enemy"): the list has
# to open with room for its items, and close (--uclick).
case('skirmish-dropdown', SP().press(SINGLE, 'Skirmish', SKIRMISH).uclick(*combo_point(SKIRMISH, 1294), after=3)
     .uclick(*combo_point(SKIRMISH, 1294, item=1), after=2).press(SKIRMISH, 'StartGame').waitlog(INGAME), 150,
     ingame=True, log={'Assigning Starting Points for house 2': 1},
     # a map with room for a third player: the list starts with the 2-player maps
     # (index 0 is The Alamo), whatever the player's INI saved last; 30 is Arena
     ini={'Skirmish': {'ScenIndex': 30}})
# Orders by mouse: select and deploy the MCV, band-select everything on
# screen, then Ctrl+click (force-fire) at two of the tanks. Written to put
# explosions and debris (voxel animations) under the camera; it has not yet
# (docs/voxels.md), but it keeps --drag and modifier clicks working. The voxel
# animations and debris that follow are drawn at 2x with HD voxels
# (docs/voxels.md); this case is how they are exercised.
case('skirmish-forcefire', SP().press(SINGLE, 'Skirmish', SKIRMISH).press(SKIRMISH, 'StartGame')
     .waitlog(INGAME).move(236, 240, after=2).key('0x48', after=10)
     .click(236, 213, after=2).key('0x44', after=1)
     .drag(8, 8, 464, 440, after=15).click(352, 158, after=1, mods='c').click(110, 277, after=20, mods='c'),
     180, ingame=True)
# Building and training: deploy the MCV; build a power plant from the
# sidebar's first icon and place it beside the construction yard; then a
# barracks (the second row's first icon, once power is up) the same way; then
# the infantry tab and a GI. Each order is checked in the game's own event log
# (PRODUCE for each of the three, PLACE for the two buildings). Sidebar
# coordinates are for 640x480 (tabs: buildings, defences, infantry, vehicles);
# a hover first, as a player's cursor would be.
# Around the construction yard, near first: the first spot no unit stands on
# builds; a click on a taken spot is refused and costs nothing.
PLACES = [(330, 250), (150, 250), (236, 320), (330, 320), (120, 170), (130, 330), (380, 180),
          (360, 360), (90, 260), (400, 280), (236, 390), (110, 400), (380, 420), (70, 150)]


def place(script):
    for x, y in PLACES:
        script = script.click(x, y, after=1)
    return script


case('skirmish-build', place(place(
    SP().press(SINGLE, 'Skirmish', SKIRMISH).press(SKIRMISH, 'StartGame')
    .waitlog(INGAME).move(236, 240, after=2).key('0x48', after=10)
    .click(236, 213, after=2).key('0x44', after=1).waitlog('Adding event DEPLOY')
    .move(523, 251, after=8).click(523, 251, after=1)                   # power plant
    .move(523, 251, after=28).click(523, 251, after=1))                  # ready: pick it up
    .move(523, 300, after=4).click(523, 300, after=1)                   # barracks
    .move(523, 300, after=31).click(523, 300, after=1))                  # ready: pick it up
    .move(573, 210, after=4).click(573, 210, after=1)                   # the infantry tab (third)
    .move(523, 251, after=2).click(523, 251, after=1),                  # a GI
    230, ingame=True, alive=True, log={'Adding event PRODUCE': 3, 'Adding event PLACE': 2},
    # The sidebar's coordinates are 640x480's, whatever the player's INI says
    # (a CnCNet install had 3440x1440, and every click missed the sidebar).
    ini={'Video': {'ScreenWidth': 640, 'ScreenHeight': 480}})

case('skirmish-loop', SP().press(SINGLE, 'Skirmish', SKIRMISH).press(SKIRMISH, 'StartGame')
     .waitlog(INGAME).move(236, 240, after=2).key('0x48', after=10)
     .press(0x108, 'Continue', MAIN), 720, ingame=True)
# The campaign screen starts a campaign from its emblems: uncaptioned static
# controls, Allied on top (1770) and Soviet below (1772), with "Click the
# Allied icon to start Allied campaign" under each (tools/dialogs.py --show 0x94).
for side, emblem in [('allied', 1770), ('soviet', 1772)]:
    case('campaign-' + side, SP().press(SINGLE, 'NewCampaign', CAMPAIGN)
         .press(CAMPAIGN, emblem).waitlog(INGAME).move(236, 240, after=2).key('0x48', after=10),
         300, ingame=True, alive=True)


def set_ini(text, section, key, value):
    """RA2MD.INI with [section] key=value set, the section added if missing.

    The file's last line break stays last: the game's INI reader drops a
    last line that has none, so a section added at the end lost its key."""
    lines = text.split(b'\r\n') if b'\r\n' in text else text.split(b'\n')
    tail = []
    if lines and lines[-1] == b'':
        lines, tail = lines[:-1], [b'']
    want = b'[' + section.encode() + b']'
    out, in_sec, done = [], False, False
    for l in lines:
        if l.strip().startswith(b'['):
            if in_sec and not done:
                out.append(b'%s=%s' % (key.encode(), str(value).encode()))
                done = True
            in_sec = l.strip().lower() == want.lower()
        elif in_sec and l.split(b'=')[0].strip().lower() == key.lower().encode():
            if not done:
                out.append(b'%s=%s' % (key.encode(), str(value).encode()))
                done = True
            continue
        out.append(l)
    if not done:
        if not in_sec:
            out += [b'', want]
        out.append(b'%s=%s' % (key.encode(), str(value).encode()))
    return b'\r\n'.join(out + tail)


# Hi-res and widescreen: the game's own resolution setting, the in-game
# picture at that size, in a skirmish and a campaign (docs/hires.md).
RES = [(1280, 720), (1720, 720), (1920, 1080), (2560, 1080), (2560, 1440), (2560, 1600), (3440, 1440), (3840, 1600),
       (3840, 2160)]
for w, h in RES:
    video = {'Video': {'ScreenWidth': w, 'ScreenHeight': h}}
    case('res-%dx%d' % (w, h), SP().press(SINGLE, 'Skirmish', SKIRMISH).press(SKIRMISH, 'StartGame')
         .waitlog(INGAME).move(w // 2 - 80, h // 2, after=2).key('0x48', after=10),
         180, ingame=True, size=(w, h), ini=video)
case('res-campaign-1920x1080', SP().press(SINGLE, 'NewCampaign', CAMPAIGN).press(CAMPAIGN, 1770)
     .waitlog(INGAME).move(880, 540, after=2).key('0x48', after=10), 300, ingame=True, alive=True,
     size=(1920, 1080), ini={'Video': {'ScreenWidth': 1920, 'ScreenHeight': 1080}})


def farm(d, ini=None):
    """A private game folder for one case, made of hard links to game/.

    The game writes into its folder (RA2MD.INI, saves, debug files), so cases
    sharing one would clobber each other; links cost no space. RA2MD.INI is
    copied, with the intro off: four minutes of cinematic before every case
    is a waste, and the intro has its own case in tools/conformance.py.
    """
    src = GAME
    for dirpath, dirs, files in os.walk(src):
        out = os.path.join(d, os.path.relpath(dirpath, src))
        os.makedirs(out, exist_ok=True)
        for f in files:
            t = os.path.join(out, f)
            if f.upper() == GAME_INI:
                if os.path.exists(t):
                    os.remove(t)
                text = open(os.path.join(dirpath, f), 'rb').read()
                text = re.sub(rb'(?im)^Play=\w+', b'Play=no', text)
                for sec, kv in (ini or {}).items():
                    for k, v in kv.items():
                        text = set_ini(text, sec, k, v)
                open(t, 'wb').write(text)
            elif not os.path.exists(t):
                try:
                    os.link(os.path.join(dirpath, f), t)
                except OSError:                      # game/ on another drive (a Steam library): a symlink
                    os.symlink(os.path.join(dirpath, f), t)
    return d


def run(name, args, seconds, expect):
    d = os.path.join(OUT, name)
    if os.path.isdir(os.path.join(d, 'game')):
        shutil.rmtree(os.path.join(d, 'game'))      # a fresh folder: no saves left over
    os.makedirs(d, exist_ok=True)
    game = farm(os.path.join(d, 'game'), expect.get('ini'))
    log = os.path.join(d, 'run.log')
    net = ['--relay', RELAY_URL, '--name', name[:16], '--lan', name[:32]] if RELAY_URL and needs_network(name) else []
    cmd = ['node', os.path.join(ROOT, 'host', 'run.mjs'), '--dir', game + '::/game'] + net + [MODULE,
           '--run', '--mute', '--debuglog', '--watchdog', str(seconds),
           '--exe', '/game/' + GAME_EXE, '--game', '/game'] + args
    cmd += os.environ.get('RA2_HOST_ARGS', '').replace('{case}', d).split()  # extra host flags; {case} is the case's folder
    with open(log, 'w', errors='replace') as f:
        try:
            code = subprocess.run(cmd, cwd=ROOT, stdout=f, stderr=subprocess.STDOUT,
                                  timeout=seconds + 300).returncode
        except subprocess.TimeoutExpired:
            code = 'timeout'
    text = open(log, errors='replace').read()
    lines = text.splitlines()
    # An unresolved ICALL returns 0 and the game carries on: the voxel
    # rasterizer was one, and every vehicle was invisible.
    bad = [l for l in lines if l.startswith(('===', '[not-lifted]', 'ITAIL', 'ICALL', '[messagebox]'))]
    bad += [l for l in lines if l.startswith('[input]') and ('never opened' in l or 'no such control' in l)]
    opened = []
    for m in re.finditer(r'\[dialog\] open 0x([0-9A-F]+)', text):
        if not opened or opened[-1] != m.group(1):
            opened.append(m.group(1))
    distinct = len(set(re.findall(r'\[record\] frame \d+ (?:at \S+ )?checksum ([0-9A-F]{8})', text)))
    ingame = '[game] Capture_Mouse()' in text
    modes = re.findall(r'\[(?:headless|ddraw)\] SetDisplayMode\((\d+)x(\d+)x\d+\)', text)
    defeated = re.search(r'\[game\] MPlayer_Defeated\(\) - Player <human player> has been defeated', text)
    seen = ['dialogs ' + ' '.join(opened)] if opened else []
    if ingame:
        seen.append('in game, %d distinct frames' % distinct)
    if defeated:
        seen.append('human defeated')
    for dlg in expect.get('dialogs', []):
        if '%X' % dlg not in opened:
            bad.append('dialog 0x%X never opened' % dlg)
    if expect.get('ingame') and not (ingame and distinct >= 5):
        bad.append('never in game' if not ingame else 'picture stopped (%d frames)' % distinct)
    if 'size' in expect and (not modes or tuple(map(int, modes[-1])) != tuple(expect['size'])):
        bad.append('in game at %s, wanted %dx%d' % ('x'.join(modes[-1]) if modes else 'no mode', *expect['size']))
    if modes and ingame:
        seen.append('%sx%s' % modes[-1])
    if expect.get('alive') and defeated:
        bad.append('the human player was defeated')
    # log: {text: at least n}, lines the game's own debug log must print
    # ("Adding event PRODUCE" for each order to build or train).
    for text, n in expect.get('log', {}).items():
        got = sum(text in l for l in lines)
        if got < n:
            bad.append('"%s" %d times, wanted %d' % (text, got, n))
        elif n:
            seen.append('%s x%d' % (text.split()[-1].lower(), got))
    if 'exit' in expect and code != expect['exit']:
        bad.append('expected exit %d' % expect['exit'])
    elif 'exit' not in expect and code not in (0, 4):
        bad.append('exit %s' % code)
    return name, code, bad, seen


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('cases', nargs='*', help='case names or globs (default: all)')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--args', metavar='CASE', help="print a case's seconds, then its script, a line each")
    ap.add_argument('--jobs', type=int, default=3)
    a = ap.parse_args()
    if a.list:
        for n, (args, s, e) in CASES.items():
            print('%-22s %4ds  %s' % (n, s, ' '.join(args)))
        return 0
    if a.args:
        args, secs, _ = CASES[a.args]
        print(secs)
        print('\n'.join(args))
        return 0
    if not (os.path.exists(MODULE) and os.path.isdir(GAME)):
        print('playtest: skipped -- needs out/ra2.wasm (wasi/build.sh) and work/game (README)')
        return 0
    names = [n for n in CASES if not a.cases or any(fnmatch.fnmatch(n, p) for p in a.cases)]
    relay = relay_up() if any(needs_network(n) for n in names) else None
    failed = 0
    os.makedirs(OUT, exist_ok=True)
    summary = open(os.path.join(OUT, 'summary.txt'), 'w')
    with ThreadPoolExecutor(a.jobs) as ex:
        for name, code, bad, seen in ex.map(lambda n: run(n, *CASES[n]), names):
            line = '%s %-22s exit %-7s %s%s' % ('FAIL' if bad else 'pass', name, code, '; '.join(seen) or '-',
                                                ('  !! ' + ' | '.join(bad[:3])) if bad else '')
            print(line, flush=True)
            summary.write(line + '\n')
            summary.flush()
            failed += bool(bad)
    if relay:
        relay.terminate()
    print('%d of %d failed' % (failed, len(names)))
    summary.write('%d of %d failed\n' % (failed, len(names)))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
