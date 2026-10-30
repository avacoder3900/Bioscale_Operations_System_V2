"""ARM-WAX-LOOP-B: the instruction reader and the loop surface of both stage
protocols (docs/prds/ARM-WAX-LOOP-B-ONE-RUN-PER-LOOP.md §5), without opentrons.

    python -I protocols/tests/test_arm_stage_loop.py
"""
import importlib.util
import json
import os
import re
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = {
    'production': os.path.join(ROOT, 'Wax_Filling_GEN7_ArmStage.py'),
    'rehearsal': os.path.join(ROOT, 'Wax_Filling_GEN7_ArmStage_Rehearsal_p300.py'),
}


def _stub(name, **attrs):
    m = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    sys.modules[name] = m
    return m


class _Params:
    def __init__(self):
        self.names = []
        self.by_name = {}

    def _add(self, **kw):
        self.names.append(kw['variable_name'])
        self.by_name[kw['variable_name']] = kw

    add_int = add_float = add_bool = add_str = _add


def load(path, modname):
    _stub('serial', Serial=object, SerialException=Exception)
    ot = _stub('opentrons')
    _stub('opentrons.protocol_api', Parameters=object, ProtocolContext=object, OFF_DECK=object())
    _stub('opentrons.types', Location=object, Point=object)
    ot.protocol_api = sys.modules['opentrons.protocol_api']
    ot.types = sys.modules['opentrons.types']
    spec = importlib.util.spec_from_file_location(modname, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def now(self):
        return self.t

    def sleep(self, s):
        self.t += s


def write(path, rec):
    with open(path, 'w') as f:
        json.dump(rec, f)


def check_reader(m, label):
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, 'arm_loop.json')
        clock = FakeClock()

        # start record required
        r = m.ArmLoopInstructions(path=path, sleep=clock.sleep, clock=clock.now)
        try:
            r.start()
            raise AssertionError('start() accepted a missing file')
        except RuntimeError as e:
            assert 'no start record' in str(e), e
        write(path, {'seq': 1, 'loop': 'L1', 'cart': 1, 'action': 'scan'})
        try:
            r.start()
            raise AssertionError('start() accepted a non-start record')
        except RuntimeError:
            pass
        write(path, {'seq': 0, 'loop': 'L1', 'action': 'start'})
        rec = r.start()
        assert rec['action'] == 'start' and r.loop == 'L1' and r.seen_seq == 0

        # a fresh record is consumed once
        write(path, {'seq': 1, 'loop': 'L1', 'cart': 1, 'action': 'scan', 'barcode': None})
        rec = r.next()
        assert rec['action'] == 'scan' and r.seen_seq == 1

        # the same (stale) record again → nothing within the timeout (polls, no busy spin)
        t0 = clock.now()
        assert r.next(timeout_s=5.0) is None
        assert clock.now() - t0 >= 5.0

        # a foreign loop's record is ignored even with a higher seq
        write(path, {'seq': 9, 'loop': 'OTHER', 'cart': 1, 'action': 'fill'})
        assert r.next(timeout_s=1.0) is None and r.seen_seq == 1

        # an unknown action is ignored; a lower seq is ignored
        write(path, {'seq': 7, 'loop': 'L1', 'cart': 1, 'action': 'dance'})
        assert r.next(timeout_s=1.0) is None
        write(path, {'seq': 0, 'loop': 'L1', 'cart': 1, 'action': 'fill'})
        assert r.next(timeout_s=1.0) is None

        # the next fresh one is taken, with its barcode
        write(path, {'seq': 2, 'loop': 'L1', 'cart': 1, 'action': 'fill', 'barcode': 'f4bb'})
        rec = r.next()
        assert rec['action'] == 'fill' and rec['barcode'] == 'f4bb' and r.seen_seq == 2

        # a record that arrives DURING the wait is picked up
        writes = {'n': 0}
        real_sleep = clock.sleep

        def sleep_then_write(s):
            real_sleep(s)
            writes['n'] += 1
            if writes['n'] == 3:
                write(path, {'seq': 3, 'loop': 'L1', 'cart': 2, 'action': 'end'})

        r._sleep = sleep_then_write
        rec = r.next(timeout_s=10.0)
        assert rec['action'] == 'end' and r.seen_seq == 3

        # the path and the constants
        assert m.ARM_LOOP_FILE == '/data/arm_loop.json'
        assert m.ARM_LOOP_ACTIONS == ('scan', 'fill', 'skip', 'end')
        assert m.ARM_LOOP_POLL_S == 0.5 and m.ARM_LOOP_WAIT_S == 60.0

    # simulation: synthesised scan, fill per cart, then end — no file read
    sim = m.ArmLoopInstructions(path='/nonexistent/arm_loop.json', simulate=True, cartridges=2)
    assert sim.start()['action'] == 'start' and sim.loop == 'sim'
    seq = [(sim.next()['cart'], sim.next()['action']) for _ in range(0)]  # noqa (shape check below)
    got = []
    while True:
        rec = sim.next()
        got.append((rec['cart'], rec['action']))
        if rec['action'] == 'end':
            break
    assert got == [(1, 'scan'), (1, 'fill'), (2, 'scan'), (2, 'fill'), (3, 'end')], got
    assert sim.next()['action'] == 'end', 'after the end, every further record is end'
    print(f'ok: {label} instruction reader')


