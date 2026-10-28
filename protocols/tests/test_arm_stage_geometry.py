"""Unit test for the pure geometry in protocols/Wax_Filling_GEN7_ArmStage.py.

The protocol imports `opentrons` and `serial`, which are not installed off the
robot, so they are stubbed before the module is loaded; only the module-level
helpers are exercised (run() is never called).

    python -I protocols/tests/test_arm_stage_geometry.py
"""
import importlib.util
import math
import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _stub(name, **attrs):
    m = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    sys.modules[name] = m
    return m


class _Params:
    """Records every add_* call so the RTP surface can be checked without opentrons."""

    def __init__(self):
        self.names = []

    def _add(self, **kw):
        self.names.append(kw['variable_name'])

    add_int = add_float = add_bool = add_str = _add


def load_protocol():
    _stub('serial', Serial=object, SerialException=Exception)
    ot = _stub('opentrons')
    _stub('opentrons.protocol_api', Parameters=object, ProtocolContext=object, OFF_DECK=object())
    _stub('opentrons.types', Location=object, Point=object)
    ot.protocol_api = sys.modules['opentrons.protocol_api']
    ot.types = sys.modules['opentrons.types']
    spec = importlib.util.spec_from_file_location('arm_stage', os.path.join(ROOT, 'Wax_Filling_GEN7_ArmStage.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def close(a, b, tol=1e-6):
    return abs(a - b) <= tol


def main():
    m = load_protocol()
    X0, Y0, Z0 = 200.0, 100.0, 80.0

    # 12 holes, fill order row 1 gates 4->1, then rows 2 and 3 - cartridge 1's names.
    t = m.stage_targets(X0, Y0, Z0)
    assert [n for n, *_ in t] == ['X2', 'X4', 'X6', 'X8', 'W2', 'W4', 'W6', 'W8', 'V2', 'V4', 'V6', 'V8'], t
    # Same pitch as gen4deck_gen7cartridge_001: 6.0 mm along -x per gate, 9.0 mm along -y per row.
    by = {n: (x, y, z) for n, x, y, z in t}
    assert by['X2'] == (X0, Y0, Z0)
    assert close(by['X8'][0], X0 - 18.0) and close(by['X8'][1], Y0)
    assert close(by['V2'][0], X0) and close(by['V2'][1], Y0 - 18.0)
    assert close(by['V8'][0], X0 - 18.0) and close(by['V8'][1], Y0 - 18.0)
    assert all(close(z, Z0) for _, _, _, z in t)
    # Every gate column keeps its gate: 2->4, 4->3, 6->2, 8->1.
    assert {m.COLUMN_GATE[m.get_well_column(n)] for n in ('X2', 'W2', 'V2')} == {'wax_gate4'}
    assert m.COLUMN_GATE[m.get_well_column('X8')] == 'wax_gate1'

    # Turned end for end: gates run toward +x, rows toward +y, first hole fixed.
    r = {n: (x, y) for n, x, y, _ in m.stage_targets(X0, Y0, Z0, 180)}
    assert close(r['X2'][0], X0) and close(r['X2'][1], Y0)
    assert close(r['X8'][0], X0 + 18.0) and close(r['X8'][1], Y0)
    assert close(r['V2'][0], X0) and close(r['V2'][1], Y0 + 18.0)

    # 90 deg CCW: the gate direction (-x) becomes -y; the row direction (-y) becomes +x.
    q = {n: (x, y) for n, x, y, _ in m.stage_targets(X0, Y0, Z0, 90)}
    assert close(q['X8'][0], X0) and close(q['X8'][1], Y0 - 18.0)
    assert close(q['V2'][0], X0 + 18.0) and close(q['V2'][1], Y0)

    # Within-row spacing is the gate pitch whatever the rotation.
    for rot in (0, 37.5, 180, -90):
        pts = {n: (x, y) for n, x, y, _ in m.stage_targets(X0, Y0, Z0, rot)}
        d = math.dist(pts['X2'], pts['X4'])
        assert close(d, 6.0), (rot, d)
        assert close(math.dist(pts['X2'], pts['W2']), 9.0)

    # Per-hole corrections are added AFTER the rotation (same numbers as stage-geometry.test.ts).
    offs = [(0.0, 0.0, 0.0)] * 12
    offs[5] = (0.3, -0.2, 0.1)  # W4 is 6th in fill order
    w = {n: (x, y, z) for n, x, y, z in m.stage_targets(X0, Y0, Z0, 180, offs)}
    assert close(w['W4'][0], X0 + 6.3) and close(w['W4'][1], Y0 + 8.8) and close(w['W4'][2], Z0 + 0.1), w['W4']
    assert close(w['X2'][0], X0) and close(w['X2'][2], Z0)
    assert m.hole_offset_param(6, 'dx') == 'hole_06_dx'

    # The RTP surface: the taught point, rotation, travel height and 36 per-hole corrections.
    p = _Params()
    m.add_parameters(p)
    for name in ('arm_cart_x', 'arm_cart_y', 'arm_cart_z', 'arm_cart_rotation_deg', 'stage_jump_height', 'dispense_depth'):
        assert name in p.names, name
    hole_params = [n for n in p.names if n.startswith('hole_')]
    assert len(hole_params) == 36 and hole_params[0] == 'hole_01_dx' and hole_params[-1] == 'hole_12_dz', hole_params[:3]
    assert len(p.names) == len(set(p.names)), 'duplicate RTP names'

    # The "never taught" floor matches the RTP defaults (0) and nothing plausible.
    assert m.MIN_TAUGHT_MM == 1.0
    print('ok: stage_targets geometry + RTP surface')


if __name__ == '__main__':
    main()
