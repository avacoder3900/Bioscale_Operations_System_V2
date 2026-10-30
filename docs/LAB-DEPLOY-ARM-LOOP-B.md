# Lab computer: deploy the ot2-bridge daemon 1.4.0 (ARM-WAX-LOOP-B)

Read this file with `git fetch origin master && git show origin/master:docs/LAB-DEPLOY-ARM-LOOP-B.md`.
Do **not** checkout, pull, stash, reset or otherwise change the working tree of the
Bioscale_Operations_System_V2 checkout on this machine; other work lives there. Only fetch and read from the remote.
Do not edit any file in the repo and do not push anything.

## 1. Get the daemon file without touching the checkout

```bash
git fetch origin master
git show origin/master:scripts/ot2-bridge.py > /tmp/ot2-bridge.py
md5sum /tmp/ot2-bridge.py            # must be a1da10cbd30e3b63777779f0d2701401
grep -m1 '^VERSION' /tmp/ot2-bridge.py   # must say ot2-bridge/1.4.0
```
If either differs, stop and report.

## 2. Which robot, which key

The OT-2 the arm feeds: BIMS → Robot Arm → Wax fill → Setup. Deploying to all three is safe and keeps them on one
version.

| Robot | IP |
| --- | --- |
| B07 | 172.16.202.123 |
| R04 | 172.16.202.124 |
| B14 | 172.16.202.117 |

Key: `~/.ssh/ot2_rsa` on alejandros-pc, or `docs/brevitest-opentrons-files-4-21/ot2_ssh_key` on the lab Mac
(chmod 600 a copy). Set `K=<that path>`.

## 3. Before each restart

BIMS → Robots: the robot has no active run. Robot Arm → Wax fill: no loop running. **Never restart mid-fill.**

## 4. Copy and restart

```bash
IP=172.16.202.117   # repeat for each robot
scp -i $K /tmp/ot2-bridge.py root@$IP:/data/ot2-bridge/ot2-bridge.py
ssh -i $K root@$IP 'md5sum /data/ot2-bridge/ot2-bridge.py && systemctl restart ot2-bridge && sleep 3 && systemctl is-active ot2-bridge'
```
Proof: BIMS → Robots shows that robot's heartbeat version as `ot2-bridge/1.4.0`.

## 5. Report

Which robots now run 1.4.0, and anything that refused.

## The protocol half (any browser, not this computer)

Wax fill tab → Protocol on the robot → "Add a stage .py to the library" with
`protocols/Wax_Filling_GEN7_ArmStage_Rehearsal_p300.py` from master → Deploy to robot. The deploy must report the
analysis completed with no errors; if it reports errors, keep the text. Do the same with
`protocols/Wax_Filling_GEN7_ArmStage.py` before the next production fill. To get a file here without touching the
checkout: `git show origin/master:protocols/<name>.py > /tmp/<name>.py`.
