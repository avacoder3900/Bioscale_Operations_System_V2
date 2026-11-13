import math

from opentrons import protocol_api

# Sample Diluent Fill v2 — derived from Luke Dulworth's "Cartridge Diluent Protocol"
# (production_protocols, Oct 2025) and re-shaped for the 2026-11 method:
#   * source tubes: 15 mL Falcon conicals in the Opentrons 15-tube rack (slot 10), A1 / A2 / A3
#   * one source per destination rack: source 1 -> slot 7, source 2 -> slot 4, source 3 -> slot 1
#     (the 237 mm heat-frame rack spans two slots, so the three racks lie across the three deck rows)
#   * 40 tubes per rack (the heat-frame definition exposes every other hole)
#   * pipette is a run-time choice: P1000 on the right (multi-dispense) or P300 on the left
#   * the operator / BIMS passes the volume actually loaded in each source; the protocol refuses
#     to start if that is not enough for the tubes requested
#   * per-tube volume is a float (104.5 µL default)

metadata = {
    "protocolName": "Sample Diluent Fill v2",
    "author": "Brevitest",
    "description": (
        "Aliquots sample diluent from up to three 15 mL conicals (slot 10, A1-A3) into 2 mL tubes "
        "in heat-frame racks: source 1 -> slot 7, source 2 -> slot 4, source 3 -> slot 1, up to 40 "
        "tubes each. Pipette (P1000 right / P300 left), tubes per trip and the loaded source volumes "
        "are run-time parameters."
    ),
}

requirements = {"robotType": "OT-2", "apiLevel": "2.19"}

# ───────────────────────── deck ─────────────────────────
SOURCE_RACK = "opentrons_15_tuberack_falcon_15ml_conical"
SOURCE_SLOT = 10
SOURCE_WELLS = ["A1", "A2", "A3"]          # source 1, 2, 3

TIPRACK_SLOT = 11

DEST_RACK = "3dprinted_2ml_tuberack_heat_frame"   # 80-hole 3D-printed rack in its frame, 40 positions defined
DEST_SLOTS = [7, 4, 1]                            # source 1 -> back row, 2 -> middle, 3 -> front
DEST_WELLS = [f"{row}{col}" for row in "ABCDE" for col in range(1, 9)]   # A1..A8, B1..B8, ... E8 (40)
TUBES_PER_RACK = len(DEST_WELLS)

# ───────────────────────── pipettes ─────────────────────────
# max_descent_mm: how far below the source-tube rim the tip end may go before the pipette body
# would hit the rim (tip length after overlap + the ~25 mm of narrow shaft that fits in the tube
# mouth). PLACEHOLDERS — verify once per pipette by jogging into an empty tube.
PIPETTES = {
    "p1000": dict(name="p1000_single_gen2", mount="right", tiprack="opentrons_96_tiprack_1000ul",
                  tip_capacity_ul=1000.0, max_tubes_per_trip=8, carry_back_ul=20.0, max_descent_mm=100.0),
    "p300":  dict(name="p300_single_gen2",  mount="left",  tiprack="cosmas_and_damian_biotix_96_200ul_tiprack",
                  tip_capacity_ul=200.0,  max_tubes_per_trip=1, carry_back_ul=10.0, max_descent_mm=72.0),
}

# ───────────────────────── 15 mL Falcon conical geometry ─────────────────────────
# Liquid height from the inside bottom, as a function of volume: a cone, then a cylinder.
# PLACEHOLDERS from the Falcon drawing — replace with measured values (pour 1/2/4/8/12/14 mL,
# read the height) before production use.
TUBE_DEPTH_MM = 117.5        # inside depth, rim to bottom (from the Opentrons labware definition)
CONE_HEIGHT_MM = 21.5
CONE_VOLUME_UL = 1500.0
BODY_UL_PER_MM = 169.0       # 14.66 mm inside diameter at the rim (Corning 352096 sheet)

ASPIRATE_COVER_MM = 3.0      # tip end this far below the computed surface
DISPENSE_DEPTH_MM = 15.0     # below the 2 mL tube top
TOUCH_TIP_OFFSET_MM = -15.0
SETTLE_S = 2.5


def level_mm(volume_ul: float) -> float:
    """Liquid surface height above the inside bottom for a given volume."""
    if volume_ul <= 0:
        return 0.0
    if volume_ul <= CONE_VOLUME_UL:
        return CONE_HEIGHT_MM * (volume_ul / CONE_VOLUME_UL) ** (1.0 / 3.0)
    return CONE_HEIGHT_MM + (volume_ul - CONE_VOLUME_UL) / BODY_UL_PER_MM


def volume_ul(level: float) -> float:
    """Inverse of level_mm."""
    if level <= 0:
        return 0.0
    if level <= CONE_HEIGHT_MM:
        return CONE_VOLUME_UL * (level / CONE_HEIGHT_MM) ** 3
    return CONE_VOLUME_UL + (level - CONE_HEIGHT_MM) * BODY_UL_PER_MM


