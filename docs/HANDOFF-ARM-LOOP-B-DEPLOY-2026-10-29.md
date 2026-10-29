# Handoff — deploy ARM-WAX-LOOP-B to the arm's OT-2 (2026-10-29)

**For:** the Claude session (or Alejandro) on a computer that can reach the OT-2s —
`alejandros-pc` or the lab Mac. The computer this was written on could not: no LAN
route to 172.16.202.x, no Tailscale, no robot SSH key, no `MONGODB_URI`.

**What is already done:** the code is on `master` (commit titled "feat(robot-arm): ARM-WAX-LOOP-B — one OT-2 run per
loop, the tip idling in the wax, arm and gantry overlapping" and the deploy-log commit after it). Vercel has deployed
BIMS from it. **Nothing has reached a robot yet.** That is this job. Until it is done, the Wax fill tab's loop cannot
start: the bridge daemon on the robot does not know `write_file` / `read_scanner`, and the robot still carries the
one-cart-per-run protocol.

**What the change is:** the robot-arm wax-fill loop becomes ONE OT-2 protocol run per loop. The protocol picks up ONE
tip, probes it once, and between carts idles the tip IN the wax tube (keeps the wax warm) with the run paused
(`ARM PARKED <i>`). BIMS drives it cart by cart through an instruction file the daemon writes (`/data/arm_loop.json`)
and reads the barcode over serial while the run holds the gantry at the scan position (`ARM AT_SCAN <i>`). The arm
moves while the run is parked at the tube; never while the gantry is at the calibrator or over the stage.
Details: docs/prds/ARM-WAX-LOOP-B-ONE-RUN-PER-LOOP.md (§5 is the contract) and the progress.txt entry
"2026-10-29 — … — ARM-WAX-LOOP-B".

## Tell the other computer this (paste into Claude there)

```
Pull master in the Bioscale_Operations_System_V2 repo and read
docs/HANDOFF-ARM-LOOP-B-DEPLOY-2026-10-29.md. Follow it end to end.

Goal: deploy ARM-WAX-LOOP-B (one OT-2 run per robot-arm wax-fill loop, one tip
idling in the wax between carts) to the arm's OT-2. The code is on master;
nothing has reached a robot yet.

Two deliverables:
1. scripts/ot2-bridge.py (ot2-bridge/1.4.0, md5 a1da10cbd30e3b63777779f0d2701401)
   copied to /data/ot2-bridge/ on the OT-2 the arm feeds (BIMS -> Robot Arm ->
   Wax fill -> Setup shows which; deploying to B07, R04 and B14 too is safe and
   keeps them on one version) over SSH with ~/.ssh/ot2_rsa, then
   systemctl restart ot2-bridge on each. Before each restart confirm the robot
   has no active run and the Wax fill loop is not running. Never restart a
   robot mid-fill. Afterwards the Robots page heartbeat must show 1.4.0.
2. The two stage protocols replaced in the library and deployed: on the Wax fill
   tab, Protocol on the robot -> "Add a stage .py to the library" with
   protocols/Wax_Filling_GEN7_ArmStage_Rehearsal_p300.py (archives the old row),
   Deploy to robot; the deploy must report the analysis completed with NO
   errors. Then the same for protocols/Wax_Filling_GEN7_ArmStage.py (add to the
   library now; deploy it when a production fill is next). If the analysis
   reports errors, stop and report the text instead of working around it.

Then run a 1-cart rehearsal loop with a real cart, then a 3-cart loop, and read
the per-step times from audit_log (actions arm_wax_fill.*). Finish by
appending a progress.txt entry on master saying what went where and the
measured times, and push.
```

| # | What | How | Needs |
| --- | --- | --- | --- |
| 1 | Bridge daemon `scripts/ot2-bridge.py` 1.4.0 (`read_scanner`, `write_file`; also carries 1.3.1's `liftBeforeMove` and the sweep's `note_bims_home` if those never went out) | SSH copy + `systemctl restart ot2-bridge` | robot SSH key, LAN |
| 2 | Stage protocols (production + p300 rehearsal), ARM-WAX-LOOP-B structure | Wax fill tab → Add a stage .py to the library → Deploy to robot | a BIMS login |

Robots (from docs/OT2-TAILNET-ADD-ROBOT-RUNBOOK.md):

| Slot | BIMS name | LAN IP (SSH) | Tailnet |
| --- | --- | --- | --- |
| b07 | Robot 3 B07 | 172.16.202.123 | https://ot2-b07.tailf65a70.ts.net |
| r04 | Robot 2 R04 | 172.16.202.124 | https://ot2-r04.tailf65a70.ts.net |
| b14 | Robot 1 B14 | 172.16.202.117 | https://ot2-b14.tailf65a70.ts.net |

## 0. Before touching a robot

```bash
cd <ops repo checkout>
git checkout master && git pull --ff-only
grep -m1 '^VERSION' scripts/ot2-bridge.py   # expect ot2-bridge/1.4.0
md5sum scripts/ot2-bridge.py                # expect a1da10cbd30e3b63777779f0d2701401
K=~/.ssh/ot2_rsa              # alejandros-pc. Lab Mac: docs/brevitest-opentrons-files-4-21/ot2_ssh_key (chmod 600 a copy)
```

**Never restart a daemon on a robot that is mid-fill or mid-sweep.** Check BIMS → Robots (no active run) and
Robot Arm → Wax fill (no loop running) first.

## 1. Daemon

```bash
for IP in 172.16.202.123 172.16.202.124 172.16.202.117; do
  scp -i $K scripts/ot2-bridge.py root@$IP:/data/ot2-bridge/ot2-bridge.py
  ssh -i $K root@$IP 'md5sum /data/ot2-bridge/ot2-bridge.py && systemctl restart ot2-bridge && sleep 3 && systemctl is-active ot2-bridge && grep -m1 VERSION /data/ot2-bridge/ot2-bridge.py'
done
```
Proof: BIMS → Robots shows each robot's heartbeat version `ot2-bridge/1.4.0`.

## 2. Protocols

Wax fill tab → Protocol on the robot → "Add a stage .py to the library" → pick
`protocols/Wax_Filling_GEN7_ArmStage_Rehearsal_p300.py` from the pulled master → the message says the older copy was
archived → pick the single Rehearsal entry (its label shows the file hash) → Deploy to robot. The deploy message must
say the analysis completed with no errors (an analysis WITH errors is now reported as a failed deploy, with the error
text). Repeat the add for `protocols/Wax_Filling_GEN7_ArmStage.py`; deploy it only when a production fill is next.

## 3. First loop

1. Stage Calibration tab: scan position, cart location (tip-neutral, probed), dispense depth, Max tip adjust (10) and
   Probe Z for the pipette in use are all taught — the readiness block on the Wax fill tab lists anything missing.
2. Wax fill tab: 1 run, rehearsal, a real backed cart. Watch the step tiles: grab → scan → decide → fill → withdraw.
   The OT-2 run stays open for the whole loop; the Embedded run controller shows its pauses (`ARM PARKED 1`,
   `ARM AT_SCAN 1`, …).
3. Then 3 runs. Read the timings from audit_log (`arm_wax_fill.*` actions carry per-step stamps).

## 4. If something is wrong

- Loop refuses to start with "the bridge daemon did not answer write_file": the daemon on that robot is not 1.4.0.
- Run fails at start with "ARM LOOP: no start record": BIMS wrote the start record but the daemon wrote it somewhere
  else or the robot's /data is not writable — check `ls -l /data/arm_loop.json` on the robot.
- The run pauses `ARM NO_INSTRUCTION <i>`: BIMS resumed without a fresh instruction; press Resume on the Wax fill tab's
  controller after BIMS has written one (the tab does this itself; a manual Resume on the Opentrons app can race it).
- Analysis errors on deploy: report the text; do not edit the .py on the robot.
