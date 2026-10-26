# Data dictionary — where robot-side facts live and for how long

| Collection / place | Holds | Retention | Written by | Read with |
|---|---|---|---|---|
| `labware_definitions` | the SHARED geometry of every labware (one doc per namespace/loadName/version); `hasUnpublishedEdits` | permanent, edited in place | Studio `applyBatch` (decks), scripts | Studio; bundled into every protocol upload |
| `deck_calibration_edits` | one row per well per edit (before/after/delta, robotId label) | permanent | `applyDeckEdit*` | Studio history; `deckEditHistory()` |
| `deck_versions` | frozen snapshots of a deck at publish | permanent | `publishDeckVersion` | rollback |
| `robot_labware_offsets` (CALIB-5) | per robot × rack definition URI × slot vector, capped history | permanent | `saveRackOffset` / migration | `rackOffsetRtpValues` at run start; Studio load-labware/pick-up |
| `tip_calibrator_fixtures` | calibrator approach point, zCalWax/zCalReagent, maxTipAdjust, minTipClearanceWaxMm, history; keyed by deck | permanent | Studio `saveCalibrator` | `calibrationRtpValues` |
| `opentrons_protocols` | stored `.py` source (`fileContent`, `fileHash`), parametersSchema, deployments | permanent | upload page; `scripts/refresh-stored-protocols.ts` | `storedRunProtocol` (auto re-sync) |
| `opentrons_robots.protocols[]` | the robot's current upload per process (opentronsProtocolId, parametersSchema) | replaced on re-sync | `recordResyncUpload`, Sync | `currentProtocolEntry` |
| `opentrons_run_records` | per robot run: RTPs, labwareOffsets (CALIB-5), deckGeometry, status | permanent | `startConfirm` | provenance |
| `wax_filling_runs` / `reagent_batch_records` | the manufacturing run incl. `startIntent` (token, createArgs, resync) | permanent | fill pages | fill pages, MCP |
| `scanner_events` `hb:<deviceId>` | the latest daemon heartbeat (metadata.health/engine/version/link) | overwritten | daemon via `/api/agent/scanner/event` | `health.ts` (60 s stale) |
| `scanner_events` (other) | scans, errors, trigger_consumed | permanent | daemon | sweeps, Studio |
| `robot_link_samples` (OT2-LOG-1) | ≤ 1/min daemon telemetry + 1/min iMac path samples | **50 d TTL** | heartbeat route sampling; `/api/agent/robot-link/samples` | connectivity page; MCP "Robot link samples" |
| `robot_link_daily` (OT2-LOG-1) | per robot per day rollup (gaps, loss, RTT, relay, calls, resyncs) | permanent | `/api/cron/robot-link-daily` | connectivity page; MCP "Robot link daily" |
| `ot2_direct_calls` | every browser direct-line call (verb, path, status, latency, user) | 3 d TTL | browser `/direct-record` | connectivity page |
| `ot2_bridge_commands` | queue-line commands (and fallbacks) | 3–7 d | pages/server | daemon poll; audit |
| `ot2_bridge_jobs` | tailnet daemon jobs (calibrate_tip, sweep, deck_scan…) + results | permanent | Studio/pages | audit `bridge_job_result`, `calibrate_tip` |
| `audit_log` | every notable action with `action`, `recordId`, `newData`, `changedBy` | permanent | everywhere | MCP "Recent Audit Entries" (`parameters: {action, changedAt__gte}`) |
| robot `/data/ot2-bridge/journal.jsonl`, `retry.jsonl` (OT2-LOG-1) | last ~2000 outbound report attempts; queued job reports | ring | daemon | SSH |
| robot journald `ot2-bridge` | daemon log | robot-local | daemon | `journalctl -u ot2-bridge` |
| robot `/logs/server.log`, `/logs/api.log` | robot-server access/API logs (timestamps `Oct 26 17:09:46`) | robot-local | robot-server | `GET /logs/server.log?records=N` |
| robot `/runs`, `/protocols`, `/maintenance_runs` | the last ~20 runs with commands and RTPs; uploads with analyses | robot-local, rolling | robot-server | HTTP API |

Audit `action` values worth knowing: `deck_calibration_edit_batch`, `deck_calibration_edit`, `deck_version_publish`, `deck_calibration_sync`, `save_calibrator`, `revert_calibrator`, `save_rack_offset`, `revert_rack_offset`, `protocol_source_refreshed`, `run_start_auto_resync`, `bridge_job_result`, `bridge_token_issued`, `calibrate_tip`, `deck_scan`, `sweep_enqueued`, `maintenance_run_open/close`, `start_intent_cleared`, `force_reset_to_idle`, `restart_robot_server`, `wax_tip_swap_request`.
