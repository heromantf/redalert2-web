"""summarize.py [TAG...]: run.sh's logs (work/runs/lan-node-TAG/{alice,bob}.log, status.json) as RESULT.md's table.

Per player, from frame 900 on (the start's switch over, the first real TIMING done): the timing in force at the
end, the frame rate, the input delay (the player's own PROCESS_TIME events: made on a multiple of 128 frames,
carried as a command is), the time spent waiting for the other player (in all, the longest wait, the waits
over 50 ms a minute), the datagrams a second; and the game's sync check, late events, the relay's drops.
"""
import json
import os
import re
import statistics
import sys

WEB = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ALL = 'orig-0 pz-0 orig-25 pz-25 orig-50 pz-50 orig-100 pz-100 orig-50j pz-50j'.split()
FROM = 900

WINDOW = re.compile(r'\[net\] frame (\d+): (\d+) frames in (\d+) ms \(([\d.]+) fps\), waited for the others (\d+) ms '
                    r'\(longest (\d+) ms, (\d+) over 50 ms\); datagrams (\d+) out, (\d+) in')
TIMING = re.compile(r'\[net\] frame (\d+): MaxAhead (\d+), FrameSendRate (\d+), frame rate (\d+)')
DELAY = re.compile(r'\[net\] frame (\d+): own PROCESS_TIME .* input delay (\d+) frames')
LEVEL = re.compile(r'\[pz\] frame (\d+): latency level (\d+) -> (\d+)')
RSP = re.compile(r'\[pz\] frame (\d+): house \d+ sends response time (\d+)')


def player(path):
    text = open(path, errors='replace').read()
    w = [tuple(map(float, m.groups())) for m in WINDOW.finditer(text) if int(m.group(1)) > FROM]
    timing = [m.groups() for m in TIMING.finditer(text)]
    delays = [int(m.group(2)) for m in DELAY.finditer(text) if int(m.group(1)) > FROM]
    levels = ['%s->%s@%s' % (m.group(2), m.group(3), m.group(1)) for m in LEVEL.finditer(text)]
    rsp = [int(m.group(2)) for m in RSP.finditer(text) if int(m.group(1)) > FROM]
    if not w:
        return None
    ms = sum(x[2] for x in w)
    fps = statistics.median(x[3] for x in w)
    d = statistics.median(delays) if delays else float('nan')
    return dict(
        frames=int(w[-1][0]), timing='%s/%s/%s' % timing[-1][1:] if timing else '?',
        fps=fps, delay=d, delay_ms=d * 1000 / fps,
        wait=100 * sum(x[4] for x in w) / ms, longest=max(x[5] for x in w),
        hitches=sum(x[6] for x in w) * 60000 / ms,
        out=statistics.median(x[7] for x in w), out_max=max(x[7] for x in w),
        inn=statistics.median(x[8] for x in w),
        rsp='%d..%d' % (min(rsp), max(rsp)) if rsp else '-', levels=' '.join(levels) or '-',
        sync=len(re.findall(r'dialog\] open 0xCE', text)) + len(re.findall(r'Writing sync data', text)),
        late=len(re.findall(r'late event 0x', text)), dropped=len(re.findall(r'Packet received too late', text)),
        battle='Capture_Mouse()' in text)


def main():
    tags = sys.argv[1:] or ALL
    print('| run | player | frames | MaxAhead/FSR/fps | fps | input delay | waiting | longest wait | waits >50 ms a minute '
          '| datagrams out/s (most) | in/s | response time | level | out of sync | late: run / dropped | relay drops |')
    print('|' + '---|' * 16)
    for t in tags:
        d = os.path.join(WEB, 'work/runs/lan-node-' + t)
        try:
            st = json.load(open(os.path.join(d, 'status.json')))['lans'][0]['traffic']
            drops = '%d/%d/%d' % (st['overRate'], st['queueFull'], st['testLost'])
        except (OSError, ValueError, IndexError, KeyError):
            drops = '?'
        for p in ('alice', 'bob'):
            path = os.path.join(d, p + '.log')
            r = player(path) if os.path.exists(path) else None
            if not r:
                print('| %s | %s | (no battle) |' % (t, p))
                continue
            print('| %s | %s | %d | %s | %.1f | %g frames, %.0f ms | %.0f %% | %d ms | %.1f | %.0f (%d) | %.0f | %s | %s | %d | %d / %d | %s |'
                  % (t, p, r['frames'], r['timing'], r['fps'], r['delay'], r['delay_ms'], r['wait'], r['longest'],
                     r['hitches'], r['out'], r['out_max'], r['inn'], r['rsp'], r['levels'], r['sync'], r['late'],
                     r['dropped'], drops))


main()
