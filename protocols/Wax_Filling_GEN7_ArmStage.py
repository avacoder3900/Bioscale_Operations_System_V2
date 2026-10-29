import math
import string
import serial
import glob
from opentrons import protocol_api
from opentrons import types
import collections
import bisect
import time

# Wax_Filling_GEN7_ArmStage — ONE cartridge on the robot-arm's elevated stage.
#
# Variant of Wax_Filling_GEN7_Cartridge.py for the robot-arm wax fill line
# (BIMS /manufacturing/cart-mfg/robot-arm/wax-fill). There the arm sets a
# single cart on a raised single-cart platform — not on a 24-slot carriage —
# so there is no deck labware, no Particle id to read and no deck position.
# Instead BIMS sends the TAUGHT location of the cart's first wax hole as
# run-time parameters (arm_cart_x / arm_cart_y / arm_cart_z, deck frame, mm)
# and this protocol lays the cartridge's 12 wax holes out from it using the
# cartridge's own geometry (the same pitch the deck definitions carry).
#
# Everything about HOW a hole is filled — tip tracking, the per-tip calibrator
# probe, the aspirate height model, gate volumes, dispense depth, the mid-run
# tip swap — is carried over from the carriage protocol unchanged, so a cart
# filled here is filled the same way as one on a deck.
#
# TEACHING CONVENTION (the BIMS page enforces it): the cart location is TIP-
# NEUTRAL, exactly like the deck holes taught in the Deck Calibration Studio.
# The operator picks up a tip, probes it on the calibrator, jogs onto the rim
# of the first wax hole, and BIMS stores (live − that tip's probe adjust).
# Every fill then probes ITS tip and adds that adjust back — the same frame
# the carriage fill uses, so bims_native / use_tip_calibration behave the same.
#
# LIFT RULE (the robot-arm line only): the pipette goes ALL THE WAY UP — a
# Z-only home to the top of its travel — before EVERY move between stations:
# the tip rack, the calibrator, the wax tube, the trash and the cart on the
# stage, and between the cart's rows. The arm and its stage stand far above
# anything the motion planner knows about (it only sees the labware on the
# deck), so a planned arc or a direct move at any lower height can hit them.
# lift() does the home; every move after it is a PLANNED move (no
# force_direct), which the engine runs as XY at the current — top — height and
# then straight down at the target, never a diagonal. Only the hops between
# the holes of one row stay low (5 mm over the cart, inside its own footprint).

metadata = {
    'author': 'Brevitest',
    'description': 'Robot-arm stage: fills ONE Gen7 cartridge at the taught arm_cart_x/y/z (no deck, no Particle id). Same fill recipe as Wax_Filling_GEN7_Cartridge v4.1; the pipette goes all the way up (Z-only home) before every move between stations.',
}

requirements = {"robotType": "OT-2", "apiLevel": "2.19"}

# ── Single-cart geometry ─────────────────────────────────────────────────────
# From gen4deck_gen7cartridge_001 (BIMS live definition, 2026-08-19): within
# one cartridge the four wax holes of a row (deck columns 2,4,6,8 = gates
# 4,3,2,1) sit 6.0mm apart along −x, and the three rows (deck rows X,W,V) sit
# 9.0mm apart along −y. The well names below are the ones cartridge 1 has on
# a full deck, so BIMS logs and the gate mapping read the same as a deck fill.
STAGE_COLS = ('2', '4', '6', '8')          # gate 4 → gate 1
STAGE_ROWS = ('X', 'W', 'V')               # row 1 → row 3
COL_PITCH_X = -6.0                         # mm per column step (gate 4 → gate 1)
ROW_PITCH_Y = -9.0                         # mm per row step (row 1 → row 3)
STAGE_WELL_NAMES = [r + c for r in STAGE_ROWS for c in STAGE_COLS]  # X2 X4 X6 X8 W2 … V8

# Column -> gate mapping (same as the carriage protocol's first carrier).
COLUMN_GATE = {'2': 'wax_gate4', '4': 'wax_gate3', '6': 'wax_gate2', '8': 'wax_gate1'}

# A taught coordinate below this is "never taught" (the RTP defaults are 0 and
# the deck's front-left corner is NOT where a cart is). Refused before any motion.
MIN_TAUGHT_MM = 1.0


def _resolve_lift(pipette):
    """Build lift(): a Z-only home of the pipette's mount, sent through the
    protocol engine — what InstrumentContext.home() does inside (opentrons 8.7,
    API 2.19: InstrumentCore.home), minus the plunger, which must not move with
    wax in the tip. The public API has no other way up: move_to(minimum_z_height=)
    needs the top height as a number the protocol cannot read, and the engine
    rejects a minimum above the pipette's reach.

    Resolved BEFORE any motion. If a future robot-server keeps the hook elsewhere
    the run refuses to start instead of travelling low over the arm."""
    import inspect
    try:
        from opentrons.protocol_engine import commands as pe_commands
        from opentrons.protocol_engine.types import MotorAxis
        execute = pipette._core._engine_client.execute_command
    except Exception as e:  # ImportError / AttributeError on another robot-server
        raise RuntimeError(
            'ARM STAGE: cannot reach the protocol engine for the Z-only home '
            f'({type(e).__name__}: {e}). This robot-server does not keep the hook where '
            'opentrons 8.7 does; refusing to run rather than travel low over the arm.'
        )
    axis = MotorAxis.RIGHT_Z if str(pipette.mount).lower() == 'right' else MotorAxis.LEFT_Z
    params = pe_commands.HomeParams(axes=[axis])
    try:
        n_args = len(inspect.signature(execute).parameters)
    except (TypeError, ValueError):
        n_args = 1

    def lift():
        """ALL THE WAY UP: home the mount's Z axis (top of travel). The next
        PLANNED move_to travels at this height and comes straight down."""
        if n_args >= 2:
            execute(params, [])  # newer clients: (params, command_annotations)
        else:
            execute(params)

    return lift


