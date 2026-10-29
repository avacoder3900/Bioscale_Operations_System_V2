import math
import string
import serial
import glob
from opentrons import protocol_api
from opentrons import types
import collections
import bisect
import time

# Wax_Filling_GEN7_ArmStage_Rehearsal_p300 — the stage wax fill, REHEARSED on
# the p300 with 200 uL tips and NO WAX.
#
# A development copy of Wax_Filling_GEN7_ArmStage.py for a robot-arm OT-2 that
# is not kitted out with a p20. It walks every station of the real fill in the
# real order — tip rack, calibrator probe, wax tube, the cart on the stage (12
# holes, row by row, batched per aspirate trip), trash, home — so the arm loop
# (grab → scan → fill → withdraw) can be rehearsed end to end, but:
#
#   * the pipette is the p300 on the 200 uL rack (slot 11), not the p20;
#   * the volumes are AIR: every gate "dispenses" 20 uL (the p300's minimum) and
#     each trip aspirates up to 200 uL, so the plunger moves the way the p300
#     allows; the tube in A3 should be EMPTY (or absent);
#   * the calibrator probe uses the REAGENT recipe (the p300 / 200 uL tip
#     approach offsets and probe Z from Reagent_Filling_GEN7.py), because the
#     200 uL tip meets the fixture differently from the 20 uL wax tip;
#   * the per-tip probe Z is its own RTP (z_cal_p300, default 40.8) so BIMS's
#     wax-process injection of the p20's z_cal cannot land on the p300.
#
# Everything else — the taught cart (arm_cart_x/y/z + rotation + the 36 per-
# hole corrections from the Stage Calibration Studio), tip tracking, the probe
# retry rules, the aspirate height model, the batch-per-row dispense loop, the
# mid-run tip swap, the calibration-check tour and the final home — is the
# stage protocol's, line for line where the pipette allows it.
#
# This file NEVER fills a cart. A cart location taught with the p300 is marked
# 'reagent' in BIMS and must be re-taught with the p20 before a production
# fill; the production file is Wax_Filling_GEN7_ArmStage.py.
#
# TEACHING CONVENTION (the BIMS page enforces it): the cart location is TIP-
# NEUTRAL, exactly like the deck holes taught in the Deck Calibration Studio.
# The operator picks up a tip, probes it on the calibrator, jogs onto the rim
# of the first wax hole, and BIMS stores (live − that tip's probe adjust).
# Every fill then probes ITS tip and adds that adjust back.
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
#
# ARM-WAX-LOOP-B (2026-10-29): ONE run serves a whole loop of carts. BIMS drives
# it cart by cart through /data/arm_loop.json (written by the bridge daemon) and
# the run pauses between carts with 'ARM PARKED <i>' — the tip idling IN the wax
# tube, holding the next cart's first batch so the wax stays warm — and at the
# scan position with 'ARM AT_SCAN <i>'. One tip, probed once, for the whole loop.
# The arm may move while the run is parked; never while it is at the calibrator
# or over the stage. See docs/prds/ARM-WAX-LOOP-B-ONE-RUN-PER-LOOP.md §5.

metadata = {
    'author': 'Brevitest',
    'description': 'REHEARSAL ONLY - the robot-arm stage wax fill walked through on the p300 with 200 uL tips and AIR (no wax). Same stations, order, taught cart, probe/retry rules, batching, lift rule and one-run-per-loop pauses (ARM-WAX-LOOP-B) as Wax_Filling_GEN7_ArmStage.py; never fills a cart.',
}

requirements = {"robotType": "OT-2", "apiLevel": "2.19"}

# ── Rehearsal constants ──────────────────────────────────────────────────────
# The p300 GEN2's working range is 20-300 uL; its 200 uL tip caps a trip at 200.
REHEARSAL_PIPETTE = 'p300_single_gen2'
REHEARSAL_TIPRACK = 'cosmas_and_damian_biotix_96_200ul_tiprack'
REHEARSAL_MIN_VOLUME_UL = 20.0
REHEARSAL_MAX_PER_ASPIRATION_UL = 200
REHEARSAL_TIP_CAPACITY_UL = 210

# ── Single-cart geometry (verbatim from the stage protocol) ──────────────────
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


