from opentrons import protocol_api

# =============================================================================
# ARM-WAX-01 — Single-cartridge wax fill for the robot-arm handoff cell.
#
# Deck:
#   - nest_slot (param, default "1"): brevitest_arm_nest_1_gen7cartridge
#       one Gen7 cartridge presented by the SO-ARM101 nest fixture.
#       Geometry derived from cosmas_damian/gen4deck_gen7cartridge_001
#       (first cartridge position, rows A-C x cols 1-8). Nest rows A/B/C are
#       the three channel rows; EVEN columns are wax gates:
#           col 2 = Gate 4, col 4 = Gate 3, col 6 = Gate 2, col 8 = Gate 1
#       ODD columns are reagent wells — never touched by this protocol.
#   - slot 10: cosmas_and_damian_drybath_tuberack (wax source, 2 mL tube)
#   - slot 11: cosmasanddamian_96_tiprack_20ul
#   - right mount: p20_single_gen2
#
# Arm handoff contract (enforced by BIMS, see docs/prds/ARM-WAX-01):
#   1. This run is CREATED on the OT-2 but only PLAYED after BIMS has verified
#      the arm placed a cartridge in the nest AND the arm is parked clear.
#   2. The protocol never moves the gantry until play, so the deck is safe for
#      the arm while the run sits in "idle" (created, not started).
#   3. On completion the pipette drops its tip and the gantry HOMES — only
#      after BIMS sees the run succeed + gantry homed does the arm unload.
#   4. No mid-run pauses in v1: one cartridge = one uninterrupted fill.
#
# Derived from Wax_Filling_GEN7_Cartridge.py v4.x (trip budget / remainder
# math, gate volumes, touch-tip anti-drip). Multi-cartridge nests later just
# widen the labware def + the CHANNEL_ROWS/CARTRIDGES tables below.
# =============================================================================

metadata = {
    'author': 'Brevitest',
    'description': 'ARM-WAX-01: fill wax gates of ONE Gen7 cartridge held in the robot-arm nest.',
}

requirements = {"robotType": "OT-2", "apiLevel": "2.19"}

# nest column -> wax gate number (matches GEN7 deck: within an 8-col group
# Gate4=col2, Gate3=col4, Gate2=col6, Gate1=col8)
GATE_COLUMNS = {2: 'gate4', 4: 'gate3', 6: 'gate2', 8: 'gate1'}

MAX_TIP_UL = 20.0


def add_parameters(parameters: protocol_api.Parameters):
    parameters.add_str(
        variable_name="nest_slot",
        display_name="Nest Slot",
        description="Deck slot holding the arm nest fixture.",
        default="1",
        choices=[{"display_name": s, "value": s} for s in
                 ["1", "2", "3", "4", "5", "6"]],
    )
    parameters.add_str(
        variable_name="wax_tube_well",
        display_name="Wax Tube Well",
        description="Tuberack well holding the 2 mL wax tube.",
        default="A1",
        choices=[{"display_name": w, "value": w} for w in
                 ["A1", "A2", "A3", "B1", "B2", "B3"]],
    )
    parameters.add_bool(
        variable_name="wax",
        display_name="Wax",
        description="Master switch — set False for a dry run (all motion, no liquid).",
        default=True,
    )
    # Channel rows (nest row A/B/C). Same semantics as GEN7 channel toggles.
    parameters.add_bool(
        variable_name="channel_a",
        display_name="Channel A (nest row A)",
        default=True,
    )
    parameters.add_bool(
        variable_name="channel_b",
        display_name="Channel B (nest row B)",
        default=True,
    )
    parameters.add_bool(
        variable_name="channel_c",
        display_name="Channel C (nest row C)",
        default=True,
    )
    # Per-gate volumes — defaults mirror the GEN7 production protocol.
    for gate in (4, 3, 2, 1):
        parameters.add_float(
            variable_name=f"vol_gate{gate}",
            display_name=f"Wax Gate {gate} Volume",
            description=f"Dispense volume for Gate {gate} wells.",
            default=1.60,
            minimum=0.1,
            maximum=20.0,
            unit="uL",
        )
    parameters.add_float(
        variable_name="aspirate_remainder",
        display_name="Aspirate Remainder",
        description=(
            "Backing volume held in the tip per trip. "
            "Usable wax per trip = 20 - remainder."
        ),
        default=11.5,
        minimum=0.0,
        maximum=18.0,
        unit="uL",
    )
    parameters.add_float(
        variable_name="dispense_rate",
        display_name="Dispense Rate",
        description="Relative dispense flow rate (1.0 = default p20 rate).",
        default=0.25,
        minimum=0.05,
        maximum=1.0,
    )


