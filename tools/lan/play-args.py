#!/usr/bin/env python3
# play-args.py T: tools/playtest.py's skirmish-build play (deploy the MCV, a power plant, a barracks, a GI),
# from script time T on, as host arguments, one a line (a battle's events for the sync check to cover)
import sys
t = float(sys.argv[1]); out = []
def at(dt, *a):
    global t; t += dt; out.extend([a[0], f"{a[1]}@{t:g}"])
PLACES = [(330, 250), (150, 250), (236, 320), (330, 320), (120, 170), (130, 330), (380, 180),
          (360, 360), (90, 260), (400, 280), (236, 390), (110, 400), (380, 420), (70, 150)]
def place():
    for x, y in PLACES: at(1, '--click', f'{x},{y}')
at(1, '--move', '236,240'); at(10, '--key', '0x48'); at(2, '--click', '236,213'); at(1, '--key', '0x44')
at(1, '--waitlog', 'Adding event DEPLOY')
at(8, '--move', '523,251'); at(1, '--click', '523,251'); at(28, '--move', '523,251'); at(1, '--click', '523,251'); place()
at(4, '--move', '523,300'); at(1, '--click', '523,300'); at(31, '--move', '523,300'); at(1, '--click', '523,300'); place()
at(4, '--move', '573,210'); at(1, '--click', '573,210'); at(2, '--move', '523,251'); at(1, '--click', '523,251')
print('\n'.join(out))
