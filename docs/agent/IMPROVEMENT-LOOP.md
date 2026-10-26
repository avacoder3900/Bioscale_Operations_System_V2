# Improvement loop — how an agent turns incidents into fixes

The point of OT2-LOG-1 is that the next "the robots are flaky" conversation starts from data, not from a fresh investigation. This is the procedure.

## After any incident (same day)

1. **Reconstruct from the robot first** (RUNBOOK-CONNECTIVITY-TRIAGE steps 1–5, RUNBOOK-CALIBRATION steps 1–3). Build a UTC timeline: what was uploaded, what ran, what the probe said, who edited what.
2. **Classify** into one of: path (WiFi/wired/relay), daemon (poll/heartbeat/journal), BIMS server (timeouts, resync, records), geometry (definition, offset, fixture), operator procedure. Most incidents are two of these compounding; name both.
3. **Write it down** in `progress.txt` (CLAUDE.md format) with the timeline and the classification. If a "normal" number changed (adjust band, probe Z, rack offset), update `docs/agent/SYSTEM-MAP.md`. If a new footgun appeared, add it to `INVARIANTS.md`.
4. **File the work** through the BIMS MCP: `kanban_capture` one task per fix with the incident's `progress.txt` entry date in the description; attach to the open epic ("Ethernet control of the OT-2s" for connectivity, CALIB-5 for geometry). Do not file fixes you have not classified.
5. **Fix only what the data shows**, on a feature branch, with the OT2-WIRED-1 gates: logging before behaviour changes; one robot first; rollback written in the PR.

## Weekly (Monday, 15 minutes)

- MCP "Robot link daily" for the last 7 days per robot: heartbeat gaps, loss per path, relay minutes, direct-call errors, resyncs, first-probe misses. Anything trending up gets a `kanban_capture`.
- MCP "Recent Audit Entries" `{action: 'deck_calibration_edit_batch', changedAt__gte: <7 d>}`: any edit to a shared rack (`cosmasanddamian_96_tiprack_20ul`, `cosmas_and_damian_biotix_96_200ul_tiprack`, `cosmas_and_damian_drybath_tuberack`, `custom_2ml_24_tube_rack`) is a procedure failure to raise.
- `GET /protocols` on each robot: the active uploads must carry the current `opentrons_protocols.fileHash` (a stale `.py` means someone skipped Sync).
- Daemon version/sha in the latest `robot_link_samples` equal across robots and equal to `origin/master`.

## What "done" looks like for a fix

The runbook step that would have found it faster is updated, the number that would have flagged it earlier is on the connectivity page or in a saved query, and the invariant that would have prevented it is enforced in code (a refusal with a message), not just documented.