# ── ARM-WAX-LOOP-B: one run per loop, driven by BIMS through an instruction file ──
# (docs/prds/ARM-WAX-LOOP-B-ONE-RUN-PER-LOOP.md §5). The bridge daemon writes
# /data/arm_loop.json for BIMS; this protocol reads it after every pause. ONE tip
# serves the whole loop; between carts it idles IN the wax tube (keeps the wax in
# the tip warm) at the aspirate height, holding the next cart's first batch.
ARM_LOOP_FILE = '/data/arm_loop.json'
ARM_LOOP_ACTIONS = ('scan', 'fill', 'skip', 'end')
ARM_LOOP_POLL_S = 0.5
ARM_LOOP_WAIT_S = 60.0
# Analysis / simulation: the robot's analysis has no instruction file and no taught
# cart, so the loop is walked once per cart on these stand-in points (well inside
# the deck; nothing real is at them) with synthesised scan → fill → … → end records.
SIM_CART = (200.0, 200.0, 80.0)
SIM_SCAN = (200.0, 200.0, 120.0)


def read_arm_loop_record(path=ARM_LOOP_FILE):
    """One read of the instruction file: its dict, or None when missing/unreadable."""
    import json
    try:
        with open(path, 'r') as f:
            data = json.load(f)
    except Exception:
        return None
    return data if isinstance(data, dict) else None


class ArmLoopInstructions:
    """BIMS → protocol instructions (contract §5.1).

    start(): the start record (action 'start', seq 0) must be in the file before
    any motion; it fixes the loop id. next(): after a resume, the first record
    with the SAME loop, seq > the last one consumed and a known action, polled
    every ARM_LOOP_POLL_S for up to ARM_LOOP_WAIT_S; None when nothing fresh
    arrived (the caller pauses 'ARM NO_INSTRUCTION <i>' and asks again after the
    next resume). A stale or foreign record never acts.
    simulate=True reads no file: scan, fill for each cart, then end."""

    def __init__(self, path=ARM_LOOP_FILE, simulate=False, cartridges=1, sleep=None, clock=None):
        self.path = path
        self.simulate = bool(simulate)
        self.cartridges = max(1, int(cartridges))
        self._sleep = sleep or time.sleep
        self._clock = clock or time.time
        self.loop = None
        self.seen_seq = 0
        self._sim = []

    def start(self):
        if self.simulate:
            self.loop = 'sim'
            self.seen_seq = 0
            seq = 0
            for cart in range(1, self.cartridges + 1):
                for action in ('scan', 'fill'):
                    seq += 1
                    self._sim.append({'seq': seq, 'loop': 'sim', 'cart': cart, 'action': action, 'barcode': None})
            self._sim.append({'seq': seq + 1, 'loop': 'sim', 'cart': self.cartridges + 1, 'action': 'end', 'barcode': None})
            return {'seq': 0, 'loop': 'sim', 'action': 'start'}
        rec = read_arm_loop_record(self.path)
        if not rec or rec.get('action') != 'start' or not rec.get('loop'):
            raise RuntimeError('ARM LOOP: no start record in /data/arm_loop.json')
        self.loop = str(rec['loop'])
        self.seen_seq = 0
        return rec

    def is_fresh(self, rec):
        if not rec or self.loop is None or str(rec.get('loop')) != self.loop:
            return False
        try:
            seq = int(rec.get('seq'))
        except (TypeError, ValueError):
            return False
        return seq > self.seen_seq and rec.get('action') in ARM_LOOP_ACTIONS

    def next(self, timeout_s=ARM_LOOP_WAIT_S, poll_s=ARM_LOOP_POLL_S):
        if self.simulate:
            if self._sim:
                rec = self._sim.pop(0)
            else:
                rec = {'seq': self.seen_seq + 1, 'loop': 'sim', 'cart': 0, 'action': 'end', 'barcode': None}
            self.seen_seq = int(rec['seq'])
            return rec
        deadline = self._clock() + float(timeout_s)
        while True:
            rec = read_arm_loop_record(self.path)
            if self.is_fresh(rec):
                self.seen_seq = int(rec['seq'])
                return rec
            if self._clock() >= deadline:
                return None
            self._sleep(poll_s)


