# ARM-WAX-LOOP-B — one OT-2 run per loop, the tip idling in the wax, arm and gantry overlapping

**Status:** plan, 2026-10-29. Not built.
**Decided by:** Alejandro, 2026-10-29. "I like number 1" (one run per loop). "Don't skip the probe for rehearsals —
I want rehearsals to mimic the real thing." Tip idles in the wax between carts to keep the wax warm.
**Safety rule (Alejandro, 2026-10-29):** the OT-2 and the arm may move at the same time **as long as the OT-2 is not
at the calibrator and is not hovering above the stage.** Allowed places for the gantry while the arm moves: the tube
rack (slot 10), the tip rack (slot 11), the trash, home.

## 1. What the measured loop says

One cart, loop `taAfIBWZuoHim-woVh0Ld`, 2026-10-29 19:41–19:47Z, 5 min 45 s:

| Step | s | Goes away in B? |
|---|---|---|
| Full home before the grab | 20 | yes — no home per cart |
| Grab animation | 41 | overlaps the gantry parked in the tube |
| Scan sweep (maintenance run + home + move + read) | 38 | becomes ~15 s: the run itself moves to the scan point, the daemon reads the scanner over serial |
| Fill start (freshness gate, create, play) | 15 | once per loop |
| OT-2 run (engine home, tip, probe, 12 holes, end home) | 185 | per cart only the 12 holes + tube trips remain (~60–90 s); the rest is once per loop |
| Verify end-of-run home + pipette lift | 11 | gone — the pause at the tube is the stamp |
| Withdraw animation | 22 | overlaps the gantry parked in the tube |

Expected per cart after B: grab 41 → scan ~15 → decide ~5 → fill ~60–90 → withdraw 22 ≈ **2.5 min**, plus ~70 s once
per loop (home, tip, probe, first aspirate). A 3-cart loop: ~8.5 min instead of ~17.

## 2. The cycle, with what runs concurrently

```
LOOP START (once)
  BIMS: create + play ONE run (RTP cartridges = N)
  OT-2: engine home → calibrator serial → pick up tip → PROBE at the calibrator → aspirate wax
        → park the tip IN the wax tube → pause "PARKED 1"
  arm: idle                                                  (probe = calibrator → arm must not move)

PER CART i
  A  arm GRAB (41 s)            ‖  OT-2 parked in the tube            ← allowed (tube, not stage)
  B  BIMS resumes the run; OT-2 lifts → scan position → pause "AT_SCAN i"
     BIMS → daemon: read_scanner (serial only, no motion) → barcode
                                   arm still                          ← gantry over the stage
  C  BIMS checks the cart (backed? bucket label? unknown?) → writes the instruction → resumes
       fill:  OT-2 → the 12 holes → back to the tube → re-aspirate → park → pause "PARKED i+1"
       skip:  OT-2 → back to the tube → park → pause "PARKED i+1"
                                   arm still                          ← gantry over the stage, then the tube
  D  arm WITHDRAW (22 s)        ‖  OT-2 parked in the tube            ← allowed
     (or the FAIL animation on skip, same overlap)
  E  next GRAB follows the withdraw directly; the OT-2 stays parked

LOOP END
  BIMS writes "end" → resumes → OT-2: trash the tip → home     ‖  arm withdraw of the last cart   ← allowed
```

What never overlaps: any arm motion with the gantry at the calibrator (the once-per-loop probe) or over the stage
(scan, fill, the lifts over the cart). Enforced two ways:
- the run only leaves the tube after a BIMS resume, and BIMS only resumes after the arm's play has settled;
- the arm only plays when the run is **paused with a PARKED note** (read from the run's current `waitForResume`
  command), the way it only played after a gantry-home stamp before.

## 3. Pieces

### 3.1 Protocol (`protocols/Wax_Filling_GEN7_ArmStage.py` + the p300 rehearsal, identical structure)
- RTP `cartridges` (1–24): how many carts this run serves. Scan position RTPs `arm_scan_x/y/z` (taught in BIMS today,
  sent like `arm_cart_x/y/z`).
- Once: home, calibrator port, pick up tip, probe (unchanged routine, `max_tip_adjust` from BIMS), aspirate.
- `park_in_wax()`: lift → tube → down to the aspirate height (tube floor + `min_tip_clearance`, the existing model) →
  `protocol.pause('ARM PARKED <i>')`. The tip holds the next cart's wax, in the warm tube.
- After each resume: read `/data/arm_loop_<run>.json` (written by the daemon, §3.2). `{"cart": i, "action":
  "scan"|"fill"|"skip"|"end"}`. `scan`: lift → scan position → `protocol.pause('ARM AT_SCAN <i>')`. `fill`: the
  existing 12-hole fill, then tube, re-aspirate, park. `skip`: tube, park. `end`: trash the tip, `protocol.home()`.
