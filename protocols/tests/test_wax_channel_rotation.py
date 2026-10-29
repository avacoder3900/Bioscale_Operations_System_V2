"""Unit test for channel_pattern_of_row in the wax and reagent carriage protocols.

Cartridges alternate 180 degrees in the carriage, so a single-channel fill must
pick a different row on even and odd cartridges. opentrons/serial are stubbed;
run() is never called.

    python -I protocols/tests/test_wax_channel_rotation.py
"""
import importlib.util
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


def load_protocol(file_name='Wax_Filling_GEN7_Cartridge.py'):
    _stub('serial', Serial=object, SerialException=Exception)
    ot = _stub('opentrons')
    _stub('opentrons.protocol_api', Parameters=object, ProtocolContext=object, OFF_DECK=object())
    _stub('opentrons.types', Location=object, Point=object)
    ot.protocol_api = sys.modules['opentrons.protocol_api']
    ot.types = sys.modules['opentrons.types']
    spec = importlib.util.spec_from_file_location('wax_cart', os.path.join(ROOT, file_name))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    m = load_protocol()
    rows = m.CARRIAGE_ROWS
    assert len(rows) == 24 and rows[0] == 'X' and rows[-1] == 'A'

    def rows_for(pattern):
        return [r for r in rows if m.channel_pattern_of_row(r) == pattern]

    # Channel A (pattern 2): bottom row of cart 1, top row of cart 2, alternating.
    assert rows_for(2) == ['V', 'U', 'P', 'O', 'J', 'I', 'D', 'C'], rows_for(2)
    # Channel C (pattern 0): the mirror image.
    assert rows_for(0) == ['X', 'S', 'R', 'M', 'L', 'G', 'F', 'A'], rows_for(0)
    # Channel B (pattern 1): always the middle row - unchanged by the rotation.
    assert rows_for(1) == ['W', 'T', 'Q', 'N', 'K', 'H', 'E', 'B'], rows_for(1)

    # Exactly one row per cartridge per channel, so the 24 equal-block layout
    # resume_window() relies on still holds for a single-channel run.
    for p in (0, 1, 2):
        carts = [rows.index(r) // 3 for r in rows_for(p)]
        assert carts == list(range(8)), (p, carts)

    # Reagent: same rule, and the serpentine column order (col 15 runs A -> X)
    # keeps one row per cartridge on the right channel.
    r = load_protocol('Reagent_Filling_GEN7.py')
    assert r.CARRIAGE_ROWS == rows
    for row in rows:
        assert r.channel_pattern_of_row(row) == m.channel_pattern_of_row(row), row
    down = list('XWVUTSRQPONMLKJIHGFEDCBA')
    assert r.channel_rows(down, 2) == ['V', 'U', 'P', 'O', 'J', 'I', 'D', 'C']
    assert r.channel_rows(down[::-1], 2) == ['C', 'D', 'I', 'J', 'O', 'P', 'U', 'V']
    assert r.channel_rows(down, 0) == ['X', 'S', 'R', 'M', 'L', 'G', 'F', 'A']
    assert r.channel_rows(down, 1) == ['W', 'T', 'Q', 'N', 'K', 'H', 'E', 'B']
    print('ok: channel_pattern_of_row honours the 180-degree cartridge alternation (wax + reagent)')


if __name__ == '__main__':
    main()