def _resolve_lift(pipette):
    """Build lift(): a Z-only home of the pipette's mount, sent through the
    protocol engine — what InstrumentContext.home() does inside (opentrons 8.7,
    API 2.19: InstrumentCore.home), minus the plunger. The public API has no
    other way up: move_to(minimum_z_height=) needs the top height as a number
    the protocol cannot read, and the engine rejects a minimum above the
    pipette's reach.

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
        display_name="Rehearse the dispense",
        description="ON = walk the tube + 12-hole dispense motion with air. OFF = calibrate a tip and home only.",
        default=True
    )

    # ── Which mount carries the p300 ─────────────────────────────────────────
    # The reagent line keeps its p300 on the LEFT; the wax p20 lives on the right.
    # The lift rule homes whichever Z axis this names.
    parameters.add_str(
        variable_name="pipette_mount",
        display_name="p300 mount",
        description="The mount the p300 is on. Left is where the reagent line keeps it.",
        choices=[
            {"display_name": "Left", "value": "left"},
            {"display_name": "Right", "value": "right"},
        ],
        default="left",
    )

    # ── The cart on the arm's stage (verbatim from the stage protocol) ───────
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

    # ── ARM-WAX-LOOP-B: one run serves a whole loop of carts ─────────────────
    parameters.add_int(variable_name="cartridges", display_name="Carts this run serves",
        description="How many carts this run serves (the BIMS loop's requested runs). One tip for all of them.",
        default=1, minimum=1, maximum=24)
    parameters.add_float(variable_name="arm_scan_x", display_name="Arm scan X (deck mm)",
        description="Taught X of the scan position over the stage. 0 = not taught (run refuses).",
        default=0.0, minimum=0.0, maximum=400.0, unit="mm")
    parameters.add_float(variable_name="arm_scan_y", display_name="Arm scan Y (deck mm)",
        description="Taught Y of the scan position over the stage. 0 = not taught (run refuses).",
        default=0.0, minimum=0.0, maximum=400.0, unit="mm")
    parameters.add_float(variable_name="arm_scan_z", display_name="Arm scan Z (deck mm)",
        description="Taught Z of the scan position (tip end). 0 = not taught (run refuses).",
        default=0.0, minimum=0.0, maximum=200.0, unit="mm")
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
    # Tip-calibration controls — identical to the stage protocol. DEFAULT ON:
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
    # each so the operator can confirm the tip is over the WAX hole.
    parameters.add_bool(
        variable_name="run_calibration_check",
        display_name="RUN CALIBRATION CHECK",
        description="Tour the cart's 4 corner wax holes with the real fill motion, pausing at each, before dispensing.",
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
        description="Set to True if you have refilled the 200 uL tiprack. Resets tip tracking to position A1.",
        default=False
    )

    # ── Rehearsal volumes (AIR) ──────────────────────────────────────────────
    # The real fill dispenses ~1.6 uL of wax per gate from a 20 uL trip. The
    # p300 cannot move that little, so each gate "dispenses" 20 uL of air (its
    # minimum) and a trip aspirates up to 200 uL. Same RTP names as the stage
    # protocol so the batching code is unchanged; the bounds are the p300's.
    parameters.add_float(variable_name="vol_gate4", display_name="Gate 4 volume (air, p300)",
        description="Rehearsal dispense per Gate 4 well. Air only; 20 uL is the p300 minimum.",
        default=20.0, minimum=20.0, maximum=50.0, unit="uL")
    parameters.add_float(variable_name="vol_gate3", display_name="Gate 3 volume (air, p300)",
        description="Rehearsal dispense per Gate 3 well. Air only; 20 uL is the p300 minimum.",
        default=20.0, minimum=20.0, maximum=50.0, unit="uL")
    parameters.add_float(variable_name="vol_gate2", display_name="Gate 2 volume (air, p300)",
        description="Rehearsal dispense per Gate 2 well. Air only; 20 uL is the p300 minimum.",
        default=20.0, minimum=20.0, maximum=50.0, unit="uL")
    parameters.add_float(variable_name="vol_gate1", display_name="Gate 1 volume (air, p300)",
        description="Rehearsal dispense per Gate 1 well. Air only; 20 uL is the p300 minimum.",
        default=20.0, minimum=20.0, maximum=50.0, unit="uL")

    # Backing volume held in the tip per trip; usable per trip = 200 - this. One
    # cartridge row is 4 wells, so at the defaults a row (80 uL) fits in one trip
    # exactly as a wax row (4 x 1.6 uL) fits in a 20 uL p20 trip.
    parameters.add_float(
        variable_name="aspirate_remainder",
        display_name="Aspirate Remainder",
        description="Backing volume held in the tip per trip. Lower = more wells per aspiration.",
        default=20.0,
        minimum=0.0,
        maximum=100.0,
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

    # BIMS-driven calibration RTPs (PRD 6) — same names as the stage protocol
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
    # NOT z_cal: BIMS injects z_cal for the wax process from the p20 fixture depth
    # (zCalWax). The p300 / 200 uL tip probes at the REAGENT depth, so it gets its
    # own name — set it to the Stage Studio's "probe Z p300" for this robot.
    parameters.add_float(variable_name="z_cal_p300", display_name="Tip-calibrator Z (p300)",
        description="Tip-calibration probe Z for the p300 / 200 uL tip (the Stage Studio's probe Z p300, zCalReagent).",
        default=40.8, minimum=0.0, maximum=200.0, unit="mm")


def run(protocol: protocol_api.ProtocolContext):
    import socket
    hostname = socket.gethostname()
    protocol.comment(f'HOSTNAME: {hostname}')
    protocol.comment('REHEARSAL: p300 + 200 uL tips, AIR only - this run never fills a cart. '
                     'Production fill = Wax_Filling_GEN7_ArmStage.py on the p20.')

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
    tiprack = protocol.load_labware(REHEARSAL_TIPRACK, 11)
    mount = str(protocol.params.pipette_mount).strip().lower()
    if mount not in ('left', 'right'):
        mount = 'left'
    pipette = protocol.load_instrument(REHEARSAL_PIPETTE, mount=mount, tip_racks=[tiprack])
    protocol.comment(f'REHEARSAL: {REHEARSAL_PIPETTE} on the {mount} mount, {REHEARSAL_TIPRACK} in slot 11.')

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
    # ── The taught scan position (ARM-WAX-LOOP-B) ──────────────────────────
    scan_x = float(protocol.params.arm_scan_x)
    scan_y = float(protocol.params.arm_scan_y)
    scan_z = float(protocol.params.arm_scan_z)
    scan_taught = scan_x >= MIN_TAUGHT_MM and scan_y >= MIN_TAUGHT_MM and scan_z >= MIN_TAUGHT_MM
    if not scan_taught:
        protocol.comment('ARM LOOP: no scan position (arm_scan_x/y/z not set) - the run will refuse to move.')
        if not protocol.is_simulating():
            raise RuntimeError(
                'ARM LOOP: arm_scan_x/y/z are not set (0). Teach the scan position on the BIMS '
                'Stage calibration tab; this protocol never guesses where the scanner reads.'
            )
    if protocol.is_simulating():
        # Analysis walks the loop on stand-in points (SIM_CART / SIM_SCAN).
        if not cart_taught:
            cart_x, cart_y, cart_z = SIM_CART
        if not scan_taught:
            scan_x, scan_y, scan_z = SIM_SCAN
    cartridges = max(1, int(protocol.params.cartridges))
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

    # ── Persistent tip tracking ──────────────────────────────────────────────
    # The 200 uL rack is the REAGENT line's rack, so its tracker is shared with
    # Reagent_Filling_GEN7.py: a tip the rehearsal consumes is never offered to
    # a reagent fill, and vice versa. (The wax p20 tracker is a different file.)
    import json as _json
    import os as _os

    _tip_state_path = f'/data/tip_tracker_reagent_{hostname}.json'
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

    def _probe_for_calibrator():
        for port in sorted(glob.glob('/dev/ttyACM*')):
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
        # Analysis: no serial at all. The baseline read and the X/Y probe are
        # skipped (adjust 0, 0); the loop is walked on the stand-in points.
        ser = None
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
        if protocol.is_simulating():
            protocol.comment('ARM LOOP: analysis - no calibrator serial, baseline x=0.0, y=0.0.')
        elif not protocol.params.use_tip_calibration:
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
            """The stage protocol's pick-up + probe + retry rules, with the REAGENT
            probe recipe (p300 / 200 uL tip approach offsets, from
            Reagent_Filling_GEN7.py) and the p300 probe Z."""
            nonlocal _tip_index
            cal_x = protocol.params.cal_x
            cal_y = protocol.params.cal_y
            z_cal = protocol.params.z_cal_p300

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
            if protocol.is_simulating():
                protocol.comment('ARM LOOP: analysis - no serial, no X/Y probe (adjust 0, 0).')
                return { 'x': 0.0, 'y': 0.0 }

            max_adjust = float(protocol.params.max_tip_adjust)

            def _probe_once():
                lift()  # from the tip rack / the hover / the cart: XY at the top, then down onto the calibrator
                pipette.move_to(P(cal_x, cal_y, z_cal), speed=None)

                # REAGENT recipe: where the 200 uL tip starts its X and Y approaches.
                x_pos = cal_x - 1.4
                y_pos = cal_y - 7.0
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

                # REAGENT recipe retract: straight up over the approach point.
                pipette.move_to(P(cal_x, cal_y, z_cal + 20), force_direct=True, speed=20)
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
                pipette.move_to(P(cal_x, cal_y, z_cal + 60), speed=20)  # planned: XY at the top, then down to the hover
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

        # ── Tube geometry from the loaded labware ────────────────────────────
        # The p300's trip budget stands in for the p20's 20 / 21.
        maximum_volume_per_aspiration = REHEARSAL_MAX_PER_ASPIRATION_UL
        pipette_tip_capacity = REHEARSAL_TIP_CAPACITY_UL
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

        # ── ARM-WAX-LOOP-B: the fill, batch by batch, with ONE tip for the loop ──
        def plan_batches(well_volumes):
            """The carriage protocol's batching, planned up front: batches never
            cross a row and never exceed the usable volume per trip."""
            available_volume = maximum_volume_per_aspiration - aspirate_remainder
            batches = []
            well_index = 0
            while well_index < len(targets):
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
                    raise RuntimeError(
                        f'ARM LOOP: well {targets[well_index][0]} needs more than the '
                        f'{available_volume}uL usable per aspiration. Lower its gate volume or the aspirate remainder.'
                    )
                batches.append((targets[well_index:well_index + batch_size], batch_volume))
                well_index += batch_size
            return batches

        def tube_depth_for(source_volume, aspirate_volume):
            """How far below the rim the tip end sits to aspirate `aspirate_volume`
            with `source_volume` in the tube: the existing height model, clamped to
            the tube floor + min_tip_clearance. None when the model says too deep."""
            aspirate_end = tube_rim_height_2mL - source_height(source_volume - aspirate_volume)
            aspirate_cover = 2
            if (aspirate_end + aspirate_cover) > max_aspirate_depth:
                return None
            tip_floor_z = tube_bottom_height_lw + float(protocol.params.min_tip_clearance)
            target_below_rim = aspirate_end + aspirate_cover
            target_tip_z = tube_rim_height_2mL - target_below_rim
            if target_tip_z < tip_floor_z:
                target_below_rim = tube_rim_height_2mL - tip_floor_z
                protocol.comment(
                    f'Aspirate clamped to the tube floor: {float(protocol.params.min_tip_clearance)}mm '
                    f'above the bottom ({target_below_rim:.2f}mm below the rim)'
                )
            return target_below_rim

        def settle_after_aspirate(source_well):
            """The settle, touch-off and drip-back the wax recipe always did after
            an aspirate; also what leaving the park does."""
            if not wax:
                return
            pipette.move_to(source_well.top(-2.3))
            protocol.delay(seconds=3)
            pipette.touch_tip(v_offset=-2.3)
            # The wax recipe drips 0.25 uL back here; that is below the p300's
            # range, so the rehearsal only pauses where the drip would be.
            pipette.move_to(source_well.top())
            protocol.delay(seconds=.5)

        def aspirate_batch(source_well, batch_volume, source_volume):
            """Into the tube (a PLANNED move: lift() ran before leaving the last
            station) and aspirate one batch + the remainder."""
            aspirate_volume = batch_volume + aspirate_remainder
            below_rim = tube_depth_for(source_volume, aspirate_volume)
            if below_rim is None:
                raise RuntimeError('ARM LOOP: cannot aspirate any deeper - the wax tube is too low. Refill it and start the loop again.')
            if wax:
                pipette.aspirate(aspirate_volume, source_well.top(-below_rim))
                protocol.delay(seconds=2)
            else:
                pipette.move_to(source_well.top(-below_rim))
            settle_after_aspirate(source_well)
            return aspirate_volume

        def park(source_well, source_volume, holding_volume):
            """Tip IN the wax at the aspirate height for what it holds, where it
            idles while the arm swaps carts (keeps the wax in the tip warm). A
            PLANNED move: lift() ran before leaving the last station."""
            below_rim = tube_depth_for(source_volume, max(holding_volume, aspirate_remainder))
            if below_rim is None:
                below_rim = tube_rim_height_2mL - (tube_bottom_height_lw + float(protocol.params.min_tip_clearance))
            pipette.move_to(source_well.top(-below_rim))

        def dispense_batch(batch, well_volumes, dispense_rates, adjust):
            """Dispense one batch over the stage: ALL THE WAY UP first (arrive →
            lift), low hops within a row, lift all the way up when done. The
            mid-batch tip swap request is honoured as before. Returns the volume
            dispensed and, when a swap interrupted, (index, mode) of where."""
            dispensed_volume = 0
            well_z_depth = -float(protocol.params.dispense_depth) + z_offset
            last_done = None
            for idx, t in enumerate(batch):
                _swap = take_tip_swap_request()
                if _swap:
                    if last_done is not None:
                        leave(last_done, adjust)
                    return dispensed_volume, (idx, _swap)
                well_name, tx, ty, tz = t
                gate = COLUMN_GATE.get(get_well_column(well_name), 'wax_gate4')
                current_volume = well_volumes[gate]
                current_rate = dispense_rates[gate]
                # Arriving from the tube (idx 0) or a row crossing: ALL THE WAY UP
                # first (arrive → lift). Within a row: a straight hop to the pre-jump
                # height over the next hole (5 mm over the cart, inside its footprint).
                crosses_row = idx > 0 and row_key(well_name) != row_key(batch[idx - 1][0])
                if crosses_row or idx == 0:
                    px, py = arrive(t, adjust)
                else:
                    px, py = tx + adjust['x'], ty + adjust['y']
                    pipette.move_to(P(px, py, tz + well_prejump_height), force_direct=True)
                # Down to the dispense height, then dispense IN PLACE (a dispense
                # given a bare deck point would plan its own deck-high arc first).
                pipette.move_to(P(px, py, tz + well_z_depth), force_direct=True)
                if wax:
                    pipette.dispense(current_volume, rate=current_rate)
                dispensed_volume += current_volume
                last_done = t
                protocol.comment(f'Dispensed {current_volume}uL of AIR into well {well_name} (rehearsal)')
            if last_done is not None:
                leave(last_done, adjust)
            return dispensed_volume, None

        def do_tip_swap(mode, at_well):
            protocol.comment(f'TIP SWAP requested from BIMS ({mode}) - will continue at well {at_well}.')
            if mode == 'hand':
                _cx, _cy, _cz = protocol.params.cal_x, protocol.params.cal_y, protocol.params.z_cal_p300
                lift()
                pipette.move_to(P(_cx, _cy, _cz + 60), speed=20)  # planned: XY at the top, then down to the hover
                protocol.pause(
                    f'TIP SWAP (by hand): the pipette is raised over the calibrator. Pull the old tip '
                    f'off and push a NEW tip firmly on, then click Resume - it will calibrate the new '
                    f'tip and continue at well {at_well}. Cancel/Stop to end the run.'
                )
                return pick_up_and_calibrate_tip(pick_up=False)
            return pick_up_and_calibrate_tip()

        def fill_cart(cart_index, barcode, source_well, well_volumes, dispense_rates, source_volume, adjust, batches, first_loaded):
            """One cart: every batch in order. The first batch is already in the
            tip when the run parked with it (first_loaded): leave the park with the
            settle ritual instead of aspirating. Returns (source_volume, adjust)."""
            bi = 0
            loaded = first_loaded
            while bi < len(batches):
                batch, batch_volume = batches[bi]
                _swap = take_tip_swap_request()
                if _swap and not loaded:
                    adjust = do_tip_swap(_swap, batch[0][0])
                if loaded:
                    loaded = False
                    settle_after_aspirate(source_well)
                else:
                    aspirate_batch(source_well, batch_volume, source_volume)
                protocol.comment(f'Processing wells {targets.index(batch[0]) + 1} to {targets.index(batch[-1]) + 1} of {len(targets)}')
                dispensed_volume, swap_at = dispense_batch(batch, well_volumes, dispense_rates, adjust)
                source_volume -= dispensed_volume
                if wax:
                    pipette.blow_out(location=source_well.top())
                if swap_at is not None:
                    _idx, _mode = swap_at
                    # Finish the interrupted batch's remaining holes after the swap.
                    rest = batch[_idx:]
                    rest_volume = sum(well_volumes[COLUMN_GATE.get(get_well_column(t[0]), 'wax_gate4')] for t in rest)
                    batches = batches[:bi] + [(rest, rest_volume)] + batches[bi + 1:]
                    adjust = do_tip_swap(_mode, rest[0][0])
                    continue
                bi += 1
            protocol.comment(f'ARM CART {cart_index} FILLED {barcode}')
            return source_volume, adjust

        # ── Volumes (air) ────────────────────────────────────────────────────
        dispense = True
        wax = protocol.params.wax
        tube_locations = { 'wax': 'A3' }
        well_volumes = {
            'wax_gate4': max(float(protocol.params.vol_gate4), REHEARSAL_MIN_VOLUME_UL),
            'wax_gate3': max(float(protocol.params.vol_gate3), REHEARSAL_MIN_VOLUME_UL),
            'wax_gate2': max(float(protocol.params.vol_gate2), REHEARSAL_MIN_VOLUME_UL),
            'wax_gate1': max(float(protocol.params.vol_gate1), REHEARSAL_MIN_VOLUME_UL),
        }
        dispense_rates = { 'wax_gate4': 0.325, 'wax_gate3': 0.325, 'wax_gate2': 0.325, 'wax_gate1': 0.325 }
        dead_volume = 50
        cart_volume = sum(well_volumes[COLUMN_GATE.get(get_well_column(n), 'wax_gate4')] for n, _, _, _ in targets)
        source_volume = dead_volume + cartridges * cart_volume
        protocol.comment(f"Rehearsal gate volumes (AIR) - Gate4: {well_volumes['wax_gate4']}uL, Gate3: {well_volumes['wax_gate3']}uL, Gate2: {well_volumes['wax_gate2']}uL, Gate1: {well_volumes['wax_gate1']}uL")
        protocol.comment(f"Modelled source volume for the aspirate depth, {cartridges} cart(s) (tube A3 should be EMPTY): {source_volume}uL")

        # ── ARM-WAX-LOOP-B: the loop ─────────────────────────────────────────
        # Once: start record, tip, probe (unchanged), first batch, park → PARKED 1.
        # Then BIMS drives cart by cart through /data/arm_loop.json (contract §5.4):
        #   scan → lift → scan position → AT_SCAN i → (fill | skip | end)
        #   fill → the 12 holes → tube → next cart's first batch → park → PARKED i+1
        #   skip → tube → park → PARKED i+1        end → trash the tip → home
        # Analysis (is_simulating): the same loop on synthesised records and the
        # stand-in points, with no serial and no probe.
        loop_instructions = ArmLoopInstructions(simulate=protocol.is_simulating(), cartridges=cartridges)
        loop_instructions.start()
        source_well = tuberack[tube_locations['wax']]
        batches = plan_batches(well_volumes)
        row_total = sum(well_volumes[g] for g in ('wax_gate4', 'wax_gate3', 'wax_gate2', 'wax_gate1'))
        protocol.comment(
            f'Aspirate budget: {maximum_volume_per_aspiration}uL pipette max - '
            f'{aspirate_remainder}uL remainder = {maximum_volume_per_aspiration - aspirate_remainder}uL '
            f'usable per trip; one cartridge row needs {round(row_total, 2)}uL (air); {len(batches)} trip(s) per cart'
        )
        if row_total > maximum_volume_per_aspiration - aspirate_remainder:
            protocol.comment('NOTE: a full cartridge row does not fit in one aspiration, so rows will be filled in parts.')

        def next_instruction(cart_index):
            """The next fresh record; pauses ARM NO_INSTRUCTION until one arrives."""
            while True:
                rec = loop_instructions.next()
                if rec:
                    try:
                        named = int(rec.get('cart'))
                    except (TypeError, ValueError):
                        named = cart_index
                    if named != cart_index:
                        protocol.comment(f'ARM LOOP: instruction {rec.get("action")} names cart {named}; this run is at cart {cart_index}.')
                    return rec
                protocol.pause(f'ARM NO_INSTRUCTION {cart_index}')

        def go_to_scan_position():
            """ALL THE WAY UP, then one planned move to the taught scan point (the
            engine runs it as XY at the top, then straight down)."""
            lift()
            pipette.move_to(P(scan_x, scan_y, scan_z))

        def park_for(cart_index, source_volume, holding):
            """Lift, go to the tube and park: with the next cart's first batch when a
            cart remains and nothing is held yet; otherwise as the tip is."""
            lift()
            if not holding and cart_index <= cartridges:
                batch, batch_volume = batches[0]
                holding = aspirate_batch(source_well, batch_volume, source_volume)
            park(source_well, source_volume, holding)
            protocol.pause(f'ARM PARKED {cart_index}')
            return holding

        def finish(holding):
            """end: give the held wax back to the tube, trash the tip, home."""
            if holding and wax:
                lift()
                pipette.blow_out(location=source_well.top())
            if pipette.has_tip:
                lift()
                pipette.drop_tip()
            protocol.home()
            protocol.comment('ARM LOOP END')
            protocol.comment('ARM STAGE: gantry homed - clear for the arm. (REHEARSAL: no wax was dispensed.)')

        if wax and protocol.params.run_calibration_check and not protocol.is_simulating():
            protocol.comment('Calibration check enabled. Picking up tip and calibrating...')
            check_adjust = pick_up_and_calibrate_tip()
            protocol.comment(f'Calibration check adjust: x={check_adjust["x"]}, y={check_adjust["y"]}')
            run_calibration_check(check_adjust)
            protocol.pause('Calibration check done. Click Resume to START THE LOOP with a fresh tip, or Cancel/Stop to end the run.')
            if pipette.has_tip:
                lift()
                pipette.drop_tip()

        # ONE tip for the whole loop (Alejandro, 2026-10-29): picked up and probed
        # once here; never changed between carts.
        adjust = pick_up_and_calibrate_tip()
        protocol.comment(f'ARM LOOP: one tip for the whole loop ({cartridges} cart(s)); adjust x={adjust["x"]}, y={adjust["y"]}')
        cart = 1
        holding = park_for(cart, source_volume, 0)
        while True:
            rec = next_instruction(cart)
            action = rec['action']
            if action == 'scan':
                go_to_scan_position()
                while True:
                    protocol.pause(f'ARM AT_SCAN {cart}')
                    rec = next_instruction(cart)
                    action = rec['action']
                    if action != 'scan':
                        break
            if action == 'end':
                finish(holding)
                break
            if action == 'fill':
                source_volume, adjust = fill_cart(cart, rec.get('barcode'), source_well, well_volumes, dispense_rates,
                                                  source_volume, adjust, batches, first_loaded=holding > 0)
                cart += 1
                holding = park_for(cart, source_volume, 0)
            elif action == 'skip':
                protocol.comment(f'ARM CART {cart} SKIPPED')
                cart += 1
                holding = park_for(cart, source_volume, holding)
            else:
                protocol.comment(f'ARM LOOP: unknown instruction {action!r} - ignored.')
    finally:
        if ser and ser.is_open:
            try:
                ser.close()
                protocol.comment('Serial port closed')
            except:
                pass