- The lift rule stays exactly as it is for every move that leaves the tube or the stage.
- Rehearsal: same file structure on the p300 with air; probe kept (Alejandro).
- Test: `protocols/tests/test_arm_stage_rehearsal_p300.py` extended for the new RTPs + the instruction reader.

### 3.2 Bridge daemon (`scripts/ot2-bridge.py`) — needs a redeploy to the arm's OT-2
- `read_scanner`: trigger + read the scanner over SCANNER_SERIAL_PORT, no maintenance run, no motion; result posted
  like a sweep's (barcode or nothing). Reuses the `ScannerPort` code `execute_sweep` already has.
- `write_file`: write `{path under /data, json}`; the instruction channel into the running protocol. Only paths
  matching `/data/arm_loop_*.json`.
- Unit tests in `scripts/test_ot2_bridge_server.py`.

### 3.3 BIMS (`src/lib/server/arm-wax-fill.ts` + the Wax fill tab)
- Loop = one `WaxFillingRun` + one OT-2 run for N carts (`cartridgeIds` grows as carts are filled; the rehearsal
  attaches nothing, as today).
- Cycle steps become: `grab` → `scan` → `decide` → `fill` → `withdraw` (or `fail`). Gates:
  - `cycleGrab` / `cycleWithdraw` / `cycleFail`: the run is paused at `ARM PARKED <i>` (GET /runs/{id}: status
    paused; current command `waitForResume` whose message starts with `ARM PARKED`). Replaces `assertGantryHomed`.
  - `cycleScan`: BIMS writes `{scan}` + resume → waits for `ARM AT_SCAN` → daemon `read_scanner` → barcode →
    `cartScanProblem` as today.
  - `cycleDecide`: writes `{fill}` or `{skip}` + resume. `skip` = the fail route (fail animation, loop stops, as the
    fail-route rule says) unless Alejandro wants the loop to continue past a bad cart.
  - Loop end / Stop: `{end}` + resume; the arm's last withdraw plays while the run finishes.
- Cart bookkeeping unchanged per cart: a real backed cart is drawn from its bucket when its fill is confirmed (the
  run's comment `CART <i> FILLED`), advanced to wax_filled at the run's end for the carts the run reports filled.
- Readiness: the scan position must be taught (it already must be); the tube must hold enough wax for N carts
  (N × 12 × per-hole volume + remainder) — shown, not enforced.

### 3.4 What this changes about the process
- **One tip per loop, one probe per loop**, for production and rehearsal alike. Today it is a fresh tip + probe per
  cart. This follows from "the tip idles in the wax"; it needs Alejandro's yes for production.
- The tip holds aspirated wax while it waits. The tube is on the drybath, so the wax stays liquid; a long wait
  (minutes) has not been tried.

## 4. Order of work
1. Daemon: `read_scanner` + `write_file` (+ tests). Hand off for the robot redeploy.
2. Protocol: the pause/instruction loop + scan RTPs (+ tests). Library upload from the Wax fill tab.
3. BIMS: loop state machine, gates, tab UI. Deploy.
4. One-cart loop on the rehearsal; then a 3-cart loop; measure from the audit log.

## 5. The contract (pinned 2026-10-29 before the build; every piece is written against this text)

**Decision (Alejandro, 2026-10-29): one tip for the entire loop, never changed between carts; build it.**

### 5.1 Instruction file (BIMS → protocol, written by the daemon)
Path on the robot: `/data/arm_loop.json` (one loop at a time per robot; overwritten, never appended).
```json
{ "seq": 3, "loop": "<BIMS ArmWaxFillRun _id>", "cart": 2, "action": "fill", "barcode": "f4bb…" }
```
- `seq`: integer, 0 for the start record, then +1 per write within the loop.
- `action`: `start` (seq 0, written BEFORE the run is played) | `scan` | `fill` | `skip` | `end`.
- `barcode`: the scanned barcode on `fill`, else null.
- Protocol start: reads the file; it must be `action == "start"`; remembers `loop`; `seen_seq = 0`. A missing or
  non-start file at run start → `RuntimeError('ARM LOOP: no start record in /data/arm_loop.json')` (the run fails
  before any motion).
- After every `protocol.pause()` returns, the protocol polls the file (0.5 s, up to 60 s) until it holds the same
  `loop` and `seq > seen_seq`; consumes it (`seen_seq = seq`); otherwise pauses `ARM NO_INSTRUCTION <i>` and polls again
  after the next resume. Never acts on a stale or foreign record.

### 5.2 Pause messages (protocol → BIMS): `protocol.pause(message)` = a `waitForResume` command whose
`params.message` is the text. BIMS reads the run's status + current command (GET /runs/{id}, GET /runs/{id}/commands
with no cursor → the running command).
- `ARM PARKED <i>` — tip parked in the wax tube holding wax, ready for cart i (1-based). **The arm may move.**
- `ARM AT_SCAN <i>` — gantry at the scan position over the stage. **The arm must not move.** BIMS reads the scanner.
- `ARM NO_INSTRUCTION <i>` — resumed without a new instruction (see 5.1). BIMS writes one and resumes.
Comments (log only): `ARM CART <i> FILLED <barcode>`, `ARM CART <i> SKIPPED`, `ARM LOOP END`.