def run(protocol: protocol_api.ProtocolContext):
    p = protocol.params

    # ---- labware -----------------------------------------------------------
    nest = protocol.load_labware('brevitest_arm_nest_1_gen7cartridge', p.nest_slot)
    tuberack = protocol.load_labware('cosmas_and_damian_drybath_tuberack', 10)
    tiprack = protocol.load_labware('cosmasanddamian_96_tiprack_20ul', 11)
    pipette = protocol.load_instrument('p20_single_gen2', mount='right', tip_racks=[tiprack])

    source_well = tuberack[p.wax_tube_well]

    gate_volumes = {
        'gate4': p.vol_gate4,
        'gate3': p.vol_gate3,
        'gate2': p.vol_gate2,
        'gate1': p.vol_gate1,
    }

    channel_rows = []
    if p.channel_a:
        channel_rows.append('A')
    if p.channel_b:
        channel_rows.append('B')
    if p.channel_c:
        channel_rows.append('C')
    if not channel_rows:
        protocol.comment('No channels enabled — nothing to fill.')
        return

    # Work list: (well, volume) for every enabled channel row x wax gate col.
    work = []
    for row in channel_rows:
        for col, gate in GATE_COLUMNS.items():
            work.append((nest[f'{row}{col}'], gate_volumes[gate]))

    usable_per_trip = MAX_TIP_UL - p.aspirate_remainder
    max_single = max(gate_volumes[g] for g in
                     {GATE_COLUMNS[c] for c in GATE_COLUMNS})
    if max_single > usable_per_trip:
        raise RuntimeError(
            f'aspirate_remainder {p.aspirate_remainder} leaves only '
            f'{usable_per_trip:.2f} uL per trip but a single gate needs '
            f'{max_single:.2f} uL. Lower the remainder.'
        )

    total_ul = sum(v for _, v in work)
    protocol.comment(
        f'ARM-WAX-01: {len(work)} wax wells across rows '
        f'{"/".join(channel_rows)}, {total_ul:.1f} uL total, '
        f'{usable_per_trip:.1f} uL usable per trip.'
    )

    if not p.wax:
        # Dry run: trace every wax well without liquid so nest alignment can
        # be eyeballed with an empty tip.
        pipette.pick_up_tip()
        for well, _vol in work:
            pipette.move_to(well.top(2))
        pipette.return_tip()
        protocol.comment('Dry run complete (no liquid dispensed).')
        return

    # ---- fill --------------------------------------------------------------
    # Batch wells into trips: aspirate (batch volume + remainder), dispense
    # into each well, then return over the source and blow out the remainder.
    pipette.pick_up_tip()

    i = 0
    while i < len(work):
        batch = []
        batch_vol = 0.0
        while i < len(work) and batch_vol + work[i][1] <= usable_per_trip:
            batch.append(work[i])
            batch_vol += work[i][1]
            i += 1

        pipette.aspirate(batch_vol + p.aspirate_remainder, source_well.bottom(2))
        # Anti-drip pause + wipe on the source tube rim (GEN7 pattern).
        pipette.move_to(source_well.top(-2.3))
        protocol.delay(seconds=3)
        pipette.touch_tip(v_offset=-2.3)

        for well, vol in batch:
            pipette.dispense(vol, well.bottom(0.5), rate=p.dispense_rate)
            protocol.delay(seconds=0.3)

        # Return the backing volume to the tube.
        pipette.blow_out(location=source_well.top())

    pipette.drop_tip()

    # Clear the deck for the arm: home the gantry so BIMS can verify a safe
    # unload posture before triggering the arm.
    protocol.home()
    protocol.comment('ARM-WAX-01 complete — gantry homed, safe for arm unload.')
