# Device monitor mode (firmware v103 + daily Claude review)

Built 2026-10-14. Lets a handful of suspect SPUs report on themselves without re-enabling the
v74 behaviour that uploaded the log every 60 s and blew the Particle data-operations budget.

## What it is

| Layer | Piece | Where |
|---|---|---|
| Firmware v103 | `eeprom.monitor_flag`, set through `set_service("monitor:1\|0")`, mirrored in the `monitor_flag` cloud variable, serial `14,1` / `14,0` | `brevitest-device/firmware/Docs/MONITOR_MODE_HANDOFF.md` |
| Firmware v103 | While the flag is 1 the device uploads its session log (the existing `device-log` event the Lambda already handles) after every test, after every screen, 5 s after entering ERROR_STATE, and once at boot. Each upload is preceded by a `---- MONITOR <trigger> ----` block: mode, last error, cloud/wifi/rssi, heater, stage, last test id, last 12 state transitions. | same |
| BIMS | `spu.monitoring { enabled, role: suspect\|control, reason, enabledAt/By, lastReview* }` and `spu.particleLink.monitorFlag*` sync state | `src/lib/server/db/models/spu.ts` |
| BIMS | `syncMonitorFlag(spuId)` pushes the flag like `syncServiceFlag`; re-pushed on `spark/status` online | `src/lib/server/service-flag.ts`, `src/routes/api/particle/webhook/+server.ts` |
| BIMS | Toggle + Findings tab on `/spu/[spuId]/diagnostics`; fleet view at `/spu/monitor` | routes |
| BIMS | `buildDeviceTimeline()` (extracted from the diagnostics page) + `timelineToText()` compaction | `src/lib/server/device-timeline.ts` |
| BIMS | Daily review: `runDailyReview()` → Claude with a forced `report_review` tool (fixed schema) → `device_findings` | `src/lib/server/device-monitor-review.ts`, `/api/cron/device-monitor-review` (vercel.json, 07:30 UTC) |
| BIMS | `device_findings` collection, no TTL (`DeviceFinding`) | `src/lib/server/db/models/device-finding.ts` |

## Flow

1. Someone turns monitor mode on from the SPU Diagnostics page (role suspect or control, a reason).
   BIMS journals it, writes the policy to the SPU, and calls `set_service` with `monitor:1`.
   Pre-v103 firmware answers -1 and the page shows "Firmware < 103 — flag not pushed".
2. The device uploads logs on its own. Nothing else changes for the operator; the Dump Logs button
   still works.
3. At 07:30 UTC the cron builds, for each suspect, the last 24 h of the unified timeline (firmware
   lines, webhook statuses, crashes, events), the test records of the window (status, stage check,
   analysis outputs), and the control units' medians, and asks Claude for a verdict:
   `status` healthy / watch / suspect / no_data, a summary, and findings
   `{title, severity, category, detail, recommendation, confidence, evidence[]}`.
4. One `daily_review` row per device per day (re-running overwrites), one `review_finding` row per
   finding. Findings can be acknowledged / resolved from the Findings tab. They never expire.

## Operating notes

- Model: `DEVICE_MONITOR_MODEL` env var, default `claude-sonnet-4-6`. Cost is written on each review
  row (about $0.03–0.10 per unit per day at the default budget of 40 k characters of timeline).
- `GET /api/cron/device-monitor-review?spuId=<id>&hours=48&dry=1` returns the exact prompt without
  calling Claude; useful to see what the model would see.
- Requires `ANTHROPIC_API_KEY` (already set for Ask BIMS) and `CRON_SECRET` or the agent key.
- Log retention: `device_logs` TTL was raised from 30 days to 1 year on 2026-10-14 (live index
  changed with collMod). `device_events` and `webhook_logs` stay at 30 days.
- The `monitor_flag` on the device survives reboot and firmware upgrade (EEPROM, preserved across
  `reset_eeprom()` like `service_flag`). Turning monitor mode off in BIMS clears it.

## Not built

- No email/Slack of the daily verdicts; the fleet page is the inbox.
- No per-run anomaly scoring outside the daily window (the review runs once a day; "Review now"
  runs it on demand).
- The Ask BIMS deny-list still excludes `device_logs`; the review reads them server-side only and
  drops any line mentioning password/ssid/credential/token before sending.
