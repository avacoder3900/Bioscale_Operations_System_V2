"""Unit test for protocols/Wax_Filling_GEN7_ArmStage_Rehearsal_p300.py.

The rehearsal must walk the SAME cart as the production stage protocol: same
geometry, same taught-cart and per-hole RTPs (so BIMS's cycleFill drives it
unchanged), but on the p300 / 200 uL rack with air volumes the p300 accepts,
and WITHOUT the p20's z_cal (BIMS would inject the wax probe depth into it).

    python -I protocols/tests/test_arm_stage_rehearsal_p300.py
"""
import importlib.util
import os
import re
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRODUCTION = os.path.join(ROOT, 'Wax_Filling_GEN7_ArmStage.py')
REHEARSAL = os.path.join(ROOT, 'Wax_Filling_GEN7_ArmStage_Rehearsal_p300.py')


def _stub(name, **attrs):
    m = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    sys.modules[name] = m
    return m


class _Params:
    """Records every add_* call (name + kwargs) so the RTP surface can be checked without opentrons."""

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


def close(a, b, tol=1e-6):
    return abs(a - b) <= tol


def main():
    prod = load(PRODUCTION, 'arm_stage_prod')
    reh = load(REHEARSAL, 'arm_stage_rehearsal')
    src = open(REHEARSAL, encoding='utf-8').read()

    # ── Same cart: geometry is identical to the production stage protocol ───
    offs = [(0.0, 0.0, 0.0)] * 12
    offs[5] = (0.3, -0.2, 0.1)
    for rot in (0, 90, 180, -90, 37.5):
        a = prod.stage_targets(200.0, 100.0, 80.0, rot, offs)
        b = reh.stage_targets(200.0, 100.0, 80.0, rot, offs)
        assert [n for n, *_ in a] == [n for n, *_ in b], rot
        for (_, ax, ay, az), (_, bx, by, bz) in zip(a, b):
            assert close(ax, bx) and close(ay, by) and close(az, bz), rot
    assert reh.STAGE_WELL_NAMES == prod.STAGE_WELL_NAMES
    assert reh.COLUMN_GATE == prod.COLUMN_GATE
    assert reh.MIN_TAUGHT_MM == prod.MIN_TAUGHT_MM
    assert reh.hole_offset_param(6, 'dx') == prod.hole_offset_param(6, 'dx') == 'hole_06_dx'

    # ── Same RTP surface for everything BIMS's cycleFill sends ──────────────
    p = _Params()
    reh.add_parameters(p)
    q = _Params()
    prod.add_parameters(q)
    assert len(p.names) == len(set(p.names)), 'duplicate RTP names'
    for name in ('arm_cart_x', 'arm_cart_y', 'arm_cart_z', 'arm_cart_rotation_deg', 'dispense_depth',
                 'use_tip_calibration', 'max_tip_adjust', 'run_calibration_check', 'tiprack_refilled',
                 'bims_native', 'offset_x', 'offset_y', 'offset_z', 'cal_x', 'cal_y', 'aspirate_remainder',
                 'vol_gate4', 'vol_gate3', 'vol_gate2', 'vol_gate1', 'wax', 'min_tip_clearance'):
        assert name in p.names, name
        assert name in q.names, 'production lost ' + name
    hole_params = [n for n in p.names if n.startswith('hole_')]
    assert hole_params == [n for n in q.names if n.startswith('hole_')]
    assert len(hole_params) == 36 and hole_params[0] == 'hole_01_dx' and hole_params[-1] == 'hole_12_dz'
    # The taught-cart RTPs keep the production bounds (BIMS validates against them).
    for name in ('arm_cart_x', 'arm_cart_y', 'arm_cart_z', 'arm_cart_rotation_deg', 'dispense_depth', 'cal_x', 'cal_y'):
        for k in ('default', 'minimum', 'maximum'):
            assert p.by_name[name][k] == q.by_name[name][k], (name, k)

    # ── The p300 differences ───────────────────────────────────────────────
    # No z_cal: BIMS injects the p20 probe depth into that name for the wax process.
    assert 'z_cal' not in p.names
    assert 'z_cal_p300' in p.names and p.by_name['z_cal_p300']['default'] == 40.8
    # No travel-height RTP: the lift rule (Z-only home) replaces it.
    assert 'stage_jump_height' not in p.names
    # Which mount carries the p300.
    pm = p.by_name['pipette_mount']
    assert pm['default'] == 'left' and {c['value'] for c in pm['choices']} == {'left', 'right'}
    # Air volumes the p300 can actually move: never below its 20 uL minimum.
    for g in ('vol_gate4', 'vol_gate3', 'vol_gate2', 'vol_gate1'):
        assert p.by_name[g]['minimum'] >= 20.0 and p.by_name[g]['default'] >= 20.0, g
    assert p.by_name['aspirate_remainder']['maximum'] <= reh.REHEARSAL_MAX_PER_ASPIRATION_UL - 4 * 20.0, \
        'a full row of air must still fit in one trip at the maximum remainder'
    assert reh.REHEARSAL_MIN_VOLUME_UL == 20.0
    assert reh.REHEARSAL_MAX_PER_ASPIRATION_UL == 200 and reh.REHEARSAL_TIP_CAPACITY_UL == 210

    # ── Hardware: the p300 on the 200 uL rack, never the p20 ───────────────
    assert reh.REHEARSAL_PIPETTE == 'p300_single_gen2'
    assert reh.REHEARSAL_TIPRACK == 'cosmas_and_damian_biotix_96_200ul_tiprack'
    assert "load_instrument(REHEARSAL_PIPETTE" in src
    assert "load_labware(REHEARSAL_TIPRACK, 11)" in src
    assert 'p20_single_gen2' not in src.replace("Wax_Filling_GEN7_ArmStage.py", ''), 'the rehearsal must not load the p20'
    assert 'cosmasanddamian_96_tiprack_20ul' not in src
    # The 200 uL rack's tip tracker is the reagent line's, not the wax p20's.
    assert "tip_tracker_reagent_" in src and "tip_tracker_{hostname}" not in src
    # The p20 recipe's 0.25 uL drip-back cannot run on a p300.
    assert 'dispense(.25' not in src and 'dispense(0.25' not in src
    # Probe: the reagent approach offsets, and the p300 probe depth everywhere.
    assert 'cal_x - 1.4' in src and 'cal_y - 7.0' in src
    assert 'params.z_cal_p300' in src and not re.search(r'params\.z_cal\b', src)
    # The lift rule is in force, the same hook as the production arm line.
    assert 'def _resolve_lift' in src and src.count('lift()') >= 12, src.count('lift()')
    # No explicit travel height anywhere: neither the RTP nor the planned-arc minimum the pre-lift stage fill used.
    assert 'stage_jump_height' not in src and 'minimum_z_height=tz' not in src

    print('ok: rehearsal p300 protocol = production stage cart + p300 air volumes')


if __name__ == '__main__':
    main()
