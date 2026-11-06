# Pi Change Reporting

The Pi reports its own changes to BIMS's robot arm Change Log (Maintenance > Change Log). One module, `src/server/bims_changes.py`, stdlib only.

## What Reports Itself

| Change | Where | Row |
|---|---|---|
| Gain write | `POST /servos/gains` (servo_config.py) | `servo.p_coefficient servo:2 6 -> 16`, note Saved to EEPROM or Temporary |
| Router install | every `scripts/install_*.py` on apply | `pi.router.thermal Installed`, details app.py hash |
| Service start | `install_change_reporter.py` wires `service_started(app)` into app.py | `pi.service.start 0.2.0`; then `pi.app_py <old> -> <new>` and `pi.route /path Added` or `Removed` against the previous start |
| By hand | `python3 scripts/bims_report.py change …` | whatever you label |

Rows wait in `~/.bims-arm/changes-pending.jsonl` until BIMS stores them. A row BIMS rejects (bad label) is dropped and printed. `python3 scripts/bims_report.py flush` resends; `pending` lists.

## Install On arm-pi

From the robot-arm project root, with no session active:

```
cp src/server/bims_changes.py <pi app dir>/bims_changes.py    # next to app.py
cp src/server/servo_config.py <pi app dir>/servo_config.py    # the gains route now reports
python3 scripts/install_change_reporter.py --check
python3 scripts/install_change_reporter.py
sudo systemctl restart robot-arm
python3 scripts/bims_report.py pending
```

The service needs `BIMS_WEBHOOK_URL` and `AGENT_API_KEY` in its environment, which the webhook already uses. `BIMS_CHANGES_URL` overrides the derived URL. Scripts run by hand read `.env` at the project root.

## Labels

Hardware: servo, gripper, leader-arm, camera, depth, vision, solenoid, conveyor, stage, pi, network. Keys are lower case and dotted. Page is `pi` unless `hand`. The full list is `src/lib/robot-arm/change-labels.ts` in BIMS.