def stage_targets(x0, y0, z0, rotation_deg=0.0, offsets=None):
    """The 12 wax-hole rim points of ONE cartridge whose FIRST wax hole (row 1,
    gate 4 - deck well X2) has its rim at (x0, y0, z0), deck frame, mm.

    rotation_deg turns the cartridge about that first hole, counter-clockwise
    seen from above, for a stage that holds the cart in a different orientation
    from a carriage slot (0 = as on the carriage: gates run toward -x, rows
    toward -y; 180 = the cart turned end for end).

    offsets, when given, is a list of 12 (dx, dy, dz) per-hole corrections in
    fill order, added AFTER the rotation - what the Stage Calibration Studio
    teaches per hole, the way the Deck Calibration Studio moves one deck well.

    Returns [(well_name, x, y, z), ...] in fill order: row 1 gates 4->1, row 2,
    row 3 - the order the carriage protocol fills cartridge 1 in.

    Module-level and pure ON PURPOSE (no protocol context) so it can be unit
    tested and so analysis never has to execute the fill.
    """
    th = math.radians(float(rotation_deg or 0.0))
    c, s = math.cos(th), math.sin(th)
    out = []
    for ri in range(len(STAGE_ROWS)):
        for ci in range(len(STAGE_COLS)):
            i = ri * len(STAGE_COLS) + ci
            dx = ci * COL_PITCH_X
            dy = ri * ROW_PITCH_Y
            rx = dx * c - dy * s
            ry = dx * s + dy * c
            ox, oy, oz = (offsets[i] if offsets and i < len(offsets) else (0.0, 0.0, 0.0))
            out.append((STAGE_WELL_NAMES[i], x0 + rx + float(ox or 0.0), y0 + ry + float(oy or 0.0), z0 + float(oz or 0.0)))
    return out


def hole_offset_param(index1, axis):
    """RTP name of a hole's per-hole correction: hole_01_dx ... hole_12_dz."""
    return 'hole_%02d_%s' % (index1, axis)


def get_well_column(well_name):
    """'X10' -> '10' (same helper as the carriage protocol, module level here)."""
    i = 0
    while i < len(well_name) and not well_name[i].isdigit():
        i += 1
    return well_name[i:]


def get_well_row(well_name):
    """'X10' -> 'X'."""
    i = 0
    while i < len(well_name) and not well_name[i].isdigit():
        i += 1
    return well_name[:i]


