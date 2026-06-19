import math
import string 
import serial 
import glob 
from opentrons import protocol_api
from opentrons import types
import collections
import bisect
import time

# Version 2.0 - Optimized for faster analysis phase

metadata = {
    'author': 'Brevitest',
    'description': 'Updated to add support for user inputted parameters. Optimized with is_simulating() to defer expensive calculations during analysis. v2.1: added persistent tip tracking.',
} 

requirements = {"robotType": "OT-2", "apiLevel": "2.19"}

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
        variable_name="run_calibration_check",
        display_name="RUN CALIBRATION CHECK",
        description="If enabled, runs a 9-well calibration check before dispensing to verify tip alignment.",
        default=False
    )

    parameters.add_bool(
        variable_name="tiprack_refilled",
        display_name="Tiprack Refilled",
        description="Set to True if you have refilled the tiprack. Resets tip tracking to position A1.",
        default=False
    )
    
    # NOTE: Gen6 has 4 reagent cols per group: well_2 (beads), well_3 (wash), well_4 (wash), well_5 (elution)
    # Gen5 had 6 reagent cols (wells 2-7); Gen6 has 4 (wells 2-5): beads, wash, wash, elution
    
    parameters.add_bool(
        variable_name="well_2a",
        display_name="Well 2a",
        description="Determines whether well 2a (beads) is dispensed.",
        default=False
    )
    
    parameters.add_bool(
        variable_name="well_2b",
        display_name="Well 2b",
        description="Determines whether well 2b (beads) is dispensed.",
        default=False
    )
    parameters.add_bool(
        variable_name="well_2c",
        display_name="Well 2c",
        description="Determines whether well 2c (beads) is dispensed.",
        default=False
    )

    parameters.add_bool(
        variable_name="well_3a",
        display_name="Well 3a",
        description="Determines whether well 3a (tracer) is dispensed.",
        default=False
    )

    parameters.add_bool(
        variable_name="well_3b",
        display_name="Well 3b",
        description="Determines whether well 3b (tracer) is dispensed.",
        default=False
    )

    parameters.add_bool(
        variable_name="well_3c",
        display_name="Well 3c",
        description="Determines whether well 3c (tracer) is dispensed.",
        default=False
    )

    parameters.add_bool(
        variable_name="well_4a",
        display_name="Well 4a",
        description="Determines whether well 4a (wash) is dispensed.",
        default=False
    )

    parameters.add_bool(
        variable_name="well_4b",
        display_name="Well 4b",
        description="Determines whether well 4b (wash) is dispensed.",
        default=False
    )

    parameters.add_bool(
        variable_name="well_4c",
        display_name="Well 4c",
        description="Determines whether well 4c (wash) is dispensed.",
        default=False
    )
    
    parameters.add_bool(
        variable_name="well_5a",
        display_name="Well 5a",
        description="Determines whether well 5a (elution) is dispensed.",
        default=False
    )

    parameters.add_bool(
        variable_name="well_5b",
        display_name="Well 5b",
        description="Determines whether well 5b (elution) is dispensed.",
        default=False
    )

    parameters.add_bool(
        variable_name="well_5c",
        display_name="Well 5c",
        description="Determines whether well 5c (elution) is dispensed.",
        default=False
    )
    # Gen6: 4 reagent cols per group - well_2 (beads), well_3 (wash), well_4 (wash), well_5 (elution)
    
    parameters.add_bool(
        variable_name="well_2",
        display_name="All Well 2 (Beads)",
        description="FILLS ALL WELLS IN ROW 2 (BEADS)",
        default=True
    )
    
    parameters.add_bool(
        variable_name="well_3",
        display_name="All Well 3 (tracer)",
        description="FILLS ALL WELLS IN ROW 3 (tracer)",
        default=True
    )

    parameters.add_bool(
        variable_name="well_4",
        display_name="All Well 4 (Wash)",
        description="FILLS ALL WELLS IN ROW 4 (WASH)",
        default=True
    )

    parameters.add_bool(
        variable_name="well_5",
        display_name="All Well 5 (Elution)",
        description="FILLS ALL WELLS IN ROW 5 (ELUTION)",
        default=True
    )

    # ==================================================================
    # NATIVE-CALIBRATION-SYSTEM PRD 6 — BIMS-driven calibration RTPs.
    # When bims_native is True, the global offset (supplied by BIMS from
    # RobotDeckOffset) replaces the built-in ROBOT_OFFSETS table and is
    # applied to ALL labware (deck carriage + tube rack + tip rack), not
    # just the carriage. Defaults reproduce current behavior, so a run
    # with no BIMS values (manual/Opentrons app) is unchanged. The
    # calibrator point + z_cal are read here too (defaults = the
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
        description="Tip-calibration probe Z (p300 200uL reagent tip).",
        default=40.8, minimum=0.0, maximum=200.0, unit="mm")

