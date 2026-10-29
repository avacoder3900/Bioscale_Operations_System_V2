# Handoff — deploy the robot-arm wax-fill LIFT RULE to the robots (2026-10-29)

**For:** the Claude session (or Alejandro) on a computer that can reach the OT-2s —
`alejandros-pc` or the lab Mac. The computer this was written on could not: no LAN
route to 172.16.202.x, no Tailscale, no robot SSH key, no `MONGODB_URI`.

**What is already done:** the code is on `master` (feature `2f1fe3a3`, deploy log
`2f459d04`, this handoff + daemon version bump in the commit after it). Vercel has
deployed BIMS from it. **Nothing has reached a robot yet.** That is this job.

**What the change is:** on the robot-arm wax-fill line only, the OT-2 pipette goes ALL
THE WAY UP (a Z-only home) before every move — in the stage protocol, in the Stage
Calibration Studio and in the arm's one-slot scanner sweep. The carriage wax protocol,
the reagent protocol, the Deck Calibration Studio and production 24-slot sweeps are
untouched. Details: the progress.txt entry "2026-10-29 — master — Robot-arm wax fill:
the OT-2 pipette goes ALL THE WAY UP before every move (lift rule)".

## Tell the other computer this (paste into Claude there)

```
Pull master in the Bioscale_Operations_System_V2 repo and read
docs/HANDOFF-ARM-LIFT-DEPLOY-2026-10-29.md. Follow it end to end.

Goal: deploy the robot-arm wax-fill LIFT RULE (the OT-2 pipette goes all the
way up before every move, robot-arm line only) to the robots. The code is
already on master (2f1fe3a3 and bb0804c8); nothing has reached a robot yet.

Two deliverables:
1. scripts/ot2-bridge.py (ot2-bridge/1.3.1) copied to /data/ot2-bridge/ on
   B07, R04 and B14 over SSH with ~/.ssh/ot2_rsa, then systemctl restart
   ot2-bridge on each. Expected md5 of the file from master bb0804c8:
   c0eedf4f47ebc0c70edc69db3deebc6d. Before each restart, confirm that robot
   has no active run and the Wax fill loop is not running. Never restart a
   robot mid-fill.
2. protocols/Wax_Filling_GEN7_ArmStage.py refreshed into the stored protocol
   source (npx tsx scripts/refresh-protocol-source.ts --type
   wax-filling-arm-stage --apply, needs MONGODB_URI) and then Deployed from
   the BIMS Opentrons -> Protocols page to the OT-2 the arm feeds (Robot Arm ->
   Wax fill -> Setup shows which). The robot's analysis passing is the proof
   the lift hook resolves; if it fails with "ARM STAGE: cannot reach the
   protocol engine", stop and report instead of working around it.

Finish by appending a progress.txt entry on master saying what went where,
and push. The handoff file has the exact commands and the motion check to do
with someone at the robot.
```

Two things must be pushed to the robots, in either order:

| # | What | How | Needs |
| --- | --- | --- | --- |
| 1 | Bridge daemon `scripts/ot2-bridge.py` (1.3.1: `liftBeforeMove` → `lift_z` before each sweep move) | SSH copy + `systemctl restart ot2-bridge` | robot SSH key, LAN |
| 2 | Stage protocol `protocols/Wax_Filling_GEN7_ArmStage.py` (and the p300 rehearsal twin) | refresh the stored source, then Deploy from the BIMS Protocols page | `MONGODB_URI` + a BIMS login |

Robots (from docs/OT2-TAILNET-ADD-ROBOT-RUNBOOK.md):

| Slot | BIMS name | LAN IP (SSH) | Tailnet |
| --- | --- | --- | --- |
| b07 | Robot 3 B07 | 172.16.202.123 | https://ot2-b07.tailf65a70.ts.net |
| r04 | Robot 2 R04 | 172.16.202.124 | https://ot2-r04.tailf65a70.ts.net |
| b14 | Robot 1 B14 | 172.16.202.117 | https://ot2-b14.tailf65a70.ts.net |

Which robot the arm feeds: BIMS → Robot Arm → Wax fill → Setup (the "OT-2" field;
`ArmWaxFillSettings.robotId`). The daemon change is inert on a robot that is not asked
for `liftBeforeMove`, so deploying the daemon to all three is safe and keeps them on one
version. The protocol only needs deploying to the arm's robot.

---

## 0. Before touching a robot

