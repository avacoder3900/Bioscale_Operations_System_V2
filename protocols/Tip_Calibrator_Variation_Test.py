"""Tip-calibrator variation test — DIAGNOSTIC ONLY, fills nothing.

Question this answers: is the per-tip bend calibration load-bearing, or is it noise?

Tips do not sit perfectly straight on the nozzle. The wax fill has to thread a tip into a
1.8mm hole with roughly 0.4mm of side clearance, so if tips wander by more than that from one
pickup to the next, the calibrator is mandatory and taking it out was a mistake. If they don't
wander, the calibrator is measuring nothing and feeding its readings into the fill would only
inject error. Those two conclusions demand opposite actions, so we measure.

Method: pick up a tip, probe it against the calibrator's X and Y limit switches N times WITHOUT
dropping it, return the tip to the rack, repeat with the next tip. Probing each tip repeatedly
is the whole point — it separates two things a single reading per tip cannot:

    spread WITHIN one tip   = the calibrator's own repeatability (measurement noise)
    spread ACROSS tips      = real tip-to-tip variation (what the fill actually suffers)

If between-tip spread is large and within-tip spread is tight, the calibrator is doing real
work. If they are the same size, the calibrator is a random number generator.

The reported number is the raw `shift`: how far the tip travelled (in 0.1mm steps) before it
closed the limit switch. That is the direct measurement of where the tip is. The fill's
`adjust` is just (baseline - shift), and the baseline is constant within a run, so the VARIATION
in shift is exactly the variation the fill sees.

Nothing here goes near a cartridge. The pipette only visits the tiprack and the calibrator.
Tips are RETURNED to the rack, not trashed.

Read the results with: node scripts/tipcal-variation.cjs
"""
import glob
import time

import serial
from opentrons import protocol_api
from opentrons import types

metadata = {
    'author': 'Brevitest',
    'description': 'DIAGNOSTIC: measure tip-to-tip variation reported by the tip calibrator. Fills nothing.',
}

requirements = {"robotType": "OT-2", "apiLevel": "2.19"}

# Emitted after every probe; scripts/tipcal-variation.cjs parses these out of the run log.
BREADCRUMB = 'TIPCAL'


def add_parameters(parameters: protocol_api.Parameters):
    parameters.add_int(
        variable_name="samples",
        display_name="Tips to sample",
        description="How many different tips to measure.",
        default=20, minimum=1, maximum=90, unit="tips")
    parameters.add_int(
        variable_name="probes_per_tip",
        display_name="Probes per tip",
        description="Repeat probes on the SAME tip. Separates calibrator noise from tip spread.",
        default=3, minimum=1, maximum=5, unit="probes")
    parameters.add_int(
        variable_name="start_tip",
        display_name="Start at tip index",
        description="0 = A1. Lets a re-run sample a different part of the rack.",
        default=0, minimum=0, maximum=95)
    # Same calibrator geometry the reagent fill uses (p300 + 200uL tip).
    parameters.add_float(variable_name="cal_x", display_name="Tip-calibrator X",
                         description="Tip-calibrator approach X (carriage frame).",
                         default=125.181, minimum=0.0, maximum=400.0, unit="mm")
    parameters.add_float(variable_name="cal_y", display_name="Tip-calibrator Y",
                         description="Tip-calibrator approach Y (carriage frame).",
                         default=173.247, minimum=0.0, maximum=400.0, unit="mm")
    parameters.add_float(variable_name="z_cal", display_name="Tip-calibrator Z",
                         description="Probe Z (p300 200uL reagent tip).",
                         default=40.8, minimum=0.0, maximum=200.0, unit="mm")