def check_surface(m, src, label):
    # RTPs: the loop's cart count and the scan position, with the contract's bounds.
    p = _Params()
    m.add_parameters(p)
    c = p.by_name['cartridges']
    assert (c['default'], c['minimum'], c['maximum']) == (1, 1, 24), c
    for ax, mx in (('x', 400.0), ('y', 400.0), ('z', 250.0)):
        s = p.by_name['arm_scan_' + ax]
        assert (s['default'], s['minimum'], s['maximum']) == (0.0, 0.0, mx), s
    assert m.MIN_TAUGHT_MM == 1.0 and m.SIM_CART[2] > 0 and m.SIM_SCAN[2] > 0

    # The pause messages and comments, exactly as the contract names them.
    assert "protocol.pause(f'ARM PARKED {cart_index}')" in src
    assert "protocol.pause(f'ARM AT_SCAN {cart}')" in src
    assert "protocol.pause(f'ARM NO_INSTRUCTION {cart_index}')" in src
    assert "protocol.comment(f'ARM CART {cart_index} FILLED {barcode}')" in src
    assert "protocol.comment(f'ARM CART {cart} SKIPPED')" in src
    assert "protocol.comment('ARM LOOP END')" in src
    # 2026-10-30: the loop's probe announces itself (the first grab may start there) - once, by the loop only.
    assert "pick_up_and_calibrate_tip(announce='ARM PROBING')" in src
    assert src.count("pick_up_and_calibrate_tip(announce=") == 1
    assert "protocol.comment('ARM CALIBRATED')" in src
    assert "raise RuntimeError('ARM LOOP: no start record in /data/arm_loop.json')" in src

    # One tip for the loop: the only drop_tip sites are the probe's own retry
    # (fresh tip when a probe is rejected), the optional calibration check and the end.
    drops = [ln for ln in src.splitlines() if 'pipette.drop_tip()' in ln]
    assert len(drops) == 4, drops
    assert 'def fill_cart(' in src and 'def park(' in src and 'def park_for(' in src and 'def finish(' in src
    assert 'def dispense_stage(' not in src, 'the per-cart dispense_stage is gone'
    # The untaught scan position is refused before motion, like the cart.
    assert "arm_scan_x/y/z are not set (0)" in src
    # The scan move is tip-aware: arm_scan_z is the NOZZLE height (taught with no
    # tip); with the loop's tip on, the tip-end target is lowered by the rack's
    # tip length (2026-10-30: asking for the tip end at the nozzle height failed the run).
    assert 'target_z = max(MIN_TAUGHT_MM, scan_z - tip_len)' in src and 'tiprack.tip_length' in src
    assert "ARM SCAN: nozzle at z=" in src
    assert 'taught with NO tip' in p.by_name['arm_scan_z']['description']
    # Start-up (2026-10-30, Alejandro's overlap): ONE tip picked up and PROBED at
    # start-up, then 'ARM CALIBRATED' (the arm may grab from here), then the tube
    # (aspirate + park) and 'ARM PARKED 1'. No probe anywhere in the fill branch.
    assert 'pick_up_tip_for_loop' not in src and 'adjust is None' not in src
    assert 'adjust = pick_up_and_calibrate_tip(pick_up=False)' not in src, 'no deferred probe (the tip-swap re-probe is the only pick_up=False)'
    assert src.count('= pick_up_and_calibrate_tip(') == 2, 'the optional calibration check + the loop start-up (which announces ARM PROBING)'
    assert "protocol.comment('ARM CALIBRATED')" in src
    i_probe = src.index("        adjust = pick_up_and_calibrate_tip(announce='ARM PROBING')")
    i_calibrated = src.index("protocol.comment('ARM CALIBRATED')")
    i_parked = src.index('        holding = park_for(cart, source_volume, 0)\n')
    i_loop = src.index('        while True:\n            rec = next_instruction(cart)')
    assert i_probe < i_calibrated < i_parked < i_loop, 'order: probe, ARM CALIBRATED, aspirate + park (PARKED 1), loop'
    # 'ARM CLEAR <i>' is emitted only after the planned move to the tube top has
    # completed: in park_for (fill / skip) and in finish (end), and nowhere else.
    assert src.count("protocol.comment(f'ARM CLEAR {clear_of}')") == 2
    for fn in ('def park_for(', 'def finish('):
        body = src[src.index(fn):]
        body = body[:body.index('\n        def ') if '\n        def ' in body else len(body)]
        i_tube = body.index('pipette.move_to(source_well.top())')
        i_clear = body.index("protocol.comment(f'ARM CLEAR {clear_of}')")
        assert i_tube < i_clear, fn + ': CLEAR must follow the move to the tube'
    assert 'holding = park_for(cart, source_volume, 0, clear_of=filled)' in src
    assert 'holding = park_for(cart, source_volume, holding, clear_of=skipped)' in src
    assert 'finish(holding, clear_of)' in src
    # The lift rule is untouched: the lift hook and the lifts around every station.
    assert 'def _resolve_lift' in src and src.count('lift()') >= 14, src.count('lift()')
    # Analysis never touches serial: no probe, baseline zero.
    assert "ser = None" in src and "no X/Y probe (adjust 0, 0)" in src
    print(f'ok: {label} loop surface')


def main():
    mods = {k: load(v, 'arm_loop_' + k) for k, v in FILES.items()}
    srcs = {k: open(v, encoding='utf-8').read() for k, v in FILES.items()}
    for k in FILES:
        check_reader(mods[k], k)
        check_surface(mods[k], srcs[k], k)
    # The rehearsal mirrors production: same instruction class source.
    def class_src(s):
        m = re.search(r'class ArmLoopInstructions:.*?\n(?=\n\n)', s, re.S)
        return m.group(0)
    assert class_src(srcs['production']) == class_src(srcs['rehearsal'])
    print('ok: ARM-WAX-LOOP-B protocol surface (production = rehearsal)')


if __name__ == '__main__':
    main()