### 5.3 Run-time parameters added to both stage protocols
- `cartridges` int 1–24, default 1: carts this run serves (BIMS sends the loop's requested runs).
- `arm_scan_x`, `arm_scan_y` float 0–400, `arm_scan_z` float 0–200, default 0: the taught scan position (BIMS
  sends `calibration.scanPosition`, as it sends `arm_cart_x/y/z`). A 0 = untaught → refuse before motion, like the cart.
Descriptions ≤ 100 chars, display names ≤ 30 (test_rtp_limits.py).

### 5.4 Protocol sequence
```
start: read start record → home → calibrator port → pick up tip → probe (unchanged, once) → aspirate → park → pause PARKED 1
for i in 1..cartridges (the instruction decides, the protocol only counts):
  resume → instruction:
    scan : lift → scan position → pause AT_SCAN i → resume → instruction:
             fill : lift → 12 holes (unchanged) → lift → tube → re-aspirate → park → pause PARKED i+1
             skip : lift → tube → park → pause PARKED i+1
             end  : lift → trash tip → home → (run ends)
    end  : lift → trash tip → home
```
`park` = tube A3, tip at the aspirate height (tube floor + min_tip_clearance, the existing model), holding the next
cart's volume. The lift rule applies to every move that leaves the tube or the stage, unchanged.

### 5.5 Daemon commands (queue line, `Ot2BridgeCommand` kind)
- `read_scanner` payload `{ "timeoutS": 15 }` → result `{ "barcode": "<str>" | null, "raw": "<str>" }`. Serial only
  (SCANNER_SERIAL_PORT); no maintenance run, no motion.
- `write_file` payload `{ "path": "/data/arm_loop.json", "json": {…} }` → result `{ "written": true, "bytes": n }`.
  Only `/data/arm_loop.json` is allowed; anything else is refused.

### 5.6 BIMS gates
- Arm plays (grab / withdraw / fail) only when the run is `paused` at `ARM PARKED <i>` with the expected i
  (`assertRunParked`); never on `AT_SCAN`.
- BIMS resumes the run only after the arm's play has settled (the page's play poll), exactly as it homes today.
- Run `failed` / `stopped` / `succeeded` while a cycle is mid-way → the loop fails (succeeded only legitimately after
  `end`).
- The EmbeddedRunController's auto-resume of the initial off-deck pause must never resume an `ARM …` pause.

### 5.7 Announcements (added 2026-10-30, Alejandro's overlap)
Plain `protocol.comment()` lines BIMS reads from the run's command log; the arm may move from them on while the run
keeps going. A marker is the LAST ARM pause or announcement in the log; a later one retires it.
- `ARM CALIBRATED` — after the once-per-loop probe. Until `ARM PARKED 1` the OT-2 only visits the tube. **Grab of
  cart 1 starts here.**
- `ARM CLEAR <i>` — after `lift()` and the planned move to the tube top have completed (never over the stage), before
  the re-aspirate/park (fill, skip) or tip-to-trash + home (end). **Withdraw / fail animation of cart i start here;
  the next grab follows the withdraw at once.**
- Gates (BIMS `armMayMove`): grab(1) = PARKED 1 | running after CALIBRATED; grab(i) = PARKED i | running after
  CLEAR i−1; withdraw/fail(i) = PARKED i+1 | running after CLEAR i; scan start = PARKED i only. `end` needs a paused
  run (it is an instruction + resume), so the last cart's withdraw waits for the park, sends `end`, then plays.
- The scan position RTP `arm_scan_z` is the NOZZLE height taught with no tip; the protocol moves the tip end to
  `arm_scan_z − tiprack.tip_length` when a tip is on. `arm_cart_z` / `arm_scan_z` maxima are 250.
- Timed (open-loop) choreography was considered and rejected: the rule stays enforced by state.
