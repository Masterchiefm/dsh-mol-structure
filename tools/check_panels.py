"""Programmatic sanity check for captured panel screenshots.

Usage:  python -I tools/check_panels.py [dir]
        (default dir: docs/screenshots/final)

Checks, per <id>-canvas.png:
  1. unique content  — no two panels share the same image bytes (stale-frame guard)
  2. foreground       — non-white pixels >= 3% of the canvas (blank-render guard)
  3. hue families     — key panels must contain their expected color clusters
                        (paper palette, tolerance on darkness/lighting)

Exit code 0 = all pass; 1 = failures listed on stdout.
"""
import sys
import colorsys
from hashlib import md5
from pathlib import Path

from PIL import Image

# expected hue-family signatures: panel id -> list of (name, predicate)
# predicates get (r, g, b) each in 0..255 of a *foreground* pixel
def _hue(r, g, b):
    h, _, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    return h * 360, v

def is_red(r, g, b):
    h, v = _hue(r, g, b)
    return (h <= 18 or h >= 342) and v > 0.25

def is_blue(r, g, b):
    h, v = _hue(r, g, b)
    return 195 <= h <= 250 and v > 0.25

def is_green(r, g, b):
    h, v = _hue(r, g, b)
    return 85 <= h <= 160 and v > 0.25

def is_gray(r, g, b):
    mx, mn = max(r, g, b), min(r, g, b)
    return mx - mn <= 18 and mx > 60

def is_violet(r, g, b):
    h, v = _hue(r, g, b)
    return 258 <= h <= 300 and v > 0.20

def is_yellow(r, g, b):
    h, v = _hue(r, g, b)
    return 40 <= h <= 66 and v > 0.35

# minimum share of foreground pixels that must match each family
SIGNATURES = {
    'fig1b':      [('red(RNA)', is_red, 0.05), ('blue(PLMP/RuvC)', is_blue, 0.03),
                   ('green(BH)', is_green, 0.01)],
    'fig1c':      [('red(RNA)', is_red, 0.03), ('blue(RuvC/PLMP)', is_blue, 0.03),
                   ('violet(TAM)', is_violet, 0.002)],
    'fig1cBack':  [('red(RNA)', is_red, 0.03), ('blue(RuvC/PLMP)', is_blue, 0.03)],
    'fig2':       [('blue(PLMP/RuvC)', is_blue, 0.05), ('green(BH)', is_green, 0.01),
                   ('yellow(WED)', is_yellow, 0.01)],
    'fig3bA':     [('red-family', is_red, 0.02)],
    'fig3bB':     [('red-family', is_red, 0.02)],
    'fig4a':      [('red(RNA)', is_red, 0.06), ('gray(surface)', is_gray, 0.05)],
    'fig4aBack':  [('red(RNA)', is_red, 0.06), ('gray(surface)', is_gray, 0.05)],
    'fig4c':      [('red/guide-stick)', is_red, 0.01)],
    'fig4d':      [('red-family', is_red, 0.01)],
    'fig4e':      [('violet(TAM)', is_violet, 0.01)],
    # Cas12i (6W5C): orange crRNA, magenta TS, sky-blue NTS, green RuvC, pink Nuc
    'c1ov':       [('orange/crRNA', lambda r, g, b: 18 <= _hue(r, g, b)[0] <= 45 and _hue(r, g, b)[1] > 0.35, 0.02),
                   ('magenta/TS', lambda r, g, b: 300 <= _hue(r, g, b)[0] <= 340 and _hue(r, g, b)[1] > 0.3, 0.01)],
    'c2d':        [('red(PAM)', is_red, 0.005)],
}

FG_BG_THRESHOLD = 245  # pixels with all channels above this count as background


def foreground_pixels(img):
    px = img.convert('RGB').getdata()
    fg = [(r, g, b) for r, g, b in px if not (r > FG_BG_THRESHOLD and g > FG_BG_THRESHOLD and b > FG_BG_THRESHOLD)]
    total = img.width * img.height
    return fg, total


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / 'docs/screenshots/final'
    files = sorted(root.glob('*-canvas.png'))
    if not files:
        print(f'FAIL no *-canvas.png under {root}')
        return 1

    failures = []
    seen_hashes = {}
    for f in files:
        pid = f.name[:-len('-canvas.png')]
        h = md5(f.read_bytes()).hexdigest()
        if h in seen_hashes:
            failures.append(f'{pid}: identical to {seen_hashes[h]} (stale frame?)')
            continue
        seen_hashes[h] = pid

        img = Image.open(f)
        # sample every 4th pixel for speed
        img = img.resize((img.width // 4, img.height // 4))
        fg, total = foreground_pixels(img)
        share = len(fg) / total
        if share < 0.03:
            failures.append(f'{pid}: foreground only {share:.1%} (<3%) — blank render?')
            continue

        sig = SIGNATURES.get(pid)
        notes = [f'fg={share:.0%}']
        if sig:
            for name, pred, min_share in sig:
                matched = sum(1 for p in fg if pred(*p)) / len(fg)
                notes.append(f'{name}={matched:.1%}')
                if matched < min_share:
                    failures.append(f'{pid}: {name} only {matched:.2%} (<{min_share:.1%})')
        print(f'{pid}: {" ".join(notes)}')

    if failures:
        print('\nFAILURES:')
        for x in failures:
            print(' -', x)
        return 1
    print('\nALL CHECKS PASSED')
    return 0


if __name__ == '__main__':
    sys.exit(main())
