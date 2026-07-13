import math
import string 
import serial 
import glob 
from opentrons import protocol_api
from opentrons import types
import collections
import bisect
import time

# Version 4.0 - Retrofitted for Gen6 cartridge deck (24 wells/cartridge, 4 wax cols per group)

metadata = {
    'author': 'Brevitest',
    'description': 'Gen6 retrofit. 4 wax cols per X-group (was 5). Updated labware loadNames, column grouping, and special columns. v4.1: added persistent tip tracking.',
} 

requirements = {"robotType": "OT-2", "apiLevel": "2.19"}

# Cartridges on a deck. The destination list is always laid out as this many equal
# contiguous blocks, so cartridge N is the slice [(N-1)*per : N*per].
CARTS_ON_DECK = 24


def resume_window(total_wells, cartridges_per_deck, resume_cartridge=1, resume_hole=1,
                  carts_on_deck=CARTS_ON_DECK):
    """Which slice of the destination list should this run actually fill?

    `cartridges_per_deck` has always truncated the END of the list (fill the first N
    cartridges). Resume adds a START, so a run aborted by a broken tip can be picked up
    exactly where it died instead of re-filling the whole deck.

    resume_cartridge/resume_hole are 1-based (that's how an operator counts them on the
    bench). The default (1, 1) yields start=0 — i.e. a normal full run, byte-for-byte the
    old behaviour.

    Returns (start, end) to be used as well_names[start:end].

    Kept module-level and pure ON PURPOSE: the fill loop is wrapped in
    `if dispense and not protocol.is_simulating()`, so an Opentrons analysis/simulation
    never executes it and cannot catch a slicing bug. This function is the part that can
    be tested on its own — see scripts/test-fill-resume.py.
    """
    wells_on_cart = int(total_wells / carts_on_deck)
    end = min(cartridges_per_deck * wells_on_cart, total_wells)
    start = (resume_cartridge - 1) * wells_on_cart + (resume_hole - 1)
    return max(0, min(start, end)), end

def add_parameters(parameters: protocol_api.Parameters):
    parameters.add_int(
        variable_name="cartridges",
        display_name="Cartridges",
        description="The number of cartridges to be filled.",
        default=24,
        minimum=1,
        maximum=24,
        unit="cartridges",
    )
        
    parameters.add_bool(
        variable_name="wax",
        display_name="Wax",
        description="Determines whether Wax is dispensed.",
        default=True
    )
    
    # New parameters for row pattern selection
    parameters.add_bool(
        variable_name="row_pattern_0",
        display_name="Channel C (X,U,R,O...)",
        description="Fill every 3rd row starting with X (pattern i%3==0)",
        default=True
    )
    
    parameters.add_bool(
        variable_name="row_pattern_1", 
        display_name="Channel B (W,T,Q,N...)",
        description="Fill every 3rd row starting with W (pattern i%3==1)",
        default=True
    )
    
    parameters.add_bool(
        variable_name="row_pattern_2",
        display_name="Channel A (V,S,P,M...)", 
        description="Fill every 3rd row starting with V (pattern i%3==2)",
        default=True
    )

    # Per-gate wax volumes (columns: Gate4=2,10,18 | Gate3=4,12,20 | Gate2=6,14,22 | Gate1=8,16,24)
    parameters.add_bool(
        variable_name="tiprack_refilled",
        display_name="Tiprack Refilled",
        description="Set to True if you have refilled the tiprack. Resets tip tracking to position A1.",
        default=False
    )

    parameters.add_float(
        variable_name="vol_gate4",
        display_name="Wax Gate 4 Volume",
        description="Dispense volume for Wax Gate 4 wells.",
        default=1.60,
        minimum=0.1,
        maximum=20.0,
        unit="uL",
    )
    parameters.add_float(
        variable_name="vol_gate3",
        display_name="Wax Gate 3 Volume",
        description="Dispense volume for Wax Gate 3 wells.",
        default=1.60,
        minimum=0.1,
        maximum=20.0,
        unit="uL",
    )
    parameters.add_float(
        variable_name="vol_gate2",
        display_name="Wax Gate 2 Volume",
        description="Dispense volume for Wax Gate 2 wells.",
        default=1.60,
        minimum=0.1,
        maximum=20.0,
        unit="uL",
    )
    parameters.add_float(
        variable_name="vol_gate1",
        display_name="Wax Gate 1 Volume",
        description="Dispense volume for Wax Gate 1 wells.",
        default=1.60,
        minimum=0.1,
        maximum=20.0,
        unit="uL",
    )

    # ==================================================================
    # NATIVE-CALIBRATION-SYSTEM PRD 6 — BIMS-driven calibration RTPs.
    # When bims_native is True, the global offset below (supplied by BIMS
    # from RobotDeckOffset) replaces the built-in ROBOT_OFFSETS table and
    # is applied to ALL labware (deck carriage + tube rack + tip rack),
    # not just the carriage. Defaults reproduce the current behavior, so
    # a run with no BIMS values (manual/Opentrons app) is unchanged.
    # The calibrator point + z_cal are read here too (defaults = the
    # previously-hardcoded values) so the tip-calibration probe is tunable.
    # ==================================================================
    parameters.add_bool(
        variable_name="bims_native",
        display_name="BIMS-native offsets",
        description="Use the BIMS global offset (applied to ALL labware) instead of the built-in per-robot table.",
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
        description="Tip-calibrator approach X (carriage frame).",
        default=125.181, minimum=0.0, maximum=400.0, unit="mm")
    parameters.add_float(variable_name="cal_y", display_name="Tip-calibrator Y",
        description="Tip-calibrator approach Y (carriage frame).",
        default=173.247, minimum=0.0, maximum=400.0, unit="mm")
    parameters.add_float(variable_name="z_cal", display_name="Tip-calibrator Z",
        description="Tip-calibration probe Z (p20 wax tip).",
        default=34.491, minimum=0.0, maximum=200.0, unit="mm")

    # ── Resume after a broken tip ────────────────────────────────────────────────
    # A tip that snaps mid-fill used to mean re-running the whole deck. These let a
    # fresh run pick up exactly where the aborted one died: it starts at (cartridge,
    # hole) and fills everything from there on. Defaults (1, 1) = a normal full run,
    # so an operator who never touches them sees no change. BIMS fills these in
    # automatically from the aborted run's command log; they are 1-based because
    # that is how the operator counts cartridges and holes on the bench.
    parameters.add_int(variable_name="resume_cartridge", display_name="Resume: cartridge",
        description="Start filling at this cartridge (1 = from the beginning). Set by the Tip-broke recovery flow.",
        default=1, minimum=1, maximum=24)
    parameters.add_int(variable_name="resume_hole", display_name="Resume: hole in that cartridge",
        description="Within the resume cartridge, start at this hole (1 = its first hole).",
        default=1, minimum=1, maximum=12)

