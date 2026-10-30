# Handoff — deploy the arm wax-fill speed fixes to the robot (2026-10-30)

**For:** the Claude session (or Alejandro) on a computer that can reach the arm's OT-2 (`alejandros-pc` or the
lab Mac). The computer this was written on has no LAN route to the robots.

**What is already done:** the code is on `master` (commit titled "feat(robot-arm): arm wax-fill speed fixes …")
and Vercel has deployed BIMS from it. **Two things must still reach the robot** before the next loop uses them:

| # | What | How | Needs |
| --- | --- | --- | --- |
| 1 | Bridge daemon `scripts/ot2-bridge.py` **1.5.0** (md5 `4b5691f80e560f16aa6d1500e5fce973`): adds `scan_at_pause` — the daemon watches the loop's run locally and reads the scanner the moment it pauses at the scan position | SSH copy to `/data/ot2-bridge/` on the arm's OT-2 (BIMS → Robot Arm → Wax fill → Setup shows which; B07 / R04 / B14 too is safe), then `systemctl restart ot2-bridge`. Only with no active run and no loop running; never mid-fill. The Robots page heartbeat must then show 1.5.0. | robot SSH key, LAN |
| 2 | Both stage protocols, re-added to the library and deployed: `protocols/Wax_Filling_GEN7_ArmStage_Rehearsal_p300.py` (the rehearsal now paces its plunger like the p20, declares the channel checkboxes `row_pattern_0/1/2` and announces `ARM PROBING`) and `protocols/Wax_Filling_GEN7_ArmStage.py` (channels + `ARM PROBING`) | Wax fill tab → Protocol on the robot → "Add a stage .py to the library" → Deploy to robot; the analysis must complete with **no** errors. Deploy the rehearsal now; the production file when a real fill is next. | a BIMS login |

Until 1 is done, the loop still works: BIMS sees the daemon reject `scan_at_pause` ("unknown command kind") and
falls back to polling the run and `read_scanner` as before (the scan is just slower). Until 2 is done, the loop
still works too: BIMS sends the channel checkboxes but the old protocol ignores them (fills all three rows), and
the first grab waits for `ARM CALIBRATED` because the old protocol never says `ARM PROBING`.

## Tell the other computer this (paste into Claude there)

```
Pull master in the Bioscale_Operations_System_V2 repo and read
docs/HANDOFF-ARM-LOOP-SPEED-DEPLOY-2026-10-30.md. Follow it end to end:
(1) copy scripts/ot2-bridge.py (ot2-bridge/1.5.0, md5 4b5691f80e560f16aa6d1500e5fce973)
to /data/ot2-bridge/ on the arm's OT-2 over SSH and restart ot2-bridge when the
robot has no active run and no Wax fill loop is running; confirm 1.5.0 on the
Robots page heartbeat. (2) On the Wax fill tab add
protocols/Wax_Filling_GEN7_ArmStage_Rehearsal_p300.py to the library and deploy
it (analysis clean); add protocols/Wax_Filling_GEN7_ArmStage.py to the library
(deploy it when a production fill is next). Then run a 2-cart rehearsal loop,
open its Fill profile on the Wax fill tab, and append a progress.txt entry on
master with what went where and the per-cart numbers.
```

## What to expect on the first loop after both are in

- The first grab starts at `ARM PROBING` (about 20–25 s earlier than before). Watch that the grab path stays clear
  of the tip calibrator while the gantry is there; if it does not, untick "First grab starts while the tip is being
  calibrated" in Setup — the grab then waits for `ARM CALIBRATED` as before.
- After cart 1's fill the arm plays the withdraw and the grab of cart 2 as ONE path; the log says "withdraw + the
  next cart's grab as one arm path". Cart 2 starts at the scan.
- The scan handshake should be about 8 s from "sending the OT-2 to the scan position" to the barcode (was 8–17 s).
- With two channels ticked in Setup the fill does two tube trips per cart instead of three.
- If an arm play ends without the arm at the animation's end pose, the loop stops where it is with
  `ARM DID NOT ARRIVE: …` and the OT-2 is not moved; Resume plays that step again.