def run(protocol: protocol_api.ProtocolContext):
    samples = protocol.params.samples
    probes_per_tip = protocol.params.probes_per_tip
    start_tip = protocol.params.start_tip
    cal_x = protocol.params.cal_x
    cal_y = protocol.params.cal_y
    z_cal = protocol.params.z_cal

    # Slot layout identical to the reagent fill, so the gantry arcs over the same things it
    # would during a real run. The tube rack is loaded but never touched.
    tuberack = protocol.load_labware('custom_2ml_24_tube_rack', 10)
    tiprack = protocol.load_labware('cosmas_and_damian_biotix_96_200ul_tiprack', 11)
    pipette = protocol.load_instrument('p300_single_gen2', mount='left', tip_racks=[tiprack])

    carriages = {
        'e00fce68981a5e0784a62b71': protocol.load_labware('gen4deck_gen7cartridge_001', protocol_api.OFF_DECK),
        'e00fce680fde2dcc48014df0': protocol.load_labware('gen4deck_gen7cartridge_002', protocol_api.OFF_DECK),
        'e00fce68fc3b723490857c78': protocol.load_labware('gen4deck_gen7cartridge_003', protocol_api.OFF_DECK),
        'e00fce680a100a70d1fea1a3': protocol.load_labware('gen4deck_gen7cartridge_004', protocol_api.OFF_DECK),
    }

    # ── Serial helpers: copied from Reagent_Filling_GEN7 so the handshake is identical ──
    def serial_read_with_retry(ser, max_retries=3, timeout=0.5):
        original_timeout = ser.timeout
        ser.timeout = timeout
        try:
            for attempt in range(max_retries):
                try:
                    data = ser.readline()
                    if data:
                        return data
                except serial.SerialException:
                    if attempt >= max_retries - 1:
                        raise
                    time.sleep(0.05)
            raise serial.SerialException('Failed to read from serial port')
        finally:
            ser.timeout = original_timeout

    def serial_write_with_retry(ser, data, max_retries=3):
        for attempt in range(max_retries):
            try:
                ser.reset_output_buffer()
                ser.write(data)
                ser.flush()
                time.sleep(0.05)
                return True
            except serial.SerialException:
                if attempt >= max_retries - 1:
                    raise
                time.sleep(0.1)
        return False

    import os as _os_cal

    def _probe_for_calibrator():
        # Skip the barcode scanner — it also enumerates as /dev/ttyACM* and never answers 'C'.
        _scanner_real = _os_cal.path.realpath('/dev/scanner') if _os_cal.path.exists('/dev/scanner') else None
        for port in sorted(glob.glob('/dev/ttyACM*')):
            _s = None
            try:
                if _scanner_real and _os_cal.path.realpath(port) == _scanner_real:
                    continue
                _s = serial.Serial(port=port, baudrate=115200, timeout=0.5)
                time.sleep(0.2)
                _s.reset_input_buffer()
                _s.reset_output_buffer()
                _s.write(b'C')
                _s.flush()
                time.sleep(0.3)
                if b':' in (_s.readline() or b''):
                    _s.reset_input_buffer()
                    protocol.comment(f'Calibrator found on serial port: {port}')
                    return _s
                _s.close()
            except Exception:
                try:
                    if _s and _s.is_open:
                        _s.close()
                except Exception:
                    pass
        return None

    def _find_calibrator(wait_s=25):
        _deadline = time.time() + wait_s
        while True:
            _s = _probe_for_calibrator()
            if _s is not None:
                return _s
            if time.time() >= _deadline:
                return None
            time.sleep(1.5)

    if protocol.is_simulating():
        # Analysis pass — no hardware. Bail before any serial/motion so the upload analyses.
        protocol.comment('Simulation: skipping calibrator probe.')
        return

    ser = _find_calibrator()
    while not ser or not ser.is_open:
        protocol.pause('Tip calibrator not found. Check its USB, then Resume to retry.')
        ser = _find_calibrator(wait_s=8)

    # Which carriage is on the deck — the calibrator fixture sits ON it, so its labware has to
    # be loaded for the probe coordinates (carriage frame) to mean anything.
    carriage = None
    while carriage is None:
        try:
            serial_write_with_retry(ser, b'I')
            particle_id = serial_read_with_retry(ser).decode('utf-8', errors='ignore').strip()[:24]
            if particle_id not in carriages:
                raise ValueError(f'Unknown particle ID: {particle_id}')
            carriage = carriages[particle_id]
        except Exception as e:
            protocol.pause(f'Could not read the deck/particle ID ({e}). Resume to retry.')
    protocol.move_labware(labware=carriage, new_location=1)
    protocol.comment(f'Loaded carriage for particle ID: {particle_id}')

    def probe_once():
        """Drive the tip against the X then Y limit switch. Returns the raw shifts in mm.

        `shift` is how far the tip had to travel before it closed the switch — i.e. where the
        tip actually is. Resolution is the 0.1mm step. Returns None for an axis that never
        triggered within 5mm (a miss, which is itself a finding).
        """
        pipette.move_to(types.Location(types.Point(x=cal_x, y=cal_y, z=z_cal), carriage), speed=None)

        # ---- X ----
        x_pos = cal_x - 1.4
        y_pos = cal_y - 7.0
        pipette.move_to(types.Location(types.Point(x=x_pos, y=y_pos, z=z_cal), carriage),
                        force_direct=True, speed=20)
        serial_write_with_retry(ser, b'X')
        limit_reached = False
        shift = 0.1
        shift_x = None
        while not limit_reached:
            pipette.move_to(types.Location(types.Point(x=x_pos - shift, y=y_pos, z=z_cal), carriage),
                            force_direct=True, speed=5)
            shift += 0.1
            if shift > 5:
                break
            original_timeout = ser.timeout
            ser.timeout = 0.01
            try:
                limit_reached = ser.read(1) == b'X'
            finally:
                ser.timeout = original_timeout
        if limit_reached:
            shift_x = round(shift, 1)

        # ---- Y ----
        x_pos = cal_x + 8.829
        y_pos = cal_y - 7.5
        pipette.move_to(types.Location(types.Point(x=x_pos, y=y_pos, z=z_cal), carriage),
                        force_direct=True, speed=20)
        serial_write_with_retry(ser, b'Y')
        limit_reached = False
        shift = 0.1
        shift_y = None
        while not limit_reached:
            pipette.move_to(types.Location(types.Point(x=x_pos, y=y_pos - shift, z=z_cal), carriage),
                            force_direct=True, speed=5)
            shift += 0.1
            if shift > 5:
                break
            original_timeout = ser.timeout
            ser.timeout = 0.01
            try:
                limit_reached = ser.read(1) == b'Y'
            finally:
                ser.timeout = original_timeout
        if limit_reached:
            shift_y = round(shift, 1)

        # Retreat straight up before the next pickup/probe.
        pipette.move_to(types.Location(types.Point(x=cal_x, y=cal_y, z=z_cal), carriage),
                        force_direct=True, speed=20)
        pipette.move_to(types.Location(types.Point(x=cal_x, y=cal_y, z=z_cal + 20), carriage),
                        force_direct=True, speed=20)
        return shift_x, shift_y

    all_tips = tiprack.wells()
    protocol.comment(f'{BREADCRUMB} START samples={samples} probes_per_tip={probes_per_tip} '
                     f'start_tip={start_tip} pipette=p300_single_gen2 mount=left')

    for i in range(samples):
        idx = start_tip + i
        if idx >= len(all_tips):
            protocol.comment(f'{BREADCRUMB} rack exhausted at index {idx} — stopping early.')
            break
        tip = all_tips[idx]

        if pipette.has_tip:
            pipette.drop_tip()
        pipette.pick_up_tip(tip)

        for rep in range(probes_per_tip):
            sx, sy = probe_once()
            protocol.comment(
                f'{BREADCRUMB} SAMPLE tip={tip.well_name} idx={idx} rep={rep} '
                f'shift_x={"MISS" if sx is None else f"{sx:.1f}"} '
                f'shift_y={"MISS" if sy is None else f"{sy:.1f}"}')

        # Back in the rack, not the trash — 20 tips is 20 tips.
        pipette.return_tip()

    protocol.comment(f'{BREADCRUMB} DONE')
    try:
        ser.close()
    except Exception:
        pass