```bash
cd <ops repo checkout>
git checkout master && git pull --ff-only
git log --oneline -3          # expect the lift-rule commits (2f1fe3a3 and after)
grep -m1 '^VERSION' scripts/ot2-bridge.py   # expect ot2-bridge/1.3.1
K=~/.ssh/ot2_rsa              # alejandros-pc. Lab Mac: docs/brevitest-opentrons-files-4-21/ot2_ssh_key (chmod 600 a copy)
```

**Never restart a daemon on a robot that is mid-fill or mid-sweep** — a restart drops an
in-flight scan / auto-resume (the protocol run itself survives). Per robot:

```bash
S=b07   # r04 | b14
curl -s -m 8 -H 'Opentrons-Version: *' https://ot2-$S.tailf65a70.ts.net/runs | python -c "
import sys,json; rs=json.load(sys.stdin)['data']; a=[r for r in rs if r.get('status') in ('running','paused','pause-requested','stop-requested','blocked-by-open-door')]
print('ACTIVE RUNS:', len(a), [(r['id'][:8], r['status']) for r in a])"
```
Only continue on a robot with `ACTIVE RUNS: 0`. Also check the Robot Arm → Wax fill
tab shows no loop running.

## 1. Daemon — per robot (≈1 min each)

```bash
IP=172.16.202.123   # b07 | r04 → .124 | b14 → .117
ssh -i $K -o BatchMode=yes root@$IP "cat > /data/ot2-bridge/ot2-bridge.py.new" < scripts/ot2-bridge.py
ssh -i $K -o BatchMode=yes root@$IP 'cd /data/ot2-bridge && python3 -m py_compile ot2-bridge.py.new && grep -m1 "^VERSION" ot2-bridge.py.new && cp -p ot2-bridge.py ot2-bridge.py.v1.3.bak && mv ot2-bridge.py.new ot2-bridge.py && md5sum ot2-bridge.py'
md5sum scripts/ot2-bridge.py          # must match the robot's line above
ssh -i $K -o BatchMode=yes root@$IP 'systemctl restart ot2-bridge; sleep 6; systemctl is-active ot2-bridge; journalctl -u ot2-bridge -n 12 --no-pager | grep -iE "starting|version|WARN|ERROR" | cut -c1-160'
```

Verify: BIMS → Opentrons → Connectivity shows that robot's heartbeat as `ot2-bridge/1.3.1`
within ~30 s (or `grep -i version` in the journal line above). Rollback if anything is
wrong: `cp ot2-bridge.py.v1.3.bak ot2-bridge.py && systemctl restart ot2-bridge`.

## 2. Protocol — the arm's robot

BIMS uploads a protocol from its STORED source, not from the repo, and the run-start
freshness gate only compares well coordinates, so a `.py` edit reaches a robot in two
steps (see the header of scripts/refresh-protocol-source.ts):

```bash
# a) refresh the stored source (plan first, then apply). Needs MONGODB_URI in .env or the env.
npx tsx scripts/refresh-protocol-source.ts --type wax-filling-arm-stage
npx tsx scripts/refresh-protocol-source.ts --type wax-filling-arm-stage --apply
# the p300 rehearsal twin already carries the lift; refresh it too so the stored copy matches master:
npx tsx scripts/refresh-protocol-source.ts --type wax-filling-arm-stage-rehearsal-p300 --apply
```

b) BIMS → Opentrons → Protocols → the `Wax_Filling_GEN7_ArmStage.py` row → **Deploy** to
the arm's robot. The deploy uploads it, waits for the robot's own analysis and records
it. **The analysis passing is the first real proof that the lift hook resolves on the
robot** (the protocol calls `_resolve_lift` before any motion and refuses to run if the
engine hook is missing). If the analysis fails with "ARM STAGE: cannot reach the protocol
engine for the Z-only home", stop and report — do not work around it.

Alternative without `MONGODB_URI`: on the Protocols page import `protocols/Wax_Filling_GEN7_ArmStage.py`
from master as a new wax-filling protocol, then Deploy that one to the arm's robot and
make it the robot's current wax-filling protocol.

## 3. First motion check (with someone at the robot)

On the Stage Calibration Studio for the arm's robot, with a maintenance run open and no
cart on the stage: **Move to** the scan position, then pick up a tip and **Move to** a hole.
Expected on every one of those: the pipette rises to the TOP of its Z travel first, moves
over at that height, then comes straight down. Nothing should ever move sideways low.
Then the Wax fill tab's loop can be tried; its scan step's sweep log line should read
"pipette lifted all the way up before every move (robot-arm line)".

## 4. Afterwards

Append to progress.txt (master) what was deployed where (robot, md5 / version, protocol
deploy id, who watched), and push. If a step could not be done, say which and why.
