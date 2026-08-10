# ARM-WAX-01 — Robot-arm + OT-2 coordinated wax fill (single cartridge)

**Status:** scaffolding merged to `feat/arm-wax-fill` (this branch). One
cartridge end-to-end; multi-slot tray is a follow-up.

## Goal

Fill the wax gates of ONE Gen7 cartridge on the OT-2 with the SO-ARM101
placing and removing the cartridge, with hard interlocks so the two machines
can never move over the deck at the same time.

## Deck-token interlock (core invariant)

Exactly one machine may own the deck at any time. Ownership is derived from
the run phase — it is never stored separately, so it cannot drift:

| phase          | deck token | meaning                                    |
|----------------|-----------|---------------------------------------------|
| `created`      | none      | nothing authorized                          |
| `arm_loading`  | arm       | arm placing cartridge; OT-2 must be idle + homed (verified before entry) |
| `loaded`       | none      | arm parked (verified); cartridge seated     |
| `ot2_filling`  | ot2       | OT-2 protocol playing; arm must be parked   |
| `filled`       | none      | OT-2 run succeeded + gantry homed (verified)|
| `arm_unloading`| arm       | arm removing cartridge                      |
| `complete`     | none      | done; cartridge → `wax_filled`              |
| `failed`/`aborted` | none  | terminal; both machines commanded to stop   |

Transitions live in `src/lib/server/arm-wax-fill.ts` and **re-check live
hardware state at the boundary** (arm session status via robot-arm API, OT-2
run status via the opentrons proxy) rather than trusting the DB phase alone.
Illegal transitions throw `TransitionError` → surfaced as `fail(400)`.

## Physical setup

- Custom labware `brevitest_arm_nest_1_gen7cartridge` (single-slot arm nest,
  Gen7 pocket geometry) — `protocols/labware/brevitest_arm_nest_1_gen7cartridge.json`,
  uploaded with the protocol.
- OT-2 protocol (`protocols/Wax_Filling_ARM_Single_Cartridge.py`): P20
  single, wax tube rack, fills gates 4→1 per enabled channel, homes gantry,
  then pauses parked — never moves during arm phases.
- Arm tasks: `ARM_LOAD_TASK` / `ARM_UNLOAD_TASK` named task recordings on the
  Pi (record via existing task-recording UI; names are exported constants).

## Surfaces

- `/manufacturing/cart-mfg/robot-arm/wax-fill` — create run (scan cartridge,
  pick robot, gate volumes/channels, dry-run flag) + recent runs.
- `/manufacturing/cart-mfg/robot-arm/wax-fill/[runId]` — step console:
  one guarded button per transition, deck-token banner, event log, abort.
- `GET/POST /api/robot-arm/wax-fill/[runId]` — agent polling (may my machine
  move?) + agent failure reporting. `x-agent-api-key` auth.
- Arm webhook (`/api/robot-arm/webhook`) marks arm task runs
  succeeded/failed; transitions still require operator verify clicks in v1.

## Data

`arm_wax_fill_runs` (model `ArmWaxFillRun`): phase, cartridgeId, robotId,
parameters (nest slot, wax well, per-gate µL, channels, dryRun), cross-refs
(`armLoadRunId`, `armUnloadRunId`, `ot2RunId`, `ot2ProtocolId`), verify
stamps (`armParkedVerifiedAt`, `ot2HomedVerifiedAt`), `events[]` audit trail.
Cartridge status flips `ready_for_wax → wax_filling → wax_filled` (or back on
abort/fail). Every transition writes an `AuditLog` row.

## v1 limitations / follow-ups

1. **Operator-in-the-loop:** each transition is a human button press after
   the machine reports done. Auto-advance (webhook/poll driven) is designed
   for but not enabled.
2. **Single cartridge.** Nest labware has one slot; tray expansion = new
   labware def + loop in protocol + per-slot arm tasks.
3. **Arm task recordings** must exist on the Pi with the exported names
   before a real run; UI surfaces the names.
4. Fixture calibration (nest position on deck, arm approach path) still
   manual — see calibrate pages.