def add_parameters(parameters: protocol_api.Parameters):
    parameters.add_bool(
        variable_name="wax",
        display_name="Wax",
        description="Determines whether Wax is dispensed.",
        default=True
    )

    # ── The cart on the arm's stage ───────────────────────────────────────────
    # BIMS sends the taught, TIP-NEUTRAL rim of the cart's first wax hole (row 1,
    # gate 4). Defaults are 0 = "not taught" and the run refuses to move on them.
    parameters.add_float(variable_name="arm_cart_x", display_name="Arm cart X (deck mm)",
        description="Taught X of the cart's first wax hole on the arm's stage. 0 = not taught (run refuses).",
        default=0.0, minimum=0.0, maximum=400.0, unit="mm")
    parameters.add_float(variable_name="arm_cart_y", display_name="Arm cart Y (deck mm)",
        description="Taught Y of the cart's first wax hole on the arm's stage. 0 = not taught (run refuses).",
        default=0.0, minimum=0.0, maximum=400.0, unit="mm")
    parameters.add_float(variable_name="arm_cart_z", display_name="Arm cart Z (deck mm)",
        description="Taught Z of the first wax hole's RIM (tip end). 0 = not taught (run refuses).",
        default=0.0, minimum=0.0, maximum=200.0, unit="mm")
    parameters.add_float(variable_name="arm_cart_rotation_deg", display_name="Cart rotation on the stage",
        description="CCW from above about the first hole. 90 = the arm's stage, gates to the front; 0 = carriage.",
        default=90.0, minimum=-360.0, maximum=360.0, unit="deg")
    # No travel-height parameter: the pipette goes ALL THE WAY UP (Z-only home)
    # before every move between stations — see the LIFT RULE in the header.

    # ── Per-hole corrections (Stage Calibration Studio) ──────────────────────
    # The 12 holes are laid out rigidly from the first one; these let BIMS move
    # any single hole, the way the Deck Calibration Studio moves one deck well.
    # Deck mm, tip-neutral, added after the cart rotation. Defaults 0 = none.
    for i, name in enumerate(STAGE_WELL_NAMES, start=1):
        for axis in ('dx', 'dy', 'dz'):
            parameters.add_float(variable_name=hole_offset_param(i, axis), display_name="Hole %d (%s) %s" % (i, name, axis),
                description="Per-hole correction for %s in mm (Stage calibration), added after the cart rotation." % name,
                default=0.0, minimum=-5.0, maximum=5.0, unit="mm")

    # ------------------------------------------------------------------
    # Tip-calibration controls — identical to the carriage protocol. DEFAULT ON:
    # the cart location is taught tip-neutral, so it only lands when the fill
    # applies the same probe adjust.
    parameters.add_bool(
        variable_name="use_tip_calibration",
        display_name="USE TIP CALIBRATION",
        description="ON = shift X/Y by the calibrator probe adjust (the cart is taught tip-neutral). OFF = nominal.",
        default=True
    )
    parameters.add_float(
        variable_name="max_tip_adjust",
        display_name="Max tip adjust (mm)",
        description="Reject a tip-calibration adjust larger than this in X or Y (retry once, then stop).",
        default=4.0,
        minimum=0.3,
        maximum=12.0,
        unit="mm",
    )

    # Tour the cart's 4 corner wax holes with the EXACT fill motion and pause at
    # each so the operator can confirm the tip is over the WAX hole before any
    # wax is dispensed.
    parameters.add_bool(
        variable_name="run_calibration_check",
        display_name="RUN CALIBRATION CHECK",
        description="Visit the cart's 4 corner wax holes with the real fill motion and pause at each before dispensing.",
        default=False
    )

    parameters.add_float(
        variable_name="min_tip_clearance",
        display_name="Min tip clearance (mm)",
        description="Tip never goes closer than this to the tube bottom when aspirating.",
        default=1.5,
        minimum=0.3,
        maximum=5.0,
        unit="mm",
    )

    parameters.add_bool(
        variable_name="tiprack_refilled",
        display_name="Tiprack Refilled",
        description="Set to True if you have refilled the tiprack. Resets tip tracking to position A1.",
        default=False
    )

    parameters.add_float(variable_name="vol_gate4", display_name="Wax Gate 4 Volume",
        description="Dispense volume for Wax Gate 4 wells.", default=1.60, minimum=0.1, maximum=20.0, unit="uL")
    parameters.add_float(variable_name="vol_gate3", display_name="Wax Gate 3 Volume",
        description="Dispense volume for Wax Gate 3 wells.", default=1.60, minimum=0.1, maximum=20.0, unit="uL")
    parameters.add_float(variable_name="vol_gate2", display_name="Wax Gate 2 Volume",
        description="Dispense volume for Wax Gate 2 wells.", default=1.60, minimum=0.1, maximum=20.0, unit="uL")
    parameters.add_float(variable_name="vol_gate1", display_name="Wax Gate 1 Volume",
        description="Dispense volume for Wax Gate 1 wells.", default=1.60, minimum=0.1, maximum=20.0, unit="uL")

    # Backing volume held in the tip per trip; usable per trip = 20 - this. One
    # cartridge row is 4 wax wells, so a row fits in one trip while the four gate
    # volumes sum to no more than the usable figure (see the carriage protocol).
    parameters.add_float(
        variable_name="aspirate_remainder",
        display_name="Aspirate Remainder",
        description="Backing volume held in the tip per trip. Lower = more wells per aspiration.",
        default=11.5,
        minimum=0.0,
        maximum=18.0,
        unit="uL",
    )

    # How far BELOW the hole rim the tip stops to dispense (hole is 3.75mm deep).
    # Default -1.0 = HOVER 1.0mm ABOVE the rim. Capped at 2.5 (3.0 snapped tips).
    parameters.add_float(
        variable_name="dispense_depth",
        display_name="Wax dispense depth (mm)",
        description="How far below the hole rim the tip dispenses. Negative = hover above it.",
        default=-1.0,
        minimum=-2.0,
        maximum=2.5,
        unit="mm",
    )

    # BIMS-driven calibration RTPs (PRD 6) — same names as the carriage protocol
    # so BIMS's calibrationRtpValues injects them unchanged. offset_* only touch
    # the tube rack + tip rack here (there is no carriage labware to shift); the
    # taught cart point is NOT offset — it was taught in the robot's own frame.
    parameters.add_bool(
        variable_name="bims_native",
        display_name="BIMS-native offsets",
        description="Use the BIMS global offset (tube + tip racks) instead of the built-in per-robot table.",
        default=False,
    )
    parameters.add_float(variable_name="offset_x", display_name="BIMS offset X",
        description="Global deck offset X from BIMS (used when BIMS-native).",
        default=0.0, minimum=-50.0, maximum=50.0, unit="mm")
    parameters.add_float(variable_name="offset_y", display_name="BIMS offset Y",
        description="Global deck offset Y from BIMS (used when BIMS-native).",
        default=0.0, minimum=-50.0, maximum=50.0, unit="mm")
    parameters.add_float(variable_name="offset_z", display_name="BIMS offset Z",
        description="Global deck offset Z from BIMS (used when BIMS-native).",
        default=0.0, minimum=-50.0, maximum=50.0, unit="mm")
    parameters.add_float(variable_name="cal_x", display_name="Tip-calibrator X",
        description="Tip-calibrator approach X (deck frame).",
        default=125.181, minimum=0.0, maximum=400.0, unit="mm")
    parameters.add_float(variable_name="cal_y", display_name="Tip-calibrator Y",
        description="Tip-calibrator approach Y (deck frame).",
        default=173.247, minimum=0.0, maximum=400.0, unit="mm")
    parameters.add_float(variable_name="z_cal", display_name="Tip-calibrator Z",
        description="Tip-calibration probe Z (p20 wax tip).",
        default=34.491, minimum=0.0, maximum=200.0, unit="mm")