def run(protocol: protocol_api.ProtocolContext):
    # === HOSTNAME DEBUG — remove after confirming ===
    import socket
    protocol.comment(f'HOSTNAME: {socket.gethostname()}')
    # ================================================

    # =====================================================================
    # AUTO-DETECT ROBOT & APPLY PER-ROBOT OFFSETS
    # =====================================================================
    # Each OT-2 has a unique serial number readable via hostname.
    # The protocol auto-detects which robot it's running on and applies
    # the correct XYZ offsets via set_offset() on the labware.
    #
    # XY offsets shift well positions at the labware level.
    # Z offset adjusts dispense height.
    # Limit-switch calibration (pick_up_and_calibrate_tip) provides
    # additional per-run XY fine-tuning on top of these offsets.
    #
    # To calibrate a new robot:
    #   1. Run protocol with offsets at 0,0,0
    #   2. Note where the tip lands vs where it should
    #   3. Add the correction values to ROBOT_OFFSETS below
    #
    # Robots (hostname → serial):
    #   Left   = muddy-water        (B14)
    #   Middle = OT2CEP20210817R04  (R04)
    #   Right  = hidden-leaf        (B07) — has existing calibrated offsets
    # =====================================================================
    import socket
    
    ROBOT_OFFSETS = {
        'muddy-water':       { 'name': 'Left (B14)',   'x': 0.0, 'y': 0.0,  'z': 0.0  },   # Calibrate when ready
        'OT2CEP20210817R04': { 'name': 'Middle (R04)', 'x': 0.0, 'y': 0.0,  'z': 0.0  },   # Calibrate when ready
        'hidden-leaf':       { 'name': 'Right (B07)',  'x': 0.15, 'y': -0.25, 'z': -1.3 },   # Existing calibrated offsets
    }
    DEFAULT_OFFSETS = { 'name': 'Unknown', 'x': 0.0, 'y': 0.0, 'z': 0.0 }
    
    hostname = socket.gethostname()
    robot_offsets = ROBOT_OFFSETS.get(hostname, DEFAULT_OFFSETS)
    z_offset = robot_offsets['z']
    protocol.comment(f'Detected robot: {hostname} → {robot_offsets["name"]}')
    protocol.comment(f'Offsets: x={robot_offsets["x"]}, y={robot_offsets["y"]}, z={robot_offsets["z"]}mm')
    if robot_offsets is DEFAULT_OFFSETS:
        protocol.comment(f'WARNING: Unknown robot hostname "{hostname}" — using zero offsets. Add this robot to ROBOT_OFFSETS.')

    # PRD 6: BIMS-native global offset overrides the built-in table and is applied
    # to ALL labware (see below). Default bims_native=False keeps current behavior.
    bims_native = bool(protocol.params.bims_native)
    if bims_native:
        robot_offsets = { 'name': 'BIMS-native', 'x': protocol.params.offset_x,
                          'y': protocol.params.offset_y, 'z': protocol.params.offset_z }
        protocol.comment(f'BIMS-native offsets (applied to ALL labware): '
                         f'x={robot_offsets["x"]}, y={robot_offsets["y"]}, z={robot_offsets["z"]}mm')
    z_offset = robot_offsets['z']

    offset = { 'x': 0, 'y': 0 }
    tuberack = protocol.load_labware('cosmas_and_damian_drybath_tuberack', 10)
    tiprack = protocol.load_labware('cosmasanddamian_96_tiprack_20ul', 11)
    pipette = protocol.load_instrument('p20_single_gen2', mount='right', tip_racks=[tiprack])

    # PRD 6: in BIMS-native mode the global offset shifts the tube rack + tip rack
    # too (the carriage is shifted later, where it's loaded by particle ID). In the
    # legacy table mode this is skipped so behavior is byte-for-byte unchanged.
    if bims_native:
        tuberack.set_offset(x=robot_offsets['x'], y=robot_offsets['y'], z=robot_offsets['z'])
        tiprack.set_offset(x=robot_offsets['x'], y=robot_offsets['y'], z=robot_offsets['z'])

    # =====================================================================
    # PERSISTENT TIP TRACKING
    # Stores next-tip index in /data/tip_tracker_<hostname>.json on the robot.
    # Survives protocol reloads and reboots. One file per robot via hostname.
    # =====================================================================
    import json as _json
    import os as _os

    _tip_state_path = f'/data/tip_tracker_{hostname}.json'
    _all_tips = tiprack.wells()  # 96 wells in rack order

    def load_tip_state():
        """Read persisted tip index from robot filesystem. Returns 0 on any error."""
        try:
            with open(_tip_state_path, 'r') as _f:
                _data = _json.load(_f)
            idx = int(_data.get('next_tip_index', 0))
            if idx < 0 or idx >= len(_all_tips):
                protocol.comment(f'TIP TRACKER: index {idx} out of range — resetting to 0')
                return 0
            return idx
        except FileNotFoundError:
            protocol.comment('TIP TRACKER: no state file found — starting from A1')
            return 0
        except Exception as _e:
            protocol.comment(f'TIP TRACKER: error reading state ({_e}) — resetting to 0')
            return 0

    def save_tip_state(index):
        """Write current tip index to robot filesystem."""
        try:
            with open(_tip_state_path, 'w') as _f:
                _json.dump({'next_tip_index': index, 'hostname': hostname}, _f)
        except Exception as _e:
            protocol.comment(f'TIP TRACKER: warning — could not save state: {_e}')

    # Load or reset tip index
    if not protocol.is_simulating():
        if protocol.params.tiprack_refilled:
            _tip_index = 0
            save_tip_state(0)
            protocol.comment('TIP TRACKER: tiprack marked as refilled — reset to A1')
        else:
            _tip_index = load_tip_state()
        _tip_well = _all_tips[_tip_index]
        pipette.starting_tip = _tip_well
        protocol.comment(f'TIP TRACKER: starting from tip {_tip_well.well_name} (index {_tip_index})')
    else:
        _tip_index = 0
    # =====================================================================
    carriages = {
        'e00fce68981a5e0784a62b71' : protocol.load_labware('gen4deck_gen7cartridge_001', protocol_api.OFF_DECK),
        'e00fce680fde2dcc48014df0' : protocol.load_labware('gen4deck_gen7cartridge_002', protocol_api.OFF_DECK),
        'e00fce68fc3b723490857c78' : protocol.load_labware('gen4deck_gen7cartridge_003', protocol_api.OFF_DECK),
        'e00fce680a100a70d1fea1a3' : protocol.load_labware('gen4deck_gen7cartridge_004', protocol_api.OFF_DECK)
    }
    # decks 005/006 retired (no physical carriages); defs removed from BIMS.
    #'e00fce68356060b112c98173' : protocol.load_labware('gen4deck_gen7cartridge_005', protocol_api.OFF_DECK),
    
    # Helper function to extract column number from well name
    def get_well_column(well_name):
        """Extract column number from well name like 'X10' -> '10'"""
        i = 0
        while i < len(well_name) and not well_name[i].isdigit():
            i += 1
        return well_name[i:] if i < len(well_name) else ''
    
    # Helper function to safely read from serial with retries
    def serial_read_with_retry(ser, max_retries=3, timeout=0.5):
        """Read from serial port with retry logic and error handling."""
        for attempt in range(max_retries):
            try:
                # Small delay to ensure device is ready
                time.sleep(0.1)
                data = ser.readline()
                if data and len(data) > 0:
                    return data
                elif attempt < max_retries - 1:
                    protocol.comment(f'Serial read attempt {attempt + 1} returned no data, retrying...')
                    time.sleep(0.2)
            except serial.SerialException as e:
                if attempt < max_retries - 1:
                    protocol.comment(f'Serial read error on attempt {attempt + 1}: {str(e)}, retrying...')
                    time.sleep(0.2)
                else:
                    raise
        raise serial.SerialException(f'Failed to read from serial port after {max_retries} attempts')
    
    # Helper function to safely read single byte with retries
    def serial_read_byte_with_retry(ser, max_retries=10, timeout=0.1):
        """Read single byte from serial port with retry logic."""
        original_timeout = ser.timeout  # Save original timeout
        ser.timeout = timeout  # Set shorter timeout for calibration reads
        try:
            for attempt in range(max_retries):
                try:
                    # No sleep - limit switch should respond immediately
                    data = ser.read(1)
                    if data and len(data) > 0:
                        return data
                    # If no data, retry immediately (no sleep between retries)
                except serial.SerialException as e:
                    if attempt < max_retries - 1:
                        # Minimal delay only on exception
                        time.sleep(0.01)
                    else:
                        return None
            return None
        finally:
            ser.timeout = original_timeout  # Restore original timeout
    
    # Helper function to safely write to serial
    def serial_write_with_retry(ser, data, max_retries=3):
        """Write to serial port with retry logic."""
        for attempt in range(max_retries):
            try:
                ser.reset_output_buffer()
                ser.write(data)
                ser.flush()
                time.sleep(0.05)  # Give device time to process
                return True
            except serial.SerialException as e:
                if attempt < max_retries - 1:
                    protocol.comment(f'Serial write error on attempt {attempt + 1}: {str(e)}, retrying...')
                    time.sleep(0.1)
                else:
                    raise
        return False

    ser = None
    import os as _os_cal

    # Find the CALIBRATOR serial device — NOT the barcode scanner. Both enumerate
    # as /dev/ttyACM*, and the port numbers shift on replug, so opening "the first
    # ttyACM" can grab the scanner (which never answers 'C' -> offset read fails).
    # So: (1) skip whatever /dev/scanner points to, and (2) probe each remaining
    # port with 'C' — the calibrator replies with its 'x:y' offset string.
    def _probe_for_calibrator():
        _scanner_real = _os_cal.path.realpath('/dev/scanner') if _os_cal.path.exists('/dev/scanner') else None
        for port in sorted(glob.glob('/dev/ttyACM*')):
            _s = None
            try:
                if _scanner_real and _os_cal.path.realpath(port) == _scanner_real:
                    protocol.comment(f'Skipping scanner port {port}')
                    continue
                _s = serial.Serial(port=port, baudrate=115200, timeout=0.5)
                time.sleep(0.2)
                _s.reset_input_buffer()
                _s.reset_output_buffer()
                _s.write(b'C'); _s.flush(); time.sleep(0.3)
                if b':' in (_s.readline() or b''):
                    _s.reset_input_buffer()
                    protocol.comment(f'Calibrator found on serial port: {port}')
                    return _s
                _s.close()
            except Exception as e:
                protocol.comment(f'Exception testing port {port}: {str(e)}')
                try:
                    if _s and _s.is_open:
                        _s.close()
                except Exception:
                    pass
        return None

    # The calibrator (USB serial) can enumerate a few SECONDS after the run starts,
    # so a single cold probe often misses it. That miss is what made the protocol
    # pause and then `return`, producing an empty "succeeded" run with zero fills
    # ("start the run again and it works" was the ad-hoc workaround). Poll for the
    # port instead of giving up on the first try.
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
        # Analysis pass: best-effort single probe, no retry/pause loop (pause() is a
        # no-op during analysis, so a loop here would hang the upload). The live run
        # pass does the real retry below.
        ser = _probe_for_calibrator()
        if not ser or not ser.is_open:
            return
    else:
        ser = _find_calibrator()
        # Still not found → PAUSE with a clear message and RETRY on Resume — never
        # `return` (that silently ended the run with no fills). Each Resume re-probes,
        # so once the calibrator has enumerated / been reseated the run continues and
        # actually fills.
        while not ser or not ser.is_open:
            protocol.pause(
                'Tip calibrator missing — could not read offset calibration. '
                'Check the calibrator USB connection, then click Resume to retry '
                '(or Cancel/Stop to end the run).'
            )
            ser = _find_calibrator(wait_s=8)
    
    try:
        # Read offset data with retry logic
        try:
            serial_write_with_retry(ser, b'C')
            offset_data_raw = serial_read_with_retry(ser)
            offset_data = str(offset_data_raw).split(':')
            if len(offset_data) >= 2:
                offset['x'] = float(offset_data[0][2:])
                offset['y'] = float(offset_data[1][:-5])
                protocol.comment(f'Offset calibration: x={offset["x"]}, y={offset["y"]}')
            else:
                raise ValueError('Invalid offset data format')
        except Exception as e:
            # Do NOT bail the run here. The 'C' baseline read can come back blank or
            # malformed even when the calibrator is otherwise fine — operators have
            # resumed past this in the Opentrons app and the run + per-tip probe still
            # work. Pause so the operator can choose to continue, then proceed with a
            # zero baseline (the per-tip X/Y probe below still runs; in bims_native mode
            # the global offset is applied separately via set_offset). Never `return`.
            protocol.pause(
                f'Could not read offset calibration ({str(e)}). '
                f'Click Resume to START THE RUN ANYWAY (zero baseline; per-tip '
                f'calibration still runs), or Cancel/Stop to end.'
            )
            offset['x'] = 0.0
            offset['y'] = 0.0
            protocol.comment('Continuing without serial offset baseline — using x=0.0, y=0.0.')

        # Read particle ID (which carriage/deck is loaded) with retry-on-resume —
        # never bail to an empty run. 'I' is reliable in practice; if it ever returns
        # garbage the operator can Resume to re-read (or Cancel/Stop to end).
        carriage = None
        while carriage is None:
            try:
                serial_write_with_retry(ser, b'I')
                particle_id_raw = serial_read_with_retry(ser)
                # Decode bytes to string and strip whitespace/newlines, then extract 24-character ID
                particle_id = particle_id_raw.decode('utf-8', errors='ignore').strip()[:24]
                if particle_id not in carriages:
                    raise ValueError(f'Unknown particle ID: {particle_id}')
                carriage = carriages[particle_id]
            except Exception as e:
                if protocol.is_simulating():
                    return  # analysis pass: don't loop on a (no-op) pause
                protocol.pause(
                    f'Could not read the deck/particle ID ({str(e)}). Check the '
                    f'calibrator, then click Resume to retry (or Cancel/Stop to end).'
                )
        protocol.move_labware(labware=carriage, new_location=1)
        # Apply per-robot offsets to all well positions on this labware
        carriage.set_offset(x=robot_offsets['x'], y=robot_offsets['y'], z=robot_offsets['z'])
        protocol.comment(f'Loaded carriage for particle ID: {particle_id}')
        protocol.comment(f'Applied robot offsets: x={robot_offsets["x"]}, y={robot_offsets["y"]}, z={robot_offsets["z"]}')

        def pick_up_and_calibrate_tip():
            nonlocal _tip_index
            # PRD 6: calibrator point + probe Z are RTPs (defaults = the previously
            # hardcoded values). Move points track cal_x/cal_y; the limit-switch
            # constants below shift by the same delta so the returned offset is
            # invariant when the calibrator hasn't been re-tuned.
            cal_x = protocol.params.cal_x
            cal_y = protocol.params.cal_y
            z_cal = protocol.params.z_cal

            if (pipette.has_tip):
                pipette.drop_tip()

            # Check if rack is exhausted before picking up
            if not protocol.is_simulating() and _tip_index >= len(_all_tips):
                protocol.pause('TIP TRACKER: tiprack exhausted — refill rack, enable "Tiprack Refilled" on next run, then click Resume to continue with current run from A1')
                _tip_index = 0
                pipette.starting_tip = _all_tips[0]
                save_tip_state(0)

            pipette.pick_up_tip()

            # Persist immediately after pickup so an aborted run still advances the counter
            if not protocol.is_simulating():
                _tip_index += 1
                save_tip_state(_tip_index)
                if _tip_index < len(_all_tips):
                    protocol.comment(f'TIP TRACKER: consumed tip {_all_tips[_tip_index - 1].well_name} — next tip will be {_all_tips[_tip_index].well_name} (index {_tip_index})')
                else:
                    protocol.comment(f'TIP TRACKER: consumed tip {_all_tips[_tip_index - 1].well_name} — rack now empty')

            pipette.move_to(types.Location(types.Point(x=cal_x, y=cal_y, z=z_cal), carriage), speed=None)

            x_pos = cal_x - 0.6
            y_pos = cal_y - 6.5
            pipette.move_to(types.Location(types.Point(x=x_pos, y=y_pos, z=z_cal), carriage), force_direct=True, speed=20)
            limit_reached = False
            shift = 0.1
            try:
                serial_write_with_retry(ser, b'X')
            except Exception as e:
                protocol.pause(f'Error writing to serial during X calibration: {str(e)} - click Resume to continue')
                return { 'x': 0, 'y': 0 }
            
            while (not limit_reached):
                pipette.move_to(types.Location(types.Point(x=x_pos - shift, y=y_pos, z=z_cal), carriage), force_direct=True, speed=5)
                shift += 0.1
                if (shift > 5):
                    protocol.pause('Unable to calibrate X axis, xOffset=' + str(x_pos + shift) + ' - click Resume to end')
                    break
                # Direct read with very short timeout for fast calibration
                original_timeout = ser.timeout
                ser.timeout = 0.01
                try:
                    response = ser.read(1)
                    limit_reached = response == b'X'
                finally:
                    ser.timeout = original_timeout
                #adjustment made to the 100.3 to be close to the x position
            xOffset = round(offset['x'] - shift, 1)
            x_pos = cal_x + 8.829
            y_pos = cal_y - 7.5
            pipette.move_to(types.Location(types.Point(x=x_pos, y=y_pos, z=z_cal), carriage), force_direct=True, speed=20)
            limit_reached = False
            shift = 0.1
            
            try:
                serial_write_with_retry(ser, b'Y')
            except Exception as e:
                protocol.pause(f'Error writing to serial during Y calibration: {str(e)} - click Resume to continue')
                return { 'x': xOffset, 'y': 0 }
            
            while (not limit_reached):
                pipette.move_to(types.Location(types.Point(x=x_pos, y=y_pos - shift, z=z_cal), carriage), force_direct=True, speed=5)
                shift += 0.1
                if (shift > 5):
                    protocol.pause('Unable to calibrate Y axis, yOffset=' + str(y_pos - shift) + ' - click Resume to continue')
                    break
                # Direct read with very short timeout for fast calibration
                original_timeout = ser.timeout
                ser.timeout = 0.01
                try:
                    response = ser.read(1)
                    limit_reached = response == b'Y'
                finally:
                    ser.timeout = original_timeout
            #adjustment made to the 161.2 to be close to the y position
            yOffset = round(offset['y'] - shift, 1)

            pipette.move_to(types.Location(types.Point(x=cal_x + 2.0, y=cal_y + 1.0, z=z_cal), carriage), force_direct=True, speed=20)
            pipette.move_to(types.Location(types.Point(x=cal_x + 2.0, y=cal_y + 1.0, z=z_cal + 20), carriage), force_direct=True, speed=20)
            
            return { 'x': xOffset, 'y': yOffset }

        disposal_volume = 1
        maximum_volume_per_aspiration = 20
        pipette_tip_capacity = 21
        tube_rim_height_2mL = 107.55
        aspirating_z_height_tweak = .25
        max_aspirate_depth = 50+aspirating_z_height_tweak
        aspirate_remainder = 13.5

        def source_height(source_volume):
            lookup_table_2mL = collections.OrderedDict()
            lookup_table_2mL = {
                50:3.80,
                100:4.15,
                150:5.65,
                200:6.57,
                300:7.71,
                400:9.90,
                500:11.10,
                750:15.01,
                1000:19.12,
                1500:26.33,
                2000:33.60,
                2250:37.06,
            }
            # define the bottom of the tube in relation to the deck of the robot 
            tube_bottom_height = 68.48
            
            # create a list of the keys (volumes) from the lookup table
            lookup_table_keys_list = list(lookup_table_2mL) 

            # based on the source volume, return the dictionary location of next lowest key
            closet_volume = bisect.bisect_left(list(lookup_table_2mL.keys()), source_volume)
            
            # determine how many mm of liquid height does the source volume extend past the next lowest key
            linear_ratio_between_volumes = (source_volume - lookup_table_keys_list[closet_volume]) / (lookup_table_keys_list[closet_volume+1]-lookup_table_keys_list[closet_volume])
            tube_liquid_height_correction = (lookup_table_2mL[lookup_table_keys_list[closet_volume+1]]-lookup_table_2mL[lookup_table_keys_list[closet_volume]]) * linear_ratio_between_volumes

            # define the tube liquid height
            tube_liquid_height = lookup_table_2mL[lookup_table_keys_list[closet_volume]] + tube_liquid_height_correction

            source_height = tube_bottom_height + tube_liquid_height
            return source_height

        def dispense_reagent(sources, well_names, well_volumes, dispense_rates, source_volume, adjust, cartridges_per_deck):
            """
            Dispense reagent with per-gate volumes and rates.
            
            Args:
                sources: List of source well locations
                well_names: List of destination well name strings (e.g., ['X2', 'X4', ...])
                well_volumes: Dict keyed by gate ('wax_gate1'..'wax_gate4') with volumes per well
                dispense_rates: Dict keyed by gate ('wax_gate1'..'wax_gate4') with dispense rates
                source_volume: Starting source volume
                adjust: XY offset adjustment dict
                cartridges_per_deck: Number of cartridges to fill
            """
            wells_on_cart = int(len(well_names) / CARTS_ON_DECK)
            start_i, end_i = resume_window(
                len(well_names), cartridges_per_deck, resume_cartridge, resume_hole)
            wells_to_fill_names = well_names[start_i:end_i]

            if start_i > 0:
                protocol.comment(
                    f'RESUME: starting at cartridge {resume_cartridge} hole {resume_hole} '
                    f'(well index {start_i}) — skipping {start_i} already-filled well(s), '
                    f'{len(wells_to_fill_names)} to go.'
                )
                # The source tube already gave up the skipped wells' worth of wax in the
                # aborted run, so model what is ACTUALLY left rather than a full tube —
                # otherwise the liquid-height maths aspirates above the surface and draws
                # air. source_volume arrives as (dead_volume + wax for ALL the wells this
                # run would have filled), so subtracting the skipped wells' wax leaves
                # exactly (dead_volume + wax for the wells that remain).
                skipped_volume = sum(
                    well_volumes[COLUMN_GATE.get(get_well_column(w), 'wax_gate4')]
                    for w in well_names[:start_i]
                )
                source_volume = source_volume - skipped_volume
                protocol.comment(f'RESUME: source volume adjusted down by {skipped_volume:.1f}uL already dispensed.')

            for source in sources:
                source_well = tuberack[source]
                destination_wells = [carriage[name] for name in wells_to_fill_names]
                
                jump_count = 0
                jump_frequency = 288
                jump_height = 60
                tip_dispenses = 180
                tip_change_count = 0
                well_prejump_height = 5
                # Process all wells
                well_index = 0
                
                while well_index < len(destination_wells):
                    # Calculate how many wells we can do in this aspiration cycle
                    # Must account for variable volumes per well
                    available_volume = maximum_volume_per_aspiration - aspirate_remainder
                    
                    # Determine batch size by checking actual volumes
                    batch_volume = 0
                    batch_size = 0
                    wells_before_tip_change = tip_dispenses - (tip_change_count % tip_dispenses)
                    
                    for i in range(well_index, len(destination_wells)):
                        # Look up gate for this well's column
                        well_name = wells_to_fill_names[i]
                        col = get_well_column(well_name)
                        gate = COLUMN_GATE.get(col, 'wax_gate4')
                        vol = well_volumes[gate]
                        
                        # Check if adding this well would exceed capacity
                        if batch_volume + vol > available_volume:
                            break
                        
                        # Check tip change limit
                        if batch_size >= wells_before_tip_change:
                            break
                        
                        batch_volume += vol
                        batch_size += 1
                    
                    wells_this_cycle = batch_size
                    
                    # Skip if we can't do any wells (shouldn't happen but safety check)
                    if wells_this_cycle <= 0:
                        break
                        
                    wells_to_fill = destination_wells[well_index:well_index + wells_this_cycle]
                    wells_to_fill_names_batch = wells_to_fill_names[well_index:well_index + wells_this_cycle]
                    
                    # Calculate actual aspiration volume for this batch
                    aspirate_volume = batch_volume + aspirate_remainder
                    aspirate_depth = tube_rim_height_2mL - source_height(source_volume)
                    aspirate_end = tube_rim_height_2mL - source_height(source_volume - aspirate_volume)
                    aspirate_cover = 2

                    protocol.comment(f'Processing wells {well_index + 1} to {well_index + wells_this_cycle} of {len(destination_wells)}')
                    protocol.comment('aspirate_cover + aspirate_end - ' + str(aspirate_end + aspirate_cover))

                    print('# of wells, aspirate_volume', len(wells_to_fill), aspirate_volume)
                    
                    # Check if we can aspirate from this depth
                    if (aspirate_end + aspirate_cover) > max_aspirate_depth:
                        protocol.comment('Cannot aspirate any deeper - stopping')
                        break
                    if aspirate_depth < aspirate_cover:
                        print('WARNING: aspirating too deep', aspirate_depth)
                    if aspirate_volume > pipette_tip_capacity:
                        print('WARNING: aspirating too much volume', aspirate_volume)
                    
                    # ASPIRATION
                    if aspirate_end < 30:
                        pipette.aspirate(aspirate_volume, source_well.top(-(aspirate_end + aspirate_cover)))
                        protocol.delay(seconds = 2)
                    else:
                        pipette.aspirate(aspirate_volume, source_well.bottom(.5))
                        protocol.delay(seconds = 2)

                    pipette.move_to(source_well.top(-2.3))  # Move to touch_tip height
                    protocol.delay(seconds=3)               # Pause before x/y motion
                    pipette.touch_tip(v_offset=-2.3)

                    pipette.dispense(.25, source_well.top(), rate = 0.5)

                    # DISPENSING - with variable volumes and rates per well
                    dispensed_volume = 0
                    well_z_depth = -3.0 + z_offset

                    for idx, well in enumerate(wells_to_fill):
                        # Determine volume and rate for this specific well via gate
                        well_name = wells_to_fill_names_batch[idx]
                        col = get_well_column(well_name)
                        gate = COLUMN_GATE.get(col, 'wax_gate4')
                        current_volume = well_volumes[gate]
                        current_rate = dispense_rates[gate]
                        
                        if jump_count % jump_frequency == 0:
                            pipette.move_to(well.top(jump_height))
                            pipette.move_to(well.top(jump_height).move(types.Point(adjust['x'], adjust['y'], 0.0)))
                            protocol.delay(seconds=.3)
                            pipette.move_to(well.top(well_prejump_height).move(types.Point(adjust['x'], adjust['y'], 0.0)))
                            protocol.delay(seconds=.3)
                            
                        pipette.dispense(current_volume, well.top(well_z_depth).move(types.Point(adjust['x'], adjust['y'], 0.0)), rate=current_rate)
                        
                        tip_change_count += 1
                        jump_count += 1
                        dispensed_volume += current_volume
                        protocol.comment(f'Dispensed {current_volume}uL into well {well_name} (tip #{tip_change_count})')

                        # Breadcrumb for the tip-break recovery flow. BIMS reads the LAST
                        # of these out of the run's command log to work out where to
                        # resume, so it never has to re-implement this file's well
                        # ordering in TypeScript (reorganize_list() groups columns in
                        # fours — duplicating that would rot the moment either side moved).
                        # Emitted AFTER the dispense, so the last one is the last well that
                        # actually got wax. well_index is relative to the (possibly resumed)
                        # slice, so add start_i back to get the true position on the deck.
                        abs_i = start_i + well_index + idx
                        protocol.comment(
                            f'FILL PROGRESS: group=wax cartridge={abs_i // wells_on_cart + 1} '
                            f'hole={abs_i % wells_on_cart + 1} well={well_name}')
                     
                    source_volume -= dispensed_volume
                    well_index += wells_this_cycle
                    
                    # Blow out remaining liquid
                    pipette.blow_out(location=source_well.top())
                    
                    # CHECK FOR TIP CHANGE AFTER COMPLETING ASPIRATION CYCLE
                    if tip_change_count % tip_dispenses == 0 and well_index < len(destination_wells):
                        protocol.comment('Changing tip after completing aspiration cycle')
                        adjust = pick_up_and_calibrate_tip()

                if pipette.has_tip:
                    pipette.drop_tip()
        
        params = {
            'wax': { 'cols': ['2', '4', '6', '8', '10', '12', '14', '16', '18', '20', '22', '24'], 'skip': 1, 'offset': 0 }  # ORIGINAL (Gate 1 cols 8,16,24 included)
            # 'wax': { 'cols': ['2', '4', '6', '10', '12', '14', '18', '20', '22'], 'skip': 1, 'offset': 0 }  # GATE 1 DISABLED (cols 8,16,24 removed)
        }
        reagents = list(params)
        
        # NOTE: special_columns replaced by per-gate COLUMN_GATE mapping above.
        
        full_rows_reverse = ['X', 'W', 'V', 'U', 'T', 'S', 'R', 'Q', 'P', 'O', 'N', 'M', 'L', 'K', 'J', 'I', 'H', 'G', 'F', 'E', 'D', 'C', 'B', 'A']

        def get_rows_for_column(col_num, pattern_index):
            """Return appropriate row set based on column number and pattern"""
            col_int = int(col_num)
            
            # All columns now have uniform 24-row layout based on v6 labware definition
            return full_rows_reverse

        def reorganize_list(coordinate_list, active_patterns):
            """
            Reorganizes a list of coordinates with support for multiple row patterns.
            Groups by column sections: W1-W11, V1-V11, T1-T11, S1-S11, A1-A11, then W13-W23, V13-V23, etc.
            
            Args:
                coordinate_list (list): List of coordinate strings
                active_patterns (list): List of pattern indices to include (0, 1, or 2)
                
            Returns:
                list: Reorganized list of coordinate strings with selected row patterns
            """
            # Parse coordinates into (row, col) tuples
            parsed_coords = []
            for coord in coordinate_list:
                coord = coord.strip()
                # Find where the number starts
                i = 0
                while i < len(coord) and not coord[i].isdigit():
                    i += 1
                
                if i < len(coord):
                    row = coord[:i]
                    col = int(coord[i:])
                    parsed_coords.append((row, col))
            
            # Get unique columns sorted
            cols = sorted(set(col for row, col in parsed_coords))
            
            # Group columns into sections of 4 (Gen6: 4 wax cols per X-group)
            column_groups = []
            for i in range(0, len(cols), 4):
                column_groups.append(cols[i:i+4])
            
            # Get all rows that exist in the coordinate list
            existing_rows = set(row for row, col in parsed_coords)
            
            # Define the desired row order based on active patterns
            all_rows_in_order = ['X', 'W', 'V', 'U', 'T', 'S', 'R', 'Q', 'P', 'O', 'N', 'M', 'L', 'K', 'J', 'I', 'H', 'G', 'F', 'E', 'D', 'C', 'B', 'A']
            
            # Filter rows based on active patterns and maintain specific order
            filtered_rows = []
            
            # Create pattern mapping
            pattern_rows = {}
            for i, row in enumerate(all_rows_in_order):
                pattern_rows[row] = i % 3
            
            # Add rows in the original order, but only if they match active patterns and exist in coordinate_list
            for row in all_rows_in_order:
                if row in existing_rows and pattern_rows[row] in active_patterns:
                    filtered_rows.append(row)
            
            # Build the reorganized list - process by column groups, then by rows within each group
            reorganized = []
            
            # For each column group
            for col_group in column_groups:
                # For each filtered row in this column group
                for row in filtered_rows:
                    # For each column in this group
                    for col in col_group:
                        coordinate = f"{row}{col}"
                        if coordinate in coordinate_list:
                            reorganized.append(coordinate)
            
            return reorganized

        # Get row pattern selections
        row_pattern_0 = protocol.params.row_pattern_0
        row_pattern_1 = protocol.params.row_pattern_1  
        row_pattern_2 = protocol.params.row_pattern_2
        
        # Create list of active patterns
        active_patterns = []
        if row_pattern_0:
            active_patterns.append(0)
        if row_pattern_1:
            active_patterns.append(1)
        if row_pattern_2:
            active_patterns.append(2)
        
        # Ensure at least one pattern is selected
        if not active_patterns:
            protocol.pause('No row patterns selected - please enable at least one pattern and click Resume')
            return

        # Defer expensive calculations during analysis phase
        if not protocol.is_simulating():
            # Generate destinations with proper row handling
            destinations = {}
            for reagent in reagents:
                wells = []
                for num, col in enumerate(params[reagent]['cols']):
                    pattern_index = num % 3
                    rows_for_this_col = get_rows_for_column(col, pattern_index)
                    
                    # Apply offset and skip logic
                    if params[reagent]['skip'] != 1 and pattern_index == 1:
                        start_idx = 2 - params[reagent]['offset']
                    else:
                        start_idx = params[reagent]['offset']
                    
                    selected_rows = rows_for_this_col[start_idx::params[reagent]['skip']]
                    
                    # Generate well names for this column
                    for row in selected_rows:
                        wells.append(row + col)
                
                destinations[reagent] = wells

            protocol.comment(f"Original wax destinations: {str(destinations['wax'])}")
            protocol.comment(f"Active row patterns: {active_patterns}")
            
            final_destinations = {
                'wax': reorganize_list(destinations['wax'], active_patterns)
            }
            
            protocol.comment(f"Final wax destinations: {str(final_destinations['wax'])}")
        else:
            # Placeholder during analysis
            destinations = {}
            final_destinations = {'wax': []}

        dispense = True

        wax = protocol.params.wax
        cartridges_per_deck = protocol.params.cartridges

        # Resume point for a run restarted after a broken tip. (1, 1) = normal full run.
        # Read into the enclosing scope so dispense_reagent() closes over them.
        resume_cartridge = protocol.params.resume_cartridge
        resume_hole = protocol.params.resume_hole

        tube_locations = {
            'wax': 'A3',
        }

        # Column -> gate mapping
        # Gate 4: cols 2,10,18 | Gate 3: cols 4,12,20 | Gate 2: cols 6,14,22 | Gate 1: cols 8,16,24
        COLUMN_GATE = {
            '2':  'wax_gate4', '10': 'wax_gate4', '18': 'wax_gate4',
            '4':  'wax_gate3', '12': 'wax_gate3', '20': 'wax_gate3',
            '6':  'wax_gate2', '14': 'wax_gate2', '22': 'wax_gate2',
            '8':  'wax_gate1', '16': 'wax_gate1', '24': 'wax_gate1',
        }

        # Volume settings per gate (from runtime parameters)
        well_volumes = {
            'wax_gate4': protocol.params.vol_gate4,
            'wax_gate3': protocol.params.vol_gate3,
            'wax_gate2': protocol.params.vol_gate2,
            'wax_gate1': protocol.params.vol_gate1,
        }

        # Dispense rate settings per gate (configurable independently)
        dispense_rates = {
            'wax_gate4': 0.325,
            'wax_gate3': 0.325,
            'wax_gate2': 0.325,
            'wax_gate1': 0.325,
        }

        total_number_of_carts_per_deck = 24
        dead_volume = 50

        # Defer expensive calculation during analysis phase
        if not protocol.is_simulating():
            # Calculate source volume accounting for per-gate volumes
            total_volume_per_deck = sum(
                well_volumes[COLUMN_GATE.get(get_well_column(w), 'wax_gate4')]
                for w in final_destinations['wax']
            )
            
            source_volumes = {
                'wax': dead_volume + (total_volume_per_deck / total_number_of_carts_per_deck) * cartridges_per_deck
            }
            
            protocol.comment(f"Gate volumes — Gate4: {well_volumes['wax_gate4']}uL, Gate3: {well_volumes['wax_gate3']}uL, Gate2: {well_volumes['wax_gate2']}uL, Gate1: {well_volumes['wax_gate1']}uL")
            # protocol.comment(f"Gate volumes — Gate4: {well_volumes['wax_gate4']}uL, Gate3: {well_volumes['wax_gate3']}uL, Gate2: {well_volumes['wax_gate2']}uL")  # GATE 1 DISABLED
            protocol.comment(f"Calculated source volume needed: {source_volumes['wax']}uL")
        else:
            # Placeholder during analysis
            source_volumes = {'wax': 0}

        if dispense and not protocol.is_simulating():        
            if wax:
                adjust = pick_up_and_calibrate_tip()
                dispense_reagent(
                    sources=[tube_locations['wax']], 
                    well_names=final_destinations['wax'], 
                    well_volumes=well_volumes,
                    dispense_rates=dispense_rates,
                    source_volume=source_volumes['wax'], 
                    adjust=adjust, 
                    cartridges_per_deck=cartridges_per_deck,
                )

    finally:
        # Always close serial port, even if there's an error
        if ser and ser.is_open:
            try:
                ser.close()
                protocol.comment('Serial port closed')
            except:
                pass
