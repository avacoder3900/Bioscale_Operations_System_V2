#!/usr/bin/env python3
"""Tests for the wax/reagent "resume after a broken tip" slicing.

Run: python3 scripts/test-fill-resume.py     (no deps, no robot, no DB)

This exists because the fill loop in both protocols is wrapped in
`if dispense and not protocol.is_simulating():` — so an Opentrons analysis/simulation
NEVER executes it and cannot catch a slicing bug. A wrong slice here means the robot
skips or re-fills real cartridges, so the maths gets tested on its own.
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def load(name, path):
    """Import a protocol module for its PURE module-level helpers only.

    The protocol's own imports (opentrons, serial) may not be installed wherever this
    runs, and we don't need them — resume_window/group_resume_plan/GROUP_ORDER are plain
    Python. So exec the module's source with the import lines and the top-level metadata
    stripped, rather than dragging in the whole robot runtime.
    """
    src = open(path, encoding='utf-8').read()
    # Everything we need (CARTS_ON_DECK / resume_window / group_resume_plan / GROUP_ORDER)
    # is declared above `def add_parameters(...)`, whose signature annotation would need
    # the opentrons runtime. Cut there and drop the imports.
    src = src.split('def add_parameters(')[0]
    src = '\n'.join(ln for ln in src.split('\n') if not ln.startswith(('import ', 'from ')))
    m = type(sys)(name)
    exec(compile(src, path, 'exec'), m.__dict__)
    return m


sys.path.insert(0, os.path.join(ROOT, 'protocols'))
wax = load('waxp', os.path.join(ROOT, 'protocols', 'Wax_Filling_GEN7_Cartridge.py'))
rgt = load('rgtp', os.path.join(ROOT, 'protocols', 'Reagent_Filling_GEN7.py'))

fails = []


def check(name, ok, detail=''):
    print(('  ok    ' if ok else '  FAIL  ') + name + (f'  — {detail}' if detail else ''))
    if not ok:
        fails.append(name)


rw = wax.resume_window
plan = rgt.group_resume_plan

# Wax: 288 wells over 24 cartridges = 12 holes per cartridge.
WAX_N = 288
print('\n1. a normal full run is completely unchanged (the default must be a no-op)')
check('wax (1,1) over 24 carts -> the whole list', rw(WAX_N, 24) == (0, 288), str(rw(WAX_N, 24)))
check('wax (1,1) over 5 carts -> the old prefix truncation', rw(WAX_N, 5) == (0, 60), str(rw(WAX_N, 5)))
check('reagent group with no resume set -> full', plan('well_3', '') == 'full')

print('\n2. resume lands on the right well')
# cartridge 24 = wells 276..287 (0-based); hole 3 -> index 276 + 2 = 278
check('wax cartridge 24, hole 3 -> index 278', rw(WAX_N, 24, 24, 3) == (278, 288), str(rw(WAX_N, 24, 24, 3)))
check('  ...and 10 wells remain to fill', rw(WAX_N, 24, 24, 3)[1] - rw(WAX_N, 24, 24, 3)[0] == 10)
check('wax cartridge 2, hole 1 -> index 12', rw(WAX_N, 24, 2, 1) == (12, 288), str(rw(WAX_N, 24, 2, 1)))
check('wax cartridge 1, hole 12 -> index 11', rw(WAX_N, 24, 1, 12) == (11, 288), str(rw(WAX_N, 24, 1, 12)))

# Reagent well_2 group: 72 wells / 24 carts = 3 holes per cartridge.
RGT_N = 72
check('reagent cart 24, hole 3 -> index 71 (the very last well)',
      rgt.resume_window(RGT_N, 24, 24, 3) == (71, 72), str(rgt.resume_window(RGT_N, 24, 24, 3)))
check('reagent cart 10, hole 2 -> index 28', rgt.resume_window(RGT_N, 24, 10, 2) == (28, 72),
      str(rgt.resume_window(RGT_N, 24, 10, 2)))

print('\n3. the slice can never run past the end, or backwards')
check('resume beyond cartridges_per_deck clamps to end (fills nothing, does not wrap)',
      rw(WAX_N, 5, 24, 1) == (60, 60), str(rw(WAX_N, 5, 24, 1)))
s, e = rw(WAX_N, 5, 24, 1)
check('  ...and an empty slice really is empty', len(list(range(288))[s:e]) == 0)
check('start is never negative', rw(WAX_N, 24, 1, 1)[0] == 0)

print('\n4. reagent groups before/at/after the resume point')
check("groups BEFORE the broken tip are skipped", plan('well_2a', 'well_4') == 'skip')
check("the group that broke RESUMES", plan('well_4', 'well_4') == 'resume')
check("groups AFTER it run in FULL", plan('well_5', 'well_4') == 'full')
check("order follows GROUP_ORDER, not the name", plan('well_2', 'well_5c') == 'full',
      "well_2 is dispatched AFTER well_5c")
check('an unknown/garbage reagent name degrades to a normal full run',
      plan('well_3', 'not_a_group') == 'full')

print('\n5. the whole-deck invariant: every well is filled exactly once across a '
      'break + resume')
# Simulate: run dies at cartridge 13, hole 2 of the wax deck.
first_start, first_end = rw(WAX_N, 24)            # the original run: 0..288
died_at = rw(WAX_N, 24, 13, 2)[0]                 # index it got to
filled_before = set(range(first_start, died_at))  # what it managed
resumed = rw(WAX_N, 24, 13, 2)
filled_after = set(range(*resumed))
check('no well is filled twice', not (filled_before & filled_after),
      f'overlap={len(filled_before & filled_after)}')
check('no well is missed', filled_before | filled_after == set(range(288)),
      f'missing={len(set(range(288)) - (filled_before | filled_after))}')
check('  (the well that was mid-dispense IS re-done, which is what we want)',
      died_at in filled_after)

print('\n6. round-trip: the breadcrumb the protocol emits must name the well you resume at')
# The protocols emit, AFTER each dispense:
#   FILL PROGRESS: group=<g> cartridge=<abs_i // wells_on_cart + 1> hole=<abs_i % wells_on_cart + 1>
# BIMS reads the LAST one and feeds cartridge/hole straight back in as the resume point.
# So breadcrumb(i) -> resume_window(...) must land back on exactly well i.
for n_wells, label in ((288, 'wax'), (72, 'reagent well_2')):
    per = n_wells // 24
    bad = []
    for i in range(n_wells):
        cart = i // per + 1          # what the protocol prints
        hole = i % per + 1
        start, _end = rw(n_wells, 24, cart, hole)   # what BIMS feeds back
        if start != i:
            bad.append((i, cart, hole, start))
    check(f'{label}: all {n_wells} breadcrumbs round-trip to their own index',
          not bad, f'{len(bad)} mismatched, e.g. {bad[:2]}' if bad else '')

print('\n%s\n' % ('ALL PASS' if not fails else '%d FAILURE(S)' % len(fails)))
sys.exit(1 if fails else 0)
