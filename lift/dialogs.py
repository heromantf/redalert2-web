#!/usr/bin/env python3
"""Map every menu screen in gamemd.exe: dialog ID -> its controls.

RA2's menus are Win32 dialog resources (98 of them). Each control's caption
is a string-table key such as GUI:Skirmish, which the game looks up in its
CSF at run time, so the template alone says what every button is. The
playtest cases (tools/playtest.py) press buttons by dialog and control ID,
and this map is how those IDs were found.

The output is derived from the binary, so it lives in work/ and is never
committed (REPO_RULES section 3).

    py -3 tools/dialogs.py                     # -> work/dialogs.json
    py -3 tools/dialogs.py --show 0x100        # one dialog, readable
"""
import argparse
import json
import os
import struct

import pefile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RT_DIALOG = 5
CLASSES = {0x80: 'Button', 0x81: 'Edit', 0x82: 'Static', 0x83: 'ListBox',
           0x84: 'ScrollBar', 0x85: 'ComboBox'}


def _sz_or_ord(b, o):
    """A DLGTEMPLATE name field: 0, 0xFFFF + ordinal, or a UTF-16 string."""
    w = struct.unpack_from('<H', b, o)[0]
    if w == 0:
        return '', o + 2
    if w == 0xFFFF:
        return struct.unpack_from('<H', b, o + 2)[0], o + 4
    e = o
    while struct.unpack_from('<H', b, e)[0]:
        e += 2
    return b[o:e].decode('utf-16le'), e + 2


def _align4(o):
    return (o + 3) & ~3


def parse(b):
    """Controls of one DLGTEMPLATE or DLGTEMPLATEEX: [{id, class, text}]."""
    ex = struct.unpack_from('<HH', b, 0) == (1, 0xFFFF)
    if ex:
        style, = struct.unpack_from('<I', b, 12)
        count, = struct.unpack_from('<H', b, 16)
        o = 26
    else:
        style, = struct.unpack_from('<I', b, 0)
        count, = struct.unpack_from('<H', b, 8)
        o = 18
    _, o = _sz_or_ord(b, o)            # menu
    _, o = _sz_or_ord(b, o)            # class
    title, o = _sz_or_ord(b, o)
    if style & 0x40:                   # DS_SETFONT
        o += 6 if ex else 2
        _, o = _sz_or_ord(b, o)
    controls = []
    for _ in range(count):
        o = _align4(o)
        if ex:
            x, y, cx, cy = struct.unpack_from('<hhhh', b, o + 12)
            cid, = struct.unpack_from('<I', b, o + 20)
            o += 24
        else:
            x, y, cx, cy = struct.unpack_from('<hhhh', b, o + 8)
            cid, = struct.unpack_from('<H', b, o + 16)
            o += 18
        cls, o = _sz_or_ord(b, o)
        text, o = _sz_or_ord(b, o)
        extra, = struct.unpack_from('<H', b, o)
        o += 2 + extra
        controls.append({'id': cid, 'class': CLASSES.get(cls, cls),
                         'text': text if isinstance(text, str) else '#%d' % text,
                         'rect': [x, y, cx, cy]})       # dialog units
    return {'title': title if isinstance(title, str) else '', 'controls': controls}


def dialogs(exe):
    pe = pefile.PE(exe, fast_load=True)
    pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_RESOURCE']])
    out = {}
    for t in pe.DIRECTORY_ENTRY_RESOURCE.entries:
        if t.id != RT_DIALOG:
            continue
        for e in t.directory.entries:
            d = e.directory.entries[0].data.struct
            out['0x%X' % e.id] = parse(pe.get_data(d.OffsetToData, d.Size))
    return out


def _selftest():
    # A two-control DLGTEMPLATE built by hand: no font, buttons 1 and 0x5B0.
    def ctl(cid, text):
        t = text.encode('utf-16le') + b'\0\0'
        return struct.pack('<IIhhhhH', 0x50000000, 0, 0, 0, 10, 10, cid) + b'\xff\xff\x80\x00' + t + b'\0\0'
    head = struct.pack('<IIHhhhh', 0x80000000, 0, 2, 0, 0, 100, 100) + b'\0\0\0\0T\0\0\0'
    blob = head
    for c in (ctl(1, 'GUI:OK'), ctl(0x5B0, 'GUI:Skirmish')):
        blob += b'\0' * (_align4(len(blob)) - len(blob)) + c
    r = parse(blob)
    assert r['title'] == 'T', r
    assert [(c['id'], c['class'], c['text']) for c in r['controls']] == \
        [(1, 'Button', 'GUI:OK'), (0x5B0, 'Button', 'GUI:Skirmish')], r
    assert r['controls'][0]['rect'] == [0, 0, 10, 10], r
    print('dialogs.py self-test OK')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--exe', default=os.path.join(ROOT, 'game', 'gamemd.exe'))
    ap.add_argument('--out', default=os.path.join(ROOT, 'work', 'dialogs.json'))
    ap.add_argument('--show', help='print one dialog, e.g. 0x100')
    ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest:
        return _selftest()
    d = dialogs(a.exe)
    if a.show:
        k = '0x%X' % int(a.show, 0)
        for c in d[k]['controls']:
            print('  %5d 0x%04X  %-9s %-24s at %s' % (c['id'], c['id'], c['class'], c['text'], c['rect']))
        return
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    json.dump(d, open(a.out, 'w'), indent=1)
    print('%d dialogs -> %s' % (len(d), a.out))


if __name__ == '__main__':
    main()
