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


class FakePi:
    """The arm Pi's /ot2/loop/instruction and /ot2/loop/announce, in memory."""

    def __init__(self, clock, fail=False):
        self.clock = clock
        self.rec = None
        self.fail = fail
        self.calls = []
        self.announced = []

    def __call__(self, method, url, body=None, timeout_s=5.0):
        self.calls.append((method, url))
        if self.fail:
            raise OSError('connection refused')
        if '/ot2/loop/announce' in url:
            self.announced.append((body['kind'], body['cart']))
            return 200, {'ok': True}
        m = re.search(r'loop=([^&]+)&after=(-?\d+)&wait_s=([\d.]+)', url)
        loop, after, wait = m.group(1), int(m.group(2)), float(m.group(3))
        r = self.rec
        if r and r['loop'] == loop and r['seq'] > after:
            return 200, dict(r)
        self.clock.sleep(wait)
        return 204, None


def check_reader_pi(m, label):
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, 'arm_loop.json')
        clock = FakeClock()
        pi = FakePi(clock)
        write(path, {'seq': 0, 'loop': 'L2', 'action': 'start', 'run_id': 'run-9', 'arm_pi_urls': ['http://pi-a:8000/', 'http://pi-b:8000']})
        r = m.ArmLoopInstructions(path=path, sleep=clock.sleep, clock=clock.now, http=pi)
        rec = r.start()
        assert r.loop == 'L2' and r.run_id == 'run-9' and r.urls == ['http://pi-a:8000', 'http://pi-b:8000'], r.urls

        # The Pi's record is taken without touching the file; stale seq on the Pi is not.
        pi.rec = {'seq': 1, 'loop': 'L2', 'cart': 1, 'action': 'scan', 'barcode': None}
        rec = r.next()
        assert rec['action'] == 'scan' and r.seen_seq == 1 and r.served_by == 'http://pi-a:8000'
        assert pi.calls[-1][1].startswith('http://pi-a:8000/ot2/loop/instruction?loop=L2&after=0&wait_s=5.0')
        t0 = clock.now()
        assert r.next(timeout_s=12.0) is None
        assert 12.0 <= clock.now() - t0 < 20.0, 'long-polls the Pi, no file spin'

        # A foreign loop on the Pi is ignored; the file still works beside the Pi.
        pi.rec = {'seq': 5, 'loop': 'OTHER', 'cart': 1, 'action': 'fill'}
        write(path, {'seq': 2, 'loop': 'L2', 'cart': 1, 'action': 'fill', 'barcode': 'abcd'})
        rec = r.next(timeout_s=10.0)
        assert rec['action'] == 'fill' and rec['barcode'] == 'abcd' and r.served_by == 'file'

        # Announcements: best effort, to the first live Pi.
        assert r.announce('PARKED', 2) is True and pi.announced[-1] == ('PARKED', 2)

        # A Pi that fails is backed off; the file carries on at the poll cadence; the Pi is retried later.
        pi.fail = True
        write(path, {'seq': 3, 'loop': 'L2', 'cart': 2, 'action': 'skip'})
        n_calls = len(pi.calls)
        rec = r.next(timeout_s=10.0)
        assert rec['action'] == 'skip' and r.served_by == 'file'
        assert len(pi.calls) == n_calls + 2, 'both URLs tried once, then backed off'
        assert r.announce('AT_SCAN', 2) is False
        t0 = clock.now()
        assert r.next(timeout_s=3.0) is None
        assert clock.now() - t0 >= 3.0
        pi.fail = False
        clock.sleep(m.ARM_LOOP_HTTP_BACKOFF_S)
        pi.rec = {'seq': 4, 'loop': 'L2', 'cart': 3, 'action': 'end', 'barcode': None}
        rec = r.next()
        assert rec['action'] == 'end' and r.served_by == 'http://pi-a:8000'

        # Without a URL list in the start record the default cable address is used.
        write(path, {'seq': 0, 'loop': 'L3', 'action': 'start'})
        r2 = m.ArmLoopInstructions(path=path, sleep=clock.sleep, clock=clock.now, http=FakePi(clock, fail=True))
        r2.start()
        assert r2.urls == list(m.ARM_PI_URLS)
    print(f'ok: {label} instruction reader over the Pi')


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
    assert "arm_pause(f'ARM PARKED {cart_index}')" in src
    assert "arm_pause(f'ARM AT_SCAN {cart}')" in src
    assert "arm_pause(f'ARM NO_INSTRUCTION {cart_index}')" in src
    assert "protocol.comment(f'ARM CART {cart_index} FILLED {barcode}')" in src
    assert "protocol.comment(f'ARM CART {cart} SKIPPED')" in src
    assert "arm_mark('ARM LOOP END')" in src
    # 2026-10-30: the loop's probe announces itself (the first grab may start there) - once, by the loop only.
    assert "pick_up_and_calibrate_tip(announce='ARM PROBING')" in src
    assert src.count("pick_up_and_calibrate_tip(announce=") == 1
    assert "arm_mark('ARM CALIBRATED')" in src
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
    assert "arm_mark('ARM CALIBRATED')" in src
    i_probe = src.index("        adjust = pick_up_and_calibrate_tip(announce='ARM PROBING')")
    i_calibrated = src.index("arm_mark('ARM CALIBRATED')")
    i_parked = src.index('        holding = park_for(cart, source_volume, 0)\n')
    i_loop = src.index('        while True:\n            rec = next_instruction(cart)')
    assert i_probe < i_calibrated < i_parked < i_loop, 'order: probe, ARM CALIBRATED, aspirate + park (PARKED 1), loop'
    # 'ARM CLEAR <i>' is emitted only after the planned move to the tube top has
    # completed: in park_for (fill / skip) and in finish (end), and nowhere else.
    assert src.count("arm_mark(f'ARM CLEAR {clear_of}')") == 2
    for fn in ('def park_for(', 'def finish('):
        body = src[src.index(fn):]
        body = body[:body.index('\n        def ') if '\n        def ' in body else len(body)]
        i_tube = body.index('pipette.move_to(source_well.top())')
        i_clear = body.index("arm_mark(f'ARM CLEAR {clear_of}')")
        assert i_tube < i_clear, fn + ': CLEAR must follow the move to the tube'
    # 'ARM FILLED <i>' (2026-11-05): once per cart in fill_cart, right after the
    # LAST batch's dispense_batch returned (the tip is out of the last hole) and
    # BEFORE the blow-out at the tube — the withdraw may start from it.
    assert src.count("arm_mark(f'ARM FILLED {cart_index}')") == 1
    body = src[src.index('def fill_cart('):]
    body = body[:body.index('\n        # ── Volumes')]
    i_batch = body.index('dispensed_volume, swap_at = dispense_batch(')
    i_filled = body.index("arm_mark(f'ARM FILLED {cart_index}')")
    i_blow = body.index('pipette.blow_out(location=source_well.top())')
    assert i_batch < i_filled < i_blow, 'ARM FILLED: after the last batch, before the blow-out at the tube'
    assert 'if swap_at is None and bi + 1 == len(batches):' in body, 'ARM FILLED only after the final batch'
    assert 'holding = park_for(cart, source_volume, 0, clear_of=filled)' in src
    assert 'holding = park_for(cart, source_volume, holding, clear_of=skipped)' in src
    assert 'finish(holding, clear_of)' in src
    # The lift rule is untouched: the lift hook and the lifts around every station.
    assert 'def _resolve_lift' in src and src.count('lift()') >= 14, src.count('lift()')
    # Analysis never touches serial: no probe, baseline zero.
    assert "ser = None" in src and "no X/Y probe (adjust 0, 0)" in src
    # 2026-11-06: every ARM marker is one of arm_mark (comment + announce to the arm
    # Pi) / arm_pause (announce + waitForResume); the comment / pause text is unchanged.
    assert 'def arm_mark(text):' in src and 'def arm_pause(text):' in src
    assert "protocol.comment(text)" in src and "protocol.pause(text)" in src
    assert "arm_mark(announce)" in src and "protocol.comment(announce)" not in src
    for bare in ("protocol.pause(f'ARM ", "protocol.comment('ARM CALIBRATED')", "protocol.comment(f'ARM CLEAR", "protocol.comment(f'ARM FILLED", "protocol.comment('ARM LOOP END')"):
        assert bare not in src, bare + ' must go through arm_mark / arm_pause'
    assert m.ARM_PI_URLS == ('http://169.254.42.1:8000',) and m.ARM_LOOP_HTTP_WAIT_S == 5.0
    print(f'ok: {label} loop surface')


def main():
    mods = {k: load(v, 'arm_loop_' + k) for k, v in FILES.items()}
    srcs = {k: open(v, encoding='utf-8').read() for k, v in FILES.items()}
    for k in FILES:
        check_reader(mods[k], k)
        check_reader_pi(mods[k], k)
        check_surface(mods[k], srcs[k], k)
    # The rehearsal mirrors production: same instruction class source.
    def class_src(s):
        m = re.search(r'class ArmLoopInstructions:.*?\n(?=\n\n)', s, re.S)
        return m.group(0)
    assert class_src(srcs['production']) == class_src(srcs['rehearsal'])
    print('ok: ARM-WAX-LOOP-B protocol surface (production = rehearsal)')


if __name__ == '__main__':
    main()