def run(protocol: protocol_api.ProtocolContext):
    # =====================================================================
    # AUTO-DETECT ROBOT & APPLY PER-ROBOT OFFSETS
    # =====================================================================
    # Each OT-2 has a unique serial number readable via hostname.
    # The protocol auto-detects which robot it's running on and applies
    # the correct XYZ offsets — no operator input needed.
    #
    # Robots:
    #   Left   = OT2CEP20200309B14  (B14)
    #   Middle = OT2CEP20210817R04  (R04)
    #   Right  = OT2CEP20200217B07  (B07)
    # =====================================================================
    import socket
    
    ROBOT_OFFSETS = {
        'muddy-water':       { 'name': 'Left (B14)',   'x': 0.0, 'y': 0.0, 'z': 0.0 },
        'OT2CEP20210817R04': { 'name': 'Middle (R04)', 'x': 0.0, 'y': 0.0, 'z': 0.0 },
        'hidden-leaf':       { 'name': 'Right (B07)',  'x': 0.2, 'y': -0.35, 'z': -0.35 },
    }
    DEFAULT_OFFSETS = { 'name': 'Unknown', 'x': 0.0, 'y': 0.0, 'z': 0.0 }
    
    hostname = socket.gethostname()
    robot_offsets = ROBOT_OFFSETS.get(hostname, DEFAULT_OFFSETS)
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

    offset = { 'x': 0, 'y': 0 }
    tuberack = protocol.load_labware('custom_2ml_24_tube_rack', 10)
    tiprack = protocol.load_labware('cosmas_and_damian_biotix_96_200ul_tiprack', 11)
    pipette = protocol.load_instrument('p300_single_gen2', mount='left', tip_racks=[tiprack])

    # PRD 6: in BIMS-native mode the global offset shifts the tube rack + tip rack
    # too (the carriage is shifted later, where it's loaded by particle ID). In the
    # legacy table mode this is skipped so behavior is byte-for-byte unchanged.
    if bims_native:
        tuberack.set_offset(x=robot_offsets['x'], y=robot_offsets['y'], z=robot_offsets['z'])
        tiprack.set_offset(x=robot_offsets['x'], y=robot_offsets['y'], z=robot_offsets['z'])

    # =====================================================================
    # PERSISTENT TIP TRACKING
    # Stores next-tip index in /data/tip_tracker_reagent_<hostname>.json.
    # Separate file from wax protocol tracker — different tiprack.
    # Survives protocol reloads and reboots. One file per robot via hostname.
    # =====================================================================
    import json as _json
    import os as _os

    _tip_state_path = f'/data/tip_tracker_reagent_{hostname}.json'
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
        'e00fce68fc3b723490857c78' : protocol.load_labware('gen4deck_gen7cartridge_003', protocol_api.OFF_DECK)
    }       
    
    #'e00fce680a100a70d1fea1a3' : protocol.load_labware('gen4deck_gen7cartridge_004', protocol_api.OFF_DECK),
    #'e00fce68356060b112c98173' : protocol.load_labware('gen4deck_gen7cartridge_004', protocol_api.OFF_DECK),
    
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
    
    # Try to open serial port with better error handling
    for port in glob.glob('/dev/ttyACM?'):
        try:
            ser = serial.Serial(port=port, baudrate=115200, timeout=0.5)
            # Give device time to initialize after opening
            time.sleep(0.2)
            # Flush any stale data
            ser.reset_input_buffer()
            ser.reset_output_buffer()
            protocol.comment(f'Successfully opened serial port: {port}')
            break
        except Exception as e:
            protocol.comment(f'Exception testing port {port}: {str(e)}')
            if ser and ser.is_open:
                ser.close()
            ser = None
    
    if not ser or not ser.is_open:
        protocol.pause('Unable to open serial port - click Resume to continue')
        return
    
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
            protocol.pause(f'Error reading offset data: {str(e)} - click Resume to continue')
            ser.close()
            return

        # Read particle ID with retry logic
        try:
            serial_write_with_retry(ser, b'I')
            particle_id_raw = serial_read_with_retry(ser)
            # Decode bytes to string and strip whitespace/newlines, then extract 24-character ID
            particle_id = particle_id_raw.decode('utf-8', errors='ignore').strip()[:24]
            if particle_id not in carriages:
                raise ValueError(f'Unknown particle ID: {particle_id}')
            carriage = carriages[particle_id]
            protocol.move_labware(labware=carriage, new_location=1)
            # Apply per-robot offsets to all well positions on this labware
            carriage.set_offset(
                x=robot_offsets['x'],
                y=robot_offsets['y'],
                z=robot_offsets['z']
            )
            protocol.comment(f'Loaded carriage for particle ID: {particle_id}')
            protocol.comment(f'Applied robot offsets: x={robot_offsets["x"]}, y={robot_offsets["y"]}, z={robot_offsets["z"]}')
        except Exception as e:
            protocol.pause(f'Error reading particle ID: {str(e)} - click Resume to continue')
            ser.close()
            return

        # Calibration check wells - 9 positions across the deck
        calibration_check_wells = ['W3', 'L5', 'B7', 'B15', 'L13', 'W11', 'W19', 'L21', 'B23']
        
        def run_calibration_check(adjust):
            """
            Runs a 9-well calibration check routine.
            Moves to each well using the exact same movement pattern as dispensing.
            """
            # Match exact values from dispense_reagent function
            jump_height = 60
            well_prejump_height = 5
            well_z_depth = -3.0
            z_offset_for_dispense = 5.0
            
            for i, well_name in enumerate(calibration_check_wells):
                well = carriage[well_name]
                
                # Step 1: Move to jump height above well
                # (matches: pipette.move_to(well.top(jump_height).move(types.Point(adjust['x'], adjust['y'], 0.0))))
                pipette.move_to(well.top(jump_height).move(types.Point(adjust['x'], adjust['y'], 0.0)))
                
                # Step 2: Move to dispense position
                # (matches: pipette.dispense(..., well.top(well_z_depth).move(types.Point(adjust['x'], adjust['y'], 5.0)), rate=0.325))
                pipette.move_to(well.top(well_z_depth).move(types.Point(adjust['x'], adjust['y'], z_offset_for_dispense)))
                
                # Pause at dispense position for visual check
                protocol.pause(f'Calibration check {i+1}/9: Well {well_name} - Click Resume to proceed.')
                
                # Step 3: Move to prejump height
                # (matches: pipette.move_to(well.top(well_prejump_height).move(types.Point(adjust['x'], adjust['y'], 0.0))))
                pipette.move_to(well.top(well_prejump_height).move(types.Point(adjust['x'], adjust['y'], 0.0)))
                
                # Step 4: Delay
                # (matches: protocol.delay(seconds = 0.25))
                protocol.delay(seconds=0.25)
            
            # Final move up to jump height at last well
            pipette.move_to(carriage[calibration_check_wells[-1]].top(jump_height).move(types.Point(adjust['x'], adjust['y'], 0.0)))
            
            return True

        def pick_up_and_calibrate_tip():
            nonlocal _tip_index
            # PRD 6: calibrator point + probe Z are RTPs (defaults = previously
            # hardcoded values; z_cal for the 200uL VWR tip). Move points track
            # cal_x/cal_y; the limit-switch constants shift by the same delta so
            # the returned offset is invariant when the calibrator isn't re-tuned.
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

            x_pos = cal_x - 1.4
            y_pos = cal_y - 7.0
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

            yOffset = round(offset['y'] - shift, 1)

            pipette.move_to(types.Location(types.Point(x=cal_x, y=cal_y, z=z_cal), carriage), force_direct=True, speed=20)
            pipette.move_to(types.Location(types.Point(x=cal_x, y=cal_y, z=z_cal + 20), carriage), force_direct=True, speed=20)
            
            return { 'x': xOffset, 'y': yOffset }

        # =====================================================================
        # ASPIRATION HEIGHT SYSTEM
        # =====================================================================
        #
        # HOW IT WORKS:
        #   1. We know how much liquid is in the source tube (source_volume)
        #   2. The lookup table converts volume → liquid height in mm from tube bottom
        #   3. We add tube_bottom_height to get absolute position from the deck
        #   4. We subtract aspirate_cover to put the tip slightly BELOW the surface
        #   5. We clamp so the tip never goes below the physical tube bottom
        #
        # THE TIP POSITION EQUATION:
        #   liquid_surface_z = tube_bottom_height + lookup(volume)
        #   target_tip_z     = liquid_surface_z - aspirate_cover + HEIGHT_ADJUST
        #   target_tip_z     = max(target_tip_z, tip_floor_z)   ← safety clamp
        #   depth_below_rim  = tube_rim_height - target_tip_z
        #   pipette command:   source_well.top(-depth_below_rim)
        #
        # =====================================================================

        # ----- MASTER TUNING KNOB -----
        # Positive = entire system moves UP (tip higher in tube, farther from bottom)
        # Negative = entire system moves DOWN (tip lower in tube, closer to bottom)
        # Example: if tip is consistently 2mm too low, set this to +2.0
        HEIGHT_ADJUST = 0.0
        # -------------------------------

        # ----- Tube Physical Dimensions -----
        # tube_rim_height: distance in mm from the robot deck to the TOP RIM of the 2mL tube
        # This is what the Opentrons .top(0) position corresponds to
        tube_rim_height = 89

        # tube_bottom_height: distance in mm from the robot deck to the INNER BOTTOM of the 2mL tube
        # The liquid sits on top of this. Measured/calibrated value.
        tube_bottom_height = 48.20

        # ----- Tip Safety Limits -----
        # min_tip_clearance: mm above tube bottom the tip is allowed to go
        # This prevents the tip from crashing into the bottom of the tube
        min_tip_clearance = 1.5

        # tip_floor_z: absolute deck height (mm) the tip will never go below
        # = tube_bottom_height + min_tip_clearance = 55.6 + 1.5 = 57.1mm from deck
        tip_floor_z = tube_bottom_height + min_tip_clearance

        # ----- Aspiration Positioning -----
        # aspirate_cover: how many mm BELOW the liquid surface to position the tip
        # Ensures the tip is submerged enough to aspirate without pulling air
        aspirate_cover = 2.0

        # ----- Volume Constants -----
        # disposal_volume: extra volume aspirated beyond what's needed for dispensing,
        # used to account for the liquid left in the tip after dispensing
        disposal_volume = 10

        # aspirate_remainder: additional volume to account for pipette dead space
        # wells_per_run × well_volume + disposal_volume + aspirate_remainder = total aspirated
        aspirate_remainder = 1.979

        # maximum_volume_per_aspiration: max volume the pipette should aspirate in one go
        # Used to calculate how many wells can be filled per aspiration run
        maximum_volume_per_aspiration = 200

        # pipette_tip_capacity: absolute max the tip can hold (safety check only)
        pipette_tip_capacity = 210


        def source_height(source_volume):
            """
            Converts remaining liquid volume (µL) → absolute tip height from deck (mm).

            Steps:
              1. Look up volume in the table to get liquid height from tube bottom (mm)
              2. Interpolate linearly between the two nearest table entries
              3. Add tube_bottom_height to convert from "mm from bottom" → "mm from deck"

            Returns: float, mm from deck to liquid surface

            NOTE: The lookup table was empirically measured for NEST 2mL snap-cap tubes.
            If you switch tube types, this table needs to be re-measured.
            """
            # Lookup table: volume (µL) → liquid height (mm) measured from INNER BOTTOM of tube
            # These values are empirical measurements for water in NEST 2mL snap-cap tubes
            lookup_table = {
                50:   0.01,   # 50µL  → liquid is 0.50mm above tube bottom
                100:  0.02,   # 100µL → liquid is 1.05mm above tube bottom
                150:  0.03,
                200:  1.27,
                300:  2.41,
                400:  4.60,
                500:  5.80,
                750:  9.71,
                1000: 13.82,
                1500: 22.03,
                2000: 28.30,
                2250: 31.76,  # 2250µL → liquid is 33.76mm above tube bottom (near rim)
            }

            volumes = list(lookup_table.keys())
            heights = list(lookup_table.values())

            # --- Clamp to table bounds (no extrapolation) ---
            if source_volume <= volumes[0]:
                # Volume at or below table minimum — return the lowest known height
                return tube_bottom_height + heights[0]

            if source_volume >= volumes[-1]:
                # Volume at or above table maximum — return the highest known height
                return tube_bottom_height + heights[-1]

            # --- Find the two table entries that bracket the current volume ---
            idx = bisect.bisect_left(volumes, source_volume)
            # idx points to the first entry >= source_volume
            # We interpolate between idx-1 (below) and idx (above)

            vol_below  = volumes[idx - 1]   # table entry just under our volume
            vol_above  = volumes[idx]       # table entry just over our volume
            height_below = heights[idx - 1] # corresponding height (mm from bottom)
            height_above = heights[idx]     # corresponding height (mm from bottom)

            # --- Linear interpolation ---
            # How far between the two entries is our volume? (0.0 to 1.0)
            fraction = (source_volume - vol_below) / (vol_above - vol_below)

            # Interpolated liquid height from tube bottom
            liquid_height_from_bottom = height_below + (height_above - height_below) * fraction

            # Convert to absolute deck coordinates
            # = tube_bottom_height + liquid_height_from_bottom
            liquid_surface_z = tube_bottom_height + liquid_height_from_bottom

            return liquid_surface_z


        def dispense_reagent(sources, wells, well_volume, source_volume, adjust, cartridges_per_deck):
            """
            Aspirates reagent from source tubes and dispenses into cartridge wells.

            For each aspiration run:
              1. Calculate how much volume we'll aspirate
              2. Find where the liquid surface will be AFTER aspiration (worst case)
              3. Position the tip aspirate_cover mm below that surface
              4. Clamp to tip_floor_z so we never hit the tube bottom
              5. Apply HEIGHT_ADJUST for manual tuning
              6. Convert to depth below rim and send the pipette command
            """

            # Build list of wells to fill based on how many cartridges we're doing
            wells_to_fill = []
            wells_on_cart = int(len(wells) / 24)
            for i in range(cartridges_per_deck * wells_on_cart):
                wells_to_fill.append(wells[i])

            for source in sources:
                source_well = tuberack[source]
                destination_wells = [carriage[well] for well in wells_to_fill]

                # How many wells can we fill per aspiration?
                # = floor((max_aspirate - remainder) / volume_per_well)
                wells_per_run = math.floor((maximum_volume_per_aspiration - aspirate_remainder) / well_volume)

                # Total runs needed
                runs = math.ceil(len(destination_wells) / wells_per_run)
                protocol.comment(f'dispense_reagent: source={source}, {len(destination_wells)} wells, {runs} runs')

                # Dispensing pattern counters
                jump_count = 0
                jump_frequency = 3    # every 3rd well, do an extra high move
                jump_height = 60      # mm above well for the jump move

                for run in range(runs):
                    # ----- Determine which wells this run fills -----
                    start_well = run * wells_per_run
                    wells_this_run = destination_wells[start_well:start_well + wells_per_run]

                    # ----- Calculate total aspiration volume for this run -----
                    # = (number of wells × volume per well) + disposal + remainder
                    aspirate_volume = len(wells_this_run) * well_volume + disposal_volume + aspirate_remainder

                    # ----- Safety checks -----
                    if aspirate_volume <= 0:
                        protocol.comment('WARNING: Invalid aspirate volume, skipping this run')
                        continue
                    if aspirate_volume > pipette_tip_capacity:
                        protocol.comment(f'WARNING: aspirate volume {aspirate_volume:.1f}uL exceeds tip capacity {pipette_tip_capacity}uL')

                    # =========================================================
                    # TIP HEIGHT CALCULATION
                    # =========================================================
                    #
                    # We position the tip based on where the liquid will be AFTER
                    # this aspiration (not before). This is the lowest the liquid
                    # will get during this run, so the tip stays submerged.
                    #
                    # Step 1: What's the liquid height after we aspirate?
                    volume_after_aspirate = source_volume - aspirate_volume
                    liquid_z_after = source_height(volume_after_aspirate)
                    #   → liquid_z_after is in mm from deck
                    #   → e.g., if 500µL left: 55.6 + 7.80 = 63.4mm from deck

                    # Step 2: Position tip aspirate_cover mm below the surface
                    target_tip_z = liquid_z_after - aspirate_cover
                    #   → e.g., 63.4 - 2.0 = 61.4mm from deck

                    # Step 3: Apply HEIGHT_ADJUST (master tuning knob)
                    target_tip_z = target_tip_z + HEIGHT_ADJUST
                    #   → if HEIGHT_ADJUST = +2.0: tip moves up 2mm → 63.4mm
                    #   → if HEIGHT_ADJUST = -1.0: tip moves down 1mm → 60.4mm

                    # Step 4: Safety clamp — never go below tip_floor_z
                    if target_tip_z < tip_floor_z:
                        protocol.comment(f'  CLAMPED: target {target_tip_z:.1f}mm below floor {tip_floor_z:.1f}mm, clamping to floor')
                        target_tip_z = tip_floor_z
                    #   → tip_floor_z = 57.1mm (1.5mm above tube bottom)

                    # Step 5: Convert to depth below rim (for .top() command)
                    # The Opentrons .top(-X) means X mm below the rim
                    depth_below_rim = tube_rim_height - target_tip_z
                    #   → e.g., 89 - 61.4 = 27.6mm below rim
                    #   → command: source_well.top(-27.6)

                    # ----- Debug output -----
                    protocol.comment(f'  Run {run+1}/{runs}: {len(wells_this_run)} wells, aspirate {aspirate_volume:.1f}uL')
                    protocol.comment(f'    volume before: {source_volume:.0f}uL, after: {volume_after_aspirate:.0f}uL')
                    protocol.comment(f'    liquid surface after: {liquid_z_after:.1f}mm from deck')
                    protocol.comment(f'    tip target: {target_tip_z:.1f}mm from deck ({depth_below_rim:.1f}mm below rim)')
                    protocol.comment(f'    HEIGHT_ADJUST: {HEIGHT_ADJUST:+.1f}mm')

                    # =========================================================
                    # ASPIRATE
                    # =========================================================
                    pipette.aspirate(aspirate_volume, source_well.top(-depth_below_rim))
                    pipette.touch_tip()

                    # Dispense a tiny amount back to relieve pressure at tip
                    if pipette.current_volume > 0.25:
                        pipette.dispense(0.25, source_well.top(), rate=0.325)

                    # =========================================================
                    # DISPENSE INTO WELLS
                    # =========================================================
                    dispensed_volume = 0
                    well_z_depth = -3.0        # mm below well top to dispense at
                    well_prejump_height = 5    # mm above well top for pre-jump move

                    for well in wells_this_run:
                        # Every jump_frequency wells, do an extra high move to clear obstacles
                        if jump_count % jump_frequency == 0:
                            pipette.move_to(well.top(jump_height).move(types.Point(adjust['x'], adjust['y'], 0.0)))
                        pipette.move_to(well.top(jump_height).move(types.Point(adjust['x'], adjust['y'], 0.0)))
                        pipette.dispense(well_volume, well.top(well_z_depth).move(types.Point(adjust['x'], adjust['y'], 5.0)), rate=0.325)
                        pipette.move_to(well.top(well_prejump_height).move(types.Point(adjust['x'], adjust['y'], 0.0)))
                        protocol.delay(seconds=0.25)
                        jump_count += 1
                        dispensed_volume += well_volume

                    # Blow out remaining liquid back into source tube
                    pipette.blow_out(location=source_well.bottom(2.4))

                    # Update remaining source volume (only subtract what was actually dispensed)
                    source_volume -= dispensed_volume

                    # Extra blow out between runs
                    if run < runs - 1 or runs == 1:
                        pipette.blow_out(location=source_well.bottom(2.4))

                pipette.drop_tip()

        params = {
            'well_2a': { 'cols': ['7', '15', '23'], 'skip': 3, 'offset': 2 },
            'well_2b': { 'cols': ['7', '15', '23'], 'skip': 3, 'offset': 1 },
            'well_2c': { 'cols': ['7', '15', '23'], 'skip': 3, 'offset': 0 },
            'well_3a': { 'cols': ['5', '13', '21'], 'skip': 3, 'offset': 2 },
            'well_3b': { 'cols': ['5', '13', '21'], 'skip': 3, 'offset': 1 }, 
            'well_3c': { 'cols': ['5', '13', '21'], 'skip': 3, 'offset': 0 }, 
            'well_4a': { 'cols': ['3', '11', '19'], 'skip': 3, 'offset': 2 },
            'well_4b': { 'cols': ['3', '11', '19'], 'skip': 3, 'offset': 1 },
            'well_4c': { 'cols': ['3', '11', '19'], 'skip': 3, 'offset': 0 },
            'well_5a': { 'cols': ['1', '9', '17'], 'skip': 3, 'offset': 2 },
            'well_5b': { 'cols': ['1', '9', '17'], 'skip': 3, 'offset': 1 },
            'well_5c': { 'cols': ['1', '9', '17'], 'skip': 3, 'offset': 0 },
            'well_2': { 'cols': ['7', '15', '23'], 'skip': 1, 'offset': 0 },
            'well_3': { 'cols': ['5', '13', '21'], 'skip': 1, 'offset': 0 },
            'well_4': { 'cols': ['3', '11', '19'], 'skip': 1, 'offset': 0 },
            'well_5': { 'cols': ['1', '9', '17'], 'skip': 1, 'offset': 0 },
        }

        reagents = list(params)
        rows = [list('XWVUTSRQPONMLKJIHGFEDCBA'), list('ABCDEFGHIJKLMNOPQRSTUVWX'), list('XWVUTSRQPONMLKJIHGFEDCBA')]

        #combines params and rows to create an array in format A1, B1...
        # Defer expensive calculation during analysis phase
        if not protocol.is_simulating():
            destinations = dict(
                zip(
                    reagents,
                    (
                        [ row + col for num, col in enumerate(params[reagent]['cols']) for row in rows[(num % 3)]
                            [(2 - params[reagent]['offset'] if params[reagent]['skip'] != 1 and (num % 3) == 1 else params[reagent]['offset'])::params[reagent]['skip']]
                        ] for reagent in reagents
                    )
                )
            )
        else:
            # Placeholder during analysis
            destinations = {}

        #function to concatenate two lists of reagents together alteranting elements from each list, used for beads and tracer
        def alternate_concatenate(list1, list2):
            new_list = []
            # Ensure both lists have the same length
            if len(list1) == len(list2):
                for i in range(len(list1)):
                    new_list.append(list1[i])
                    new_list.append(list2[i])
                    
                return new_list
            else:
                print("Error: Lists must have the same length.")
        
        #function to concatenate two lists of unequal amounts of reagents together used for wash
        def one_2_three_concatenate(list1, list2):
            new_list = []
            i = 0
            j = 0

            while i < len(list1):
                new_list.append(list1[i])
                i += 1
                new_list.append(list2[j])
                new_list.append(list2[j+1])
                new_list.append(list2[j+2])
                j += 3
            return new_list

        # Defer expensive calculation during analysis phase
        if not protocol.is_simulating():
            final_destinations = {
                'well_2a':destinations['well_2a'],
                'well_2b':destinations['well_2b'],
                'well_2c':destinations['well_2c'],
                'well_3a':destinations['well_3a'],
                'well_3b':destinations['well_3b'],
                'well_3c':destinations['well_3c'],
                'well_4a': destinations['well_4a'],
                'well_4b': destinations['well_4b'],
                'well_4c': destinations['well_4c'],
                'well_5a': destinations['well_5a'],
                'well_5b': destinations['well_5b'],
                'well_5c': destinations['well_5c'],
                'well_2': destinations['well_2'],
                'well_3': destinations['well_3'],
                'well_4': destinations['well_4'],
                'well_5': destinations['well_5']
            }
        else:
            # Placeholder during analysis
            final_destinations = {}


        dispense = True

        well_2a = protocol.params.well_2a
        well_2b = protocol.params.well_2b
        well_2c = protocol.params.well_2c
        well_3a = protocol.params.well_3a
        well_3b = protocol.params.well_3b
        well_3c = protocol.params.well_3c
        well_4a = protocol.params.well_4a
        well_4b = protocol.params.well_4b
        well_4c = protocol.params.well_4c
        well_5a = protocol.params.well_5a
        well_5b = protocol.params.well_5b
        well_5c = protocol.params.well_5c
        well_2 = protocol.params.well_2
        well_3 = protocol.params.well_3
        well_4 = protocol.params.well_4
        well_5 = protocol.params.well_5

        #specify from 1 - 20 how many cartidges are to be filled
        cartridges_per_deck = protocol.params.cartridges

        # Gen6: 4 reagent types - well_2 (beads)=D3, well_3 (wash)=D4, well_4 (wash)=D5, well_5 (elution)=D6
        tube_locations = {
            'well_2a': 'D3',
            'well_2b': 'D3',
            'well_2c': 'D3',
            'well_3a': 'D4',
            'well_3b': 'D4',
            'well_3c': 'D4',
            'well_4a': 'D5',
            'well_4b': 'D5',
            'well_4c': 'D5',
            'well_5a': 'D6',
            'well_5b': 'D6',
            'well_5c': 'D6',
            'well_2': 'D3',
            'well_3': 'D4',
            'well_4': 'D5',
            'well_5': 'D6',
        }

        well_volumes = {
            'well_2a': 19,
            'well_2b': 19,
            'well_2c': 19,
            'well_3a': 19,
            'well_3b': 19,
            'well_3c': 19,
            'well_4a': 19,
            'well_4b': 19,
            'well_4c': 19,
            'well_5a': 19,
            'well_5b': 19,
            'well_5c': 19,
            'well_2': 19,
            'well_3': 19,
            'well_4': 19,
            'well_5': 19,
        }


        total_number_of_carts_per_deck = 24
        dead_volume = 50

        # Defer expensive calculation during analysis phase
        if not protocol.is_simulating():
            source_volumes = {
                'well_2a': dead_volume + (well_volumes['well_2a'] * (len(final_destinations['well_2a'])/total_number_of_carts_per_deck) * cartridges_per_deck),
                'well_2b': dead_volume + (well_volumes['well_2b'] * (len(final_destinations['well_2b'])/total_number_of_carts_per_deck) * cartridges_per_deck),
                'well_2c': dead_volume + (well_volumes['well_2c'] * (len(final_destinations['well_2c'])/total_number_of_carts_per_deck) * cartridges_per_deck),
                'well_3a': dead_volume + (well_volumes['well_3a'] * (len(final_destinations['well_3a'])/total_number_of_carts_per_deck) * cartridges_per_deck),
                'well_3b': dead_volume + (well_volumes['well_3b'] * (len(final_destinations['well_3b'])/total_number_of_carts_per_deck) * cartridges_per_deck),
                'well_3c': dead_volume + (well_volumes['well_3c'] * (len(final_destinations['well_3c'])/total_number_of_carts_per_deck) * cartridges_per_deck),
                'well_4a': dead_volume + (well_volumes['well_4a'] * (len(final_destinations['well_4a'])/total_number_of_carts_per_deck) * cartridges_per_deck),
                'well_4b': dead_volume + (well_volumes['well_4b'] * (len(final_destinations['well_4b'])/total_number_of_carts_per_deck) * cartridges_per_deck),
                'well_4c': dead_volume + (well_volumes['well_4c'] * (len(final_destinations['well_4c'])/total_number_of_carts_per_deck) * cartridges_per_deck),
                'well_5a': dead_volume + (well_volumes['well_5a'] * (len(final_destinations['well_5a'])/total_number_of_carts_per_deck) * cartridges_per_deck),
                'well_5b': dead_volume + (well_volumes['well_5b'] * (len(final_destinations['well_5b'])/total_number_of_carts_per_deck) * cartridges_per_deck),
                'well_5c': dead_volume + (well_volumes['well_5c'] * (len(final_destinations['well_5c'])/total_number_of_carts_per_deck) * cartridges_per_deck),
                'well_2': dead_volume + (well_volumes['well_2'] * (len(final_destinations['well_2'])/total_number_of_carts_per_deck) * cartridges_per_deck),
                'well_3': dead_volume + (well_volumes['well_3'] * (len(final_destinations['well_3'])/total_number_of_carts_per_deck) * cartridges_per_deck),
                'well_4': dead_volume + (well_volumes['well_4'] * (len(final_destinations['well_4'])/total_number_of_carts_per_deck) * cartridges_per_deck),
                'well_5': dead_volume + (well_volumes['well_5'] * (len(final_destinations['well_5'])/total_number_of_carts_per_deck) * cartridges_per_deck),
            }
        else:
            # Placeholder during analysis
            source_volumes = {}

        # Calibration check routine - runs before dispensing if enabled
        calibration_adjust = None  # Will store adjust values if calibration check runs
        
        if not protocol.is_simulating():
            run_calibration_check_param = protocol.params.run_calibration_check
            
            if run_calibration_check_param:
                # Pick up tip and calibrate to get the adjustment values
                protocol.comment('Calibration check enabled. Picking up tip and calibrating...')
                calibration_adjust = pick_up_and_calibrate_tip()
                protocol.comment(f'Tip calibration complete: x={calibration_adjust["x"]}, y={calibration_adjust["y"]}')
                
                # Run the 9-well calibration check
                run_calibration_check(calibration_adjust)
                
                # After calibration check, ask if user wants to continue
                protocol.pause('Continue run? Click Resume for YES to continue with reagent dispensing. Click Cancel/Stop for NO to end the run.')
                
                # Drop the calibration tip and reset so dispensing starts fresh
                if pipette.has_tip:
                    pipette.drop_tip()
                calibration_adjust = None
                protocol.comment('Calibration check complete. Starting reagent dispensing with fresh tip...')

        # Helper function to get calibration - uses stored values if available, otherwise calibrates new tip
        def get_calibration():
            nonlocal calibration_adjust
            if calibration_adjust is not None and pipette.has_tip:
                # Use the stored calibration from calibration check
                stored_adjust = calibration_adjust
                calibration_adjust = None  # Clear so subsequent calls do normal calibration
                protocol.comment(f'Using calibration from check: x={stored_adjust["x"]}, y={stored_adjust["y"]}')
                return stored_adjust
            else:
                # Normal path - pick up new tip and calibrate
                return pick_up_and_calibrate_tip()

        if dispense and not protocol.is_simulating():
            if well_2a:
                adjust = get_calibration()
                dispense_reagent([tube_locations['well_2a']], final_destinations['well_2a'], well_volume=well_volumes['well_2a'], source_volume= source_volumes['well_2a'], adjust=adjust, cartridges_per_deck = cartridges_per_deck)
            
            if well_2b:
                adjust = get_calibration()
                dispense_reagent([tube_locations['well_2b']], final_destinations['well_2b'], well_volume=well_volumes['well_2b'], source_volume= source_volumes['well_2b'], adjust=adjust, cartridges_per_deck = cartridges_per_deck)

            if well_2c:
                adjust = get_calibration()
                dispense_reagent([tube_locations['well_2c']], final_destinations['well_2c'], well_volume=well_volumes['well_2c'], source_volume= source_volumes['well_2c'], adjust=adjust, cartridges_per_deck = cartridges_per_deck)

            if well_3a:
                adjust = get_calibration()
                dispense_reagent([tube_locations['well_3a']], final_destinations['well_3a'], well_volume=well_volumes['well_3a'], source_volume= source_volumes['well_3a'], adjust=adjust, cartridges_per_deck = cartridges_per_deck)
            
            if well_3b:
                adjust = get_calibration()
                dispense_reagent([tube_locations['well_3b']], final_destinations['well_3b'], well_volume=well_volumes['well_3b'], source_volume= source_volumes['well_3b'], adjust=adjust, cartridges_per_deck = cartridges_per_deck)

            if well_3c:
                adjust = get_calibration()
                dispense_reagent([tube_locations['well_3c']], final_destinations['well_3c'], well_volume=well_volumes['well_3c'], source_volume= source_volumes['well_3c'], adjust=adjust, cartridges_per_deck = cartridges_per_deck)

            if well_4a:
                adjust = get_calibration()
                dispense_reagent([tube_locations['well_4a']], final_destinations['well_4a'], well_volume=well_volumes['well_4a'], source_volume= source_volumes['well_4a'], adjust=adjust, cartridges_per_deck = cartridges_per_deck)
            
            if well_4b:
                adjust = get_calibration()
                dispense_reagent([tube_locations['well_4b']], final_destinations['well_4b'], well_volume=well_volumes['well_4b'], source_volume= source_volumes['well_4b'], adjust=adjust, cartridges_per_deck = cartridges_per_deck)

            if well_4c:
                adjust = get_calibration()
                dispense_reagent([tube_locations['well_4c']], final_destinations['well_4c'], well_volume=well_volumes['well_4c'], source_volume= source_volumes['well_4c'], adjust=adjust, cartridges_per_deck = cartridges_per_deck)

            if well_5a:
                adjust = get_calibration()
                dispense_reagent([tube_locations['well_5a']], final_destinations['well_5a'], well_volume=well_volumes['well_5a'], source_volume= source_volumes['well_5a'], adjust=adjust, cartridges_per_deck = cartridges_per_deck)
            
            if well_5b:
                adjust = get_calibration()
                dispense_reagent([tube_locations['well_5b']], final_destinations['well_5b'], well_volume=well_volumes['well_5b'], source_volume= source_volumes['well_5b'], adjust=adjust, cartridges_per_deck = cartridges_per_deck)
            
            if well_5c:
                adjust = get_calibration()
                dispense_reagent([tube_locations['well_5c']], final_destinations['well_5c'], well_volume=well_volumes['well_5c'], source_volume= source_volumes['well_5c'], adjust=adjust, cartridges_per_deck = cartridges_per_deck)

            if well_2:
                adjust = get_calibration()
                dispense_reagent([tube_locations['well_2']], final_destinations['well_2'], well_volume=well_volumes['well_2'], source_volume= source_volumes['well_2'], adjust=adjust, cartridges_per_deck = cartridges_per_deck)

            if well_3:
                adjust = get_calibration()
                dispense_reagent([tube_locations['well_3']], final_destinations['well_3'], well_volume=well_volumes['well_3'], source_volume= source_volumes['well_3'], adjust=adjust, cartridges_per_deck = cartridges_per_deck)
            
            if well_4:
                adjust = get_calibration()
                dispense_reagent([tube_locations['well_4']], final_destinations['well_4'], well_volume=well_volumes['well_4'], source_volume= source_volumes['well_4'], adjust=adjust, cartridges_per_deck = cartridges_per_deck)
           
            if well_5:
                adjust = get_calibration()
                dispense_reagent([tube_locations['well_5']], final_destinations['well_5'], well_volume=well_volumes['well_5'], source_volume= source_volumes['well_5'], adjust=adjust, cartridges_per_deck = cartridges_per_deck)

    finally:
        # Always close serial port, even if there's an error
        if ser and ser.is_open:
            try:
                ser.close()
                protocol.comment('Serial port closed')
            except:
                pass