def add_parameters(parameters: protocol_api.Parameters):
    parameters.add_str(
        variable_name="pipette",
        display_name="Pipette",
        description="Which pipette / tip rack does the fill. The tip rack goes in slot 11 either way.",
        default="p1000",
        choices=[
            {"display_name": "P1000 right, 1000 µL tips", "value": "p1000"},
            {"display_name": "P300 left, Biotix 200 µL", "value": "p300"},
        ],
    )
    for i in (1, 2, 3):
        parameters.add_int(
            variable_name=f"src_{i}_tubes",
            display_name=f"Source {i} tubes",
            description=f"Tubes to fill from source {i} ({SOURCE_WELLS[i-1]}) into the rack in slot {DEST_SLOTS[i-1]}.",
            default=40 if i == 1 else 0,
            minimum=0,
            maximum=TUBES_PER_RACK,
            unit="tubes",
        )
    for i in (1, 2, 3):
        parameters.add_float(
            variable_name=f"src_{i}_ml",
            display_name=f"Source {i} volume loaded",
            description=f"mL actually in source {i}. 0 = assume the minimum (tubes x volume + unreachable bottom).",
            default=0.0,
            minimum=0.0,
            maximum=15.0,
            unit="mL",
        )
    parameters.add_float(
        variable_name="diluent_vol",
        display_name="Volume per tube",
        description="Diluent dispensed into each 2 mL tube.",
        default=104.5,
        minimum=8.0,
        maximum=300.0,
        unit="µL",
    )
    parameters.add_int(
        variable_name="tubes_per_trip",
        display_name="Tubes per aspirate",
        description="Tubes served by one aspirate (multi-dispense). Capped by tip capacity: 8 P1000, 1 P300.",
        default=8,
        minimum=1,
        maximum=8,
        unit="tubes",
    )


def run(protocol: protocol_api.ProtocolContext):
    p = protocol.params
    cfg = PIPETTES[p.pipette]
    vol = float(p.diluent_vol)
    carry = cfg["carry_back_ul"]

    # tubes per trip: what was asked, within what the pipette and tip can hold
    fits = int((cfg["tip_capacity_ul"] - carry) // vol)
    tubes_per_trip = max(1, min(int(p.tubes_per_trip), cfg["max_tubes_per_trip"], fits))

    tiprack = protocol.load_labware(cfg["tiprack"], TIPRACK_SLOT)
    pipette = protocol.load_instrument(cfg["name"], cfg["mount"], tip_racks=[tiprack])
    source_rack = protocol.load_labware(SOURCE_RACK, SOURCE_SLOT)

    counts = [int(p.src_1_tubes), int(p.src_2_tubes), int(p.src_3_tubes)]
    loaded_ml = [float(p.src_1_ml), float(p.src_2_ml), float(p.src_3_ml)]

    # The tip can only reach so far down the tube: liquid whose surface sits below this level is
    # unreachable and counts as dead volume.
    floor_level_mm = TUBE_DEPTH_MM - cfg["max_descent_mm"] + ASPIRATE_COVER_MM
    floor_ul = volume_ul(floor_level_mm)

    # ── pre-flight: every source must hold enough for its tubes ──
    starts_ul = []
    for i, n in enumerate(counts):
        if n == 0:
            starts_ul.append(0.0)
            continue
        # Rounded UP to 10 µL (0.01 mL): the same number BIMS shows the operator.
        need_ul = math.ceil((n * vol + carry + floor_ul) / 10.0 - 1e-9) * 10.0
        have_ul = loaded_ml[i] * 1000.0
        if have_ul <= 0:
            have_ul = need_ul
            protocol.comment(f"Source {i+1} ({SOURCE_WELLS[i]}): no loaded volume given — assuming the minimum, {need_ul/1000:.2f} mL. Load at least that much.")
        if have_ul < need_ul:
            raise RuntimeError(
                f"Source {i+1} ({SOURCE_WELLS[i]}) has {have_ul/1000:.2f} mL but {n} tubes x {vol:g} µL need "
                f"{need_ul/1000:.2f} mL ({floor_ul/1000:.2f} mL of that is unreachable at the bottom with the "
                f"{cfg['name']}). Add diluent or reduce the tube count."
            )
        protocol.comment(f"Source {i+1} ({SOURCE_WELLS[i]}): {have_ul/1000:.2f} mL loaded, {need_ul/1000:.2f} mL needed for {n} tubes.")
        starts_ul.append(have_ul)

    dest_racks = [protocol.load_labware(DEST_RACK, DEST_SLOTS[i]) if n > 0 else None for i, n in enumerate(counts)]

    protocol.comment(f"{cfg['name']} on the {cfg['mount']}: {vol:g} µL per tube, {tubes_per_trip} tube(s) per aspirate, {carry:g} µL carried back to the source each trip.")

    # ── fill: one source -> one rack, fresh tip per source ──
    for i, n in enumerate(counts):
        if n == 0:
            continue
        source = source_rack[SOURCE_WELLS[i]]
        rack = dest_racks[i]
        volume_left = starts_ul[i]
        filled = 0

        pipette.pick_up_tip()
        while filled < n:
            k = min(tubes_per_trip, n - filled)
            # tip end just below the current surface, never deeper than the pipette can go
            below_rim = min(TUBE_DEPTH_MM - level_mm(volume_left) + ASPIRATE_COVER_MM, cfg["max_descent_mm"])
            at_source = source.top(z=-below_rim)

            pipette.blow_out(at_source)                     # return last trip's carry-back (nothing on the first trip)
            pipette.aspirate(k * vol + carry, at_source)
            for _ in range(k):
                well = rack[DEST_WELLS[filled]]
                pipette.dispense(vol, well.top(-DISPENSE_DEPTH_MM), rate=0.5)
                protocol.delay(seconds=SETTLE_S)
                pipette.touch_tip(speed=50, v_offset=TOUCH_TIP_OFFSET_MM)
                filled += 1
            volume_left -= k * vol                           # the carry-back goes back, so only the tubes' volume is consumed
            protocol.comment(f"source {i+1}: {filled}/{n} tubes, ~{volume_left/1000:.2f} mL left")

        pipette.blow_out(source.top(z=-min(TUBE_DEPTH_MM - level_mm(volume_left) + ASPIRATE_COVER_MM, cfg["max_descent_mm"])))
        pipette.drop_tip()