def run(protocol: protocol_api.ProtocolContext):
    import socket
    hostname = socket.gethostname()
    protocol.comment(f'HOSTNAME: {hostname}')

    # Dead fallback table — all zero on purpose (see the carriage protocol).
    ROBOT_OFFSETS = {
        'muddy-water':       { 'name': 'Left (B14)',   'x': 0.0, 'y': 0.0, 'z': 0.0 },
        'OT2CEP20210817R04': { 'name': 'Middle (R04)', 'x': 0.0, 'y': 0.0, 'z': 0.0 },
        'hidden-leaf':       { 'name': 'Right (B07)',  'x': 0.0, 'y': 0.0, 'z': 0.0 },
    }
    DEFAULT_OFFSETS = { 'name': 'Unknown', 'x': 0.0, 'y': 0.0, 'z': 0.0 }
    robot_offsets = ROBOT_OFFSETS.get(hostname, DEFAULT_OFFSETS)
    protocol.comment(f'Detected robot: {hostname} -> {robot_offsets["name"]}')

    bims_native = bool(protocol.params.bims_native)
    if bims_native:
        robot_offsets = { 'name': 'BIMS-native', 'x': protocol.params.offset_x,
                          'y': protocol.params.offset_y, 'z': protocol.params.offset_z }
        protocol.comment(f'BIMS-native offsets (tube + tip racks): '
                         f'x={robot_offsets["x"]}, y={robot_offsets["y"]}, z={robot_offsets["z"]}mm')
    z_offset = robot_offsets['z']

    offset = { 'x': 0, 'y': 0 }
    tuberack = protocol.load_labware('cosmas_and_damian_drybath_tuberack', 10)
    tiprack = protocol.load_labware('cosmasanddamian_96_tiprack_20ul', 11)
    pipette = protocol.load_instrument('p20_single_gen2', mount='right', tip_racks=[tiprack])

    # LIFT RULE: resolved before any motion; raises if the engine hook is missing.
    lift = _resolve_lift(pipette)

    if bims_native:
        tuberack.set_offset(x=robot_offsets['x'], y=robot_offsets['y'], z=robot_offsets['z'])
        tiprack.set_offset(x=robot_offsets['x'], y=robot_offsets['y'], z=robot_offsets['z'])

    # ── The taught cart ──────────────────────────────────────────────────────
    cart_x = float(protocol.params.arm_cart_x)
    cart_y = float(protocol.params.arm_cart_y)
    cart_z = float(protocol.params.arm_cart_z)
    cart_rot = float(protocol.params.arm_cart_rotation_deg)
    cart_taught = cart_x >= MIN_TAUGHT_MM and cart_y >= MIN_TAUGHT_MM and cart_z >= MIN_TAUGHT_MM
    if not cart_taught:
        protocol.comment('ARM STAGE: no cart location (arm_cart_x/y/z not set) - the run will refuse to move.')
        if not protocol.is_simulating():
            raise RuntimeError(
                'ARM STAGE: arm_cart_x/y/z are not set (0). Teach the cart location on the BIMS '
                'robot-arm wax-fill page; this protocol never guesses where the cart is.'
            )
    hole_offsets = [
        tuple(float(getattr(protocol.params, hole_offset_param(i, axis))) for axis in ('dx', 'dy', 'dz'))
        for i in range(1, len(STAGE_WELL_NAMES) + 1)
    ]
    targets = stage_targets(cart_x, cart_y, cart_z, cart_rot, hole_offsets)
    protocol.comment(f'ARM STAGE: first wax hole at x={cart_x} y={cart_y} z={cart_z}, rotation {cart_rot} deg; '
                     f'12 holes: ' + ', '.join(f'{n}({x:.2f},{y:.2f},{z:.2f})' for n, x, y, z in targets))
    corrected = [(STAGE_WELL_NAMES[i], o) for i, o in enumerate(hole_offsets) if any(abs(v) > 1e-9 for v in o)]
    if corrected:
        protocol.comment('ARM STAGE: per-hole corrections: ' + ', '.join(f'{n} ({o[0]:+.2f},{o[1]:+.2f},{o[2]:+.2f})' for n, o in corrected))

    # ── Persistent tip tracking (verbatim from the carriage protocol) ───────
    import json as _json
    import os as _os

    _tip_state_path = f'/data/tip_tracker_{hostname}.json'
    _all_tips = tiprack.wells()

    def load_tip_state():
        try:
            with open(_tip_state_path, 'r') as _f:
                _data = _json.load(_f)
            idx = int(_data.get('next_tip_index', 0))
            if idx < 0 or idx >= len(_all_tips):
                protocol.comment(f'TIP TRACKER: index {idx} out of range - resetting to 0')
                return 0
            return idx
        except FileNotFoundError:
            protocol.comment('TIP TRACKER: no state file found - starting from A1')
            return 0
        except Exception as _e:
            protocol.comment(f'TIP TRACKER: error reading state ({_e}) - resetting to 0')
            return 0

    def save_tip_state(index):
        try:
            with open(_tip_state_path, 'w') as _f:
                _json.dump({'next_tip_index': index, 'hostname': hostname}, _f)
        except Exception as _e:
            protocol.comment(f'TIP TRACKER: warning - could not save state: {_e}')

    if not protocol.is_simulating():
        if protocol.params.tiprack_refilled:
            _tip_index = 0
            save_tip_state(0)
            protocol.comment('TIP TRACKER: tiprack marked as refilled - reset to A1')
        else:
            _tip_index = load_tip_state()
        _tip_well = _all_tips[_tip_index]
        pipette.starting_tip = _tip_well
        protocol.comment(f'TIP TRACKER: starting from tip {_tip_well.well_name} (index {_tip_index})')
    else:
        _tip_index = 0

    # ── Calibrator serial helpers (verbatim) ─────────────────────────────────
    def serial_read_with_retry(ser, max_retries=3, timeout=0.5):
        for attempt in range(max_retries):
            try:
                original_timeout = ser.timeout
                ser.timeout = timeout
                data = ser.readline()
                ser.timeout = original_timeout
                if data:
                    return data
            except serial.SerialException as e:
                protocol.comment(f'Serial read attempt {attempt + 1} failed: {str(e)}')
                if attempt == max_retries - 1:
                    raise
                time.sleep(0.1)
        raise serial.SerialException(f'Failed to read from serial port after {max_retries} attempts')

    def serial_write_with_retry(ser, data, max_retries=3):
        for attempt in range(max_retries):
            try:
                ser.write(data)
                ser.flush()
                return
            except serial.SerialException as e:
                protocol.comment(f'Serial write attempt {attempt + 1} failed: {str(e)}')
                if attempt == max_retries - 1:
                    raise
                time.sleep(0.1)

    ser = None

    # The calibrator's serial port, remembered across runs so the probe below
    # asks the right port first instead of every /dev/ttyACM* in turn (each
    # wrong port costs an open, a settle and a read timeout). The scanner and
    # the calibrator both enumerate as ttyACM, and which gets which number can
    # change after a reboot or a re-plug — so the cache is only an ordering
    # hint; every port is still tried when the remembered one does not answer.
    _cal_port_cache = f'/data/calibrator_port_{hostname}.json'

    def _remembered_calibrator_port():
        try:
            with open(_cal_port_cache, 'r') as _f:
                _p = _json.load(_f).get('port')
            return _p if isinstance(_p, str) and _p.startswith('/dev/tty') else None
        except Exception:
            return None

    def _remember_calibrator_port(port):
        if protocol.is_simulating():
            return
        try:
            with open(_cal_port_cache, 'w') as _f:
                _json.dump({'port': port, 'savedAt': time.time()}, _f)
        except Exception as _e:
            protocol.comment(f'Calibrator port cache: could not save ({_e})')

    def _probe_for_calibrator():
        ports = sorted(glob.glob('/dev/ttyACM*'))
        remembered = _remembered_calibrator_port()
        if remembered in ports:
            ports.remove(remembered)
            ports.insert(0, remembered)
        for port in ports:
            _s = None
            try:
                _s = serial.Serial(port=port, baudrate=115200, timeout=0.5)
                time.sleep(0.3)
                _s.reset_input_buffer()
                _s.write(b'C')
                _s.flush()
                reply = _s.readline()
                if reply and b':' in reply:
                    protocol.comment(f'Calibrator found on {port}: {reply!r}')
                    if port != remembered:
                        _remember_calibrator_port(port)
                    return _s
                _s.close()
            except Exception as _e:
                protocol.comment(f'Calibrator probe on {port} failed: {_e}')
                try:
                    if _s:
                        _s.close()
                except Exception:
                    pass
        return None

    def _find_calibrator(wait_s=25):
        deadline = time.time() + wait_s
        while True:
            _s = _probe_for_calibrator()
            if _s:
                return _s
            if time.time() >= deadline:
                return None
            time.sleep(1.5)

    if protocol.is_simulating():
        ser = _probe_for_calibrator()
        if not ser or not ser.is_open:
            return
    else:
        ser = _find_calibrator()
        while not ser or not ser.is_open:
            protocol.pause(
                'Tip calibrator missing - could not read offset calibration. '
                'Check the calibrator USB connection, then click Resume to retry '
                '(or Cancel/Stop to end the run).'
            )
            ser = _find_calibrator(wait_s=8)

    try:
        if not protocol.params.use_tip_calibration:
            protocol.comment('Tip calibration disabled - skipping offset baseline read (x=0.0, y=0.0).')
        else:
            try:
                serial_write_with_retry(ser, b'C')
                offset_data_raw = serial_read_with_retry(ser)
                import re as _re_cal
                _m = _re_cal.search(rb'(-?\d+(?:\.\d+)?)\s*:\s*(-?\d+(?:\.\d+)?)', offset_data_raw or b'')
                if _m:
                    offset['x'] = float(_m.group(1))
                    offset['y'] = float(_m.group(2))
                    protocol.comment(f'Offset calibration: x={offset["x"]}, y={offset["y"]}')
                else:
                    raise ValueError(f'Invalid offset data format: {offset_data_raw!r}')
            except Exception as e:
                protocol.pause(
                    f'Could not read offset calibration ({str(e)}). '
                    f'Click Resume to START THE RUN ANYWAY (zero baseline; per-tip '
                    f'calibration still runs), or Cancel/Stop to end.'
                )
                offset['x'] = 0.0
                offset['y'] = 0.0
                protocol.comment('Continuing without serial offset baseline - using x=0.0, y=0.0.')

        # NO particle-id read: the stage is not a carriage. The cart's position
        # came in as arm_cart_x/y/z above.

        # ── Mid-run tip swap request (verbatim) ──────────────────────────────
        _TIP_SWAP_REQ = '/data/ot2-bridge/tip-swap-request.json'

        def take_tip_swap_request():
            if protocol.is_simulating():
                return None
            try:
                if not _os.path.exists(_TIP_SWAP_REQ):
                    return None
                mode = 'rack'
                try:
                    with open(_TIP_SWAP_REQ, 'r') as _f:
                        mode = str((_json.load(_f) or {}).get('mode') or 'rack')
                except Exception:
                    pass
                try:
                    _os.remove(_TIP_SWAP_REQ)
                except Exception:
                    pass
                return 'hand' if mode == 'hand' else 'rack'
            except Exception:
                return None

        take_tip_swap_request()

        def P(x, y, z):
            """Absolute deck point as a Location (no labware: the stage is not labware)."""
            return types.Location(types.Point(x=x, y=y, z=z), None)

        def pick_up_and_calibrate_tip(pick_up=True):
            """Verbatim from the carriage protocol (Locations carry no labware)."""
            nonlocal _tip_index
            cal_x = protocol.params.cal_x
            cal_y = protocol.params.cal_y
            z_cal = protocol.params.z_cal

            if pick_up and pipette.has_tip:
                lift()
                pipette.drop_tip()

            if pick_up and not protocol.is_simulating() and _tip_index >= len(_all_tips):
                protocol.pause('TIP TRACKER: tiprack exhausted - refill rack, enable "Tiprack Refilled" on next run, then click Resume to continue with current run from A1')
                _tip_index = 0
                pipette.starting_tip = _all_tips[0]
                save_tip_state(0)

            if pick_up:
                lift()
                pipette.pick_up_tip()
                if not protocol.is_simulating():
                    _tip_index += 1
                    save_tip_state(_tip_index)
                    if _tip_index < len(_all_tips):
                        protocol.comment(f'TIP TRACKER: consumed tip {_all_tips[_tip_index - 1].well_name} - next tip will be {_all_tips[_tip_index].well_name} (index {_tip_index})')
                    else:
                        protocol.comment(f'TIP TRACKER: consumed tip {_all_tips[_tip_index - 1].well_name} - rack now empty')

            if not protocol.params.use_tip_calibration:
                protocol.comment('Per-tip calibration DISABLED - nominal wax hole position, no X/Y probe.')
                return { 'x': 0.0, 'y': 0.0 }

            max_adjust = float(protocol.params.max_tip_adjust)

            def _probe_once():
                lift()  # from the tip rack / the hover / the cart: XY at the top, then down onto the calibrator
                pipette.move_to(P(cal_x, cal_y, z_cal), speed=None)

                x_pos = cal_x - 0.6
                y_pos = cal_y - 6.5
                pipette.move_to(P(x_pos, y_pos, z_cal), force_direct=True, speed=20)
                limit_reached = False
                shift = 0.1
                try:
                    serial_write_with_retry(ser, b'X')
                except Exception as e:
                    protocol.comment(f'Error writing to serial during X calibration: {str(e)}')
                    return { 'x': 0.0, 'y': 0.0 }, False, 'serial write failed (X)'

                while (not limit_reached):
                    pipette.move_to(P(x_pos - shift, y_pos, z_cal), force_direct=True, speed=5)
                    shift += 0.1
                    if (shift > 5):
                        break
                    original_timeout = ser.timeout
                    ser.timeout = 0.01
                    try:
                        response = ser.read(1)
                        limit_reached = response == b'X'
                    finally:
                        ser.timeout = original_timeout
                x_ok = limit_reached
                xOffset = round(offset['x'] - shift, 1)

                yOffset = 0.0
                y_ok = False
                if x_ok:
                    x_pos = cal_x + 8.829
                    y_pos = cal_y - 7.5
                    pipette.move_to(P(x_pos, y_pos, z_cal), force_direct=True, speed=20)
                    limit_reached = False
                    shift = 0.1
                    try:
                        serial_write_with_retry(ser, b'Y')
                    except Exception as e:
                        protocol.comment(f'Error writing to serial during Y calibration: {str(e)}')
                        return { 'x': xOffset, 'y': 0.0 }, False, 'serial write failed (Y)'

                    while (not limit_reached):
                        pipette.move_to(P(x_pos, y_pos - shift, z_cal), force_direct=True, speed=5)
                        shift += 0.1
                        if (shift > 5):
                            break
                        original_timeout = ser.timeout
                        ser.timeout = 0.01
                        try:
                            response = ser.read(1)
                            limit_reached = response == b'Y'
                        finally:
                            ser.timeout = original_timeout
                    y_ok = limit_reached
                    yOffset = round(offset['y'] - shift, 1)

                pipette.move_to(P(cal_x + 2.0, cal_y + 1.0, z_cal), force_direct=True, speed=20)
                pipette.move_to(P(cal_x + 2.0, cal_y + 1.0, z_cal + 20), force_direct=True, speed=20)
                lift()  # back to the top: the next stop is the tube, the cart or the trash

                adj = { 'x': xOffset, 'y': yOffset }
                if not x_ok:
                    return adj, False, 'X limit switch not reached within 5mm'
                if not y_ok:
                    return adj, False, 'Y limit switch not reached within 5mm'
                if abs(xOffset) > max_adjust or abs(yOffset) > max_adjust:
                    return adj, False, f'adjust ({xOffset}, {yOffset}) exceeds max_tip_adjust {max_adjust}mm'
                return adj, True, ''

            def _no_tip_prompt(attempt, why):
                lift()
                pipette.move_to(P(cal_x + 2.0, cal_y + 1.0, z_cal + 60), speed=20)  # planned: XY at the top, then down to the hover
                protocol.comment(f'WARNING: NO TIP DETECTED on the pipette (attempt {attempt}: {why}).')
                protocol.pause(
                    f'NO TIP DETECTED (attempt {attempt}: {why}). The pipette is raised over the '
                    f'calibrator. Push a tip firmly onto the pipette BY HAND (or check the tip rack), '
                    f'then click Resume to calibrate that tip. Cancel/Stop to end the run.'
                )

            adj, ok, why = _probe_once()
            if ok:
                protocol.comment(f'Tip calibration OK: adjust x={adj["x"]}, y={adj["y"]}')
                return adj

            attempt = 1
            while not ok and 'not reached' in why:
                _no_tip_prompt(attempt, why)
                adj, ok, why = _probe_once()
                attempt += 1
                if ok:
                    protocol.comment(f'Tip calibration OK on hand-inserted tip (attempt {attempt}): adjust x={adj["x"]}, y={adj["y"]}')
                    return adj

            protocol.comment(f'Tip calibration REJECTED ({why}) - retrying with a fresh tip.')
            if pipette.has_tip:
                lift()
                pipette.drop_tip()
            if not protocol.is_simulating() and _tip_index >= len(_all_tips):
                protocol.pause('TIP TRACKER: tiprack exhausted - refill rack, enable "Tiprack Refilled" on next run, then click Resume to continue with current run from A1')
                _tip_index = 0
                pipette.starting_tip = _all_tips[0]
                save_tip_state(0)
            lift()
            pipette.pick_up_tip()
            if not protocol.is_simulating():
                _tip_index += 1
                save_tip_state(_tip_index)
                protocol.comment(f'TIP TRACKER: consumed tip {_all_tips[_tip_index - 1].well_name} (retry) - index {_tip_index}')
            adj, ok, why = _probe_once()
            if ok:
                protocol.comment(f'Tip calibration OK on retry: adjust x={adj["x"]}, y={adj["y"]}')
                return adj
            attempt = 1
            while not ok and 'not reached' in why:
                _no_tip_prompt(attempt, why)
                adj, ok, why = _probe_once()
                attempt += 1
                if ok:
                    protocol.comment(f'Tip calibration OK on hand-inserted tip (attempt {attempt}): adjust x={adj["x"]}, y={adj["y"]}')
                    return adj

            # NO NOMINAL FALLBACK - the cart location is taught tip-neutral, so
            # nominal is a known-wrong position, not an uncorrected one.
            raise RuntimeError(
                f'Tip calibration REJECTED twice ({why}). Refusing to continue at nominal: '
                f'the cart location is taught tip-neutral, so nominal is off the hole, not '
                f'merely uncorrected. Check the calibrator fixture, or raise the max tip '
                f'adjust for this robot in BIMS if the reading is genuinely normal for it, then re-run.'
            )

        # ── Stage motion helpers ─────────────────────────────────────────────
        well_prejump_height = 5

        def arrive(t, adjust):
            """Come down onto hole `t`: ALL THE WAY UP first (lift), then ONE planned
            move to the pre-jump height over the hole, tip adjust applied. The
            engine runs that move as XY at the top and then straight down — the
            planner only knows the labware on the deck, not the raised stage, so
            the lift is what keeps the travel clear of the arm and the stage.

            Every move at the stage after this one is force_direct: a bare deck
            point has no labware, so a planned move to it would arc at deck height
            - slow, low, and pointless over one flat cartridge top."""
            name, tx, ty, tz = t
            px, py = tx + adjust['x'], ty + adjust['y']
            lift()
            pipette.move_to(P(px, py, tz + well_prejump_height))
            protocol.delay(seconds=.3)
            return px, py

        def leave(t, adjust):
            """Straight up, all the way: the Z-only home before any travel away
            from the cart (the stage is higher than anything the API knows about)."""
            lift()

        calibration_check_wells = ['X2', 'X8', 'V8', 'V2']  # the cart's 4 corners

        def run_calibration_check(adjust):
            well_z_depth = -float(protocol.params.dispense_depth) + z_offset
            by_name = {t[0]: t for t in targets}
            n = len(calibration_check_wells)
            last = None
            for i, well_name in enumerate(calibration_check_wells):
                t = by_name[well_name]
                px, py = arrive(t, adjust)
                pipette.move_to(P(px, py, t[3] + well_z_depth), force_direct=True)
                protocol.pause(
                    f'Calibration check {i + 1}/{n}: wax hole {well_name} '
                    f'(adjust x={adjust["x"]}, y={adjust["y"]}). Tip over the WAX hole? '
                    f'Click Resume for the next hole, Cancel/Stop to end.'
                )
                pipette.move_to(P(px, py, t[3] + well_prejump_height), force_direct=True)
                last = t
            if last is not None:
                leave(last, adjust)
            return True

        # ── Tube geometry from the loaded labware (verbatim) ─────────────────
        maximum_volume_per_aspiration = 20
        pipette_tip_capacity = 21
        _wax_tube = tuberack['A3']
        tube_rim_height_2mL = _wax_tube.top().point.z
        tube_bottom_height_lw = _wax_tube.bottom().point.z
        aspirating_z_height_tweak = .25
        max_aspirate_depth = 50 + aspirating_z_height_tweak
        aspirate_remainder = protocol.params.aspirate_remainder

        def source_height(source_volume):
            lookup_table_2mL = {
                50: 3.80, 100: 4.15, 150: 5.65, 200: 6.57, 300: 7.71, 400: 9.90,
                500: 11.10, 750: 15.01, 1000: 19.12, 1500: 26.33, 2000: 33.60, 2250: 37.06,
            }
            tube_bottom_height = tube_bottom_height_lw
            lookup_table_keys_list = list(lookup_table_2mL)
            closet_volume = bisect.bisect_left(list(lookup_table_2mL.keys()), source_volume)
            linear_ratio_between_volumes = (source_volume - lookup_table_keys_list[closet_volume]) / (lookup_table_keys_list[closet_volume + 1] - lookup_table_keys_list[closet_volume])
            tube_liquid_height_correction = (lookup_table_2mL[lookup_table_keys_list[closet_volume + 1]] - lookup_table_2mL[lookup_table_keys_list[closet_volume]]) * linear_ratio_between_volumes
            tube_liquid_height = lookup_table_2mL[lookup_table_keys_list[closet_volume]] + tube_liquid_height_correction
            return tube_bottom_height + tube_liquid_height

        def row_key(well_name):
            return get_well_row(well_name)

        def dispense_stage(source, well_volumes, dispense_rates, source_volume, adjust):
            """The carriage protocol's dispense loop over the 12 stage targets:
            batches never cross a row, every batch arrives after a full lift and
            leaves by lifting all the way up, the mid-run tip swap is honoured."""
            source_well = tuberack[source]
            first_dispense = True
            well_index = 0

            row_total = sum(well_volumes[g] for g in ('wax_gate4', 'wax_gate3', 'wax_gate2', 'wax_gate1'))
            protocol.comment(
                f'Aspirate budget: {maximum_volume_per_aspiration}uL pipette max - '
                f'{aspirate_remainder}uL remainder = {maximum_volume_per_aspiration - aspirate_remainder}uL '
                f'usable per trip; one cartridge row needs {round(row_total, 2)}uL'
            )
            if row_total > maximum_volume_per_aspiration - aspirate_remainder:
                protocol.comment('NOTE: a full cartridge row does not fit in one aspiration, so rows will be filled in parts.')

            def do_tip_swap(mode, at_well):
                protocol.comment(f'TIP SWAP requested from BIMS ({mode}) - will continue at well {at_well}.')
                if mode == 'hand':
                    _cx, _cy, _cz = protocol.params.cal_x, protocol.params.cal_y, protocol.params.z_cal
                    lift()
                    pipette.move_to(P(_cx + 2.0, _cy + 1.0, _cz + 60), speed=20)  # planned: XY at the top, then down to the hover
                    protocol.pause(
                        f'TIP SWAP (by hand): the pipette is raised over the calibrator. Pull the old tip '
                        f'off and push a NEW tip firmly on, then click Resume - it will calibrate the new '
                        f'tip and continue at well {at_well}. Cancel/Stop to end the run.'
                    )
                    return pick_up_and_calibrate_tip(pick_up=False)
                return pick_up_and_calibrate_tip()

            while well_index < len(targets):
                _swap = take_tip_swap_request()
                if _swap:
                    adjust = do_tip_swap(_swap, targets[well_index][0])
                    first_dispense = True

                available_volume = maximum_volume_per_aspiration - aspirate_remainder
                batch_volume = 0
                batch_size = 0
                for i in range(well_index, len(targets)):
                    well_name = targets[i][0]
                    vol = well_volumes[COLUMN_GATE.get(get_well_column(well_name), 'wax_gate4')]
                    if batch_volume + vol > available_volume + 1e-9:
                        break
                    if batch_size > 0 and row_key(well_name) != row_key(targets[well_index][0]):
                        break
                    batch_volume += vol
                    batch_size += 1

                if batch_size <= 0:
                    protocol.comment(
                        f'STOPPING: well {targets[well_index][0]} needs more than the '
                        f'{available_volume}uL usable per aspiration. Lower its gate volume or the aspirate remainder.'
                    )
                    break

                batch = targets[well_index:well_index + batch_size]
                aspirate_volume = batch_volume + aspirate_remainder
                aspirate_end = tube_rim_height_2mL - source_height(source_volume - aspirate_volume)
                aspirate_cover = 2

                protocol.comment(f'Processing wells {well_index + 1} to {well_index + batch_size} of {len(targets)}')
                if (aspirate_end + aspirate_cover) > max_aspirate_depth:
                    protocol.comment('Cannot aspirate any deeper - stopping')
                    break

                tip_floor_z = tube_bottom_height_lw + float(protocol.params.min_tip_clearance)
                target_below_rim = aspirate_end + aspirate_cover
                target_tip_z = tube_rim_height_2mL - target_below_rim
                if target_tip_z < tip_floor_z:
                    target_below_rim = tube_rim_height_2mL - tip_floor_z
                    protocol.comment(
                        f'Aspirate clamped to the tube floor: {float(protocol.params.min_tip_clearance)}mm '
                        f'above the bottom ({target_below_rim:.2f}mm below the rim)'
                    )
                pipette.aspirate(aspirate_volume, source_well.top(-target_below_rim))
                protocol.delay(seconds=2)
                pipette.move_to(source_well.top(-2.3))
                protocol.delay(seconds=3)
                pipette.touch_tip(v_offset=-2.3)
                pipette.dispense(.25, source_well.top(), rate=0.5)

                dispensed_volume = 0
                well_z_depth = -float(protocol.params.dispense_depth) + z_offset
                swap_at = None
                last_done = None
                for idx, t in enumerate(batch):
                    _swap = take_tip_swap_request()
                    if _swap:
                        swap_at = (idx, _swap)
                        break
                    well_name, tx, ty, tz = t
                    gate = COLUMN_GATE.get(get_well_column(well_name), 'wax_gate4')
                    current_volume = well_volumes[gate]
                    current_rate = dispense_rates[gate]
                    # Arriving from the tube (idx 0), the first hole of the run, or a
                    # row crossing: always ALL THE WAY UP first (arrive → lift). The
                    # planner cannot see the raised stage, so the lift is not optional.
                    # Within a row: a straight hop to the pre-jump height over the next
                    # hole (5 mm over the cart, inside its own footprint).
                    crosses_row = idx > 0 and row_key(well_name) != row_key(batch[idx - 1][0])
                    if first_dispense or crosses_row or idx == 0:
                        px, py = arrive(t, adjust)
                    else:
                        px, py = tx + adjust['x'], ty + adjust['y']
                        pipette.move_to(P(px, py, tz + well_prejump_height), force_direct=True)
                    first_dispense = False
                    # Down to the dispense height, then dispense IN PLACE (a dispense
                    # given a bare deck point would plan its own deck-high arc first).
                    pipette.move_to(P(px, py, tz + well_z_depth), force_direct=True)
                    pipette.dispense(current_volume, rate=current_rate)
                    dispensed_volume += current_volume
                    last_done = t
                    protocol.comment(f'Dispensed {current_volume}uL into well {well_name}')

                source_volume -= dispensed_volume
                if last_done is not None:
                    leave(last_done, adjust)

                if swap_at is not None:
                    _idx, _mode = swap_at
                    well_index += _idx
                    pipette.blow_out(location=source_well.top())
                    adjust = do_tip_swap(_mode, targets[well_index][0])
                    first_dispense = True
                    continue

                well_index += batch_size
                pipette.blow_out(location=source_well.top())

            if pipette.has_tip:
                lift()
                pipette.drop_tip()

        # ── Volumes ──────────────────────────────────────────────────────────
        dispense = True
        wax = protocol.params.wax
        tube_locations = { 'wax': 'A3' }
        well_volumes = {
            'wax_gate4': protocol.params.vol_gate4,
            'wax_gate3': protocol.params.vol_gate3,
            'wax_gate2': protocol.params.vol_gate2,
            'wax_gate1': protocol.params.vol_gate1,
        }
        dispense_rates = { 'wax_gate4': 0.325, 'wax_gate3': 0.325, 'wax_gate2': 0.325, 'wax_gate1': 0.325 }
        dead_volume = 50
        source_volume = dead_volume + sum(well_volumes[COLUMN_GATE.get(get_well_column(n), 'wax_gate4')] for n, _, _, _ in targets)
        protocol.comment(f"Gate volumes - Gate4: {well_volumes['wax_gate4']}uL, Gate3: {well_volumes['wax_gate3']}uL, Gate2: {well_volumes['wax_gate2']}uL, Gate1: {well_volumes['wax_gate1']}uL")
        protocol.comment(f"Calculated source volume needed for one cart: {source_volume}uL")

        if dispense and not protocol.is_simulating():
            if wax:
                if protocol.params.run_calibration_check:
                    protocol.comment('Calibration check enabled. Picking up tip and calibrating...')
                    check_adjust = pick_up_and_calibrate_tip()
                    protocol.comment(f'Calibration check adjust: x={check_adjust["x"]}, y={check_adjust["y"]}')
                    run_calibration_check(check_adjust)
                    protocol.pause('Calibration check done. Click Resume to START WAX DISPENSING with a fresh tip, or Cancel/Stop to end the run.')
                    if pipette.has_tip:
                        lift()
                        pipette.drop_tip()
                adjust = pick_up_and_calibrate_tip()
                dispense_stage(
                    source=tube_locations['wax'],
                    well_volumes=well_volumes,
                    dispense_rates=dispense_rates,
                    source_volume=source_volume,
                    adjust=adjust,
                )
            # The robot arm comes in next to take the cart: park the gantry at
            # home so nothing is left over the stage. (BIMS homes again before
            # the arm moves; this makes the protocol safe on its own too.)
            protocol.home()
            protocol.comment('ARM STAGE: gantry homed - clear for the arm.')

    finally:
        if ser and ser.is_open:
            try:
                ser.close()
                protocol.comment('Serial port closed')
            except:
                pass
