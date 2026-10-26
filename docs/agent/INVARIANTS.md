# Invariants and footguns

Each of these cost at least one production incident. Check the list before changing geometry, run start, the daemon, or the Studio.

1. **A labware definition is shared by every robot.** `labware_definitions` has one document per load name. Cartridge decks are per physical deck (`gen4deck_gen7cartridge_00N`), so editing one is fine. Tip racks and tube racks are the same part on every robot: editing them in the Studio moved every robot at its next run start (2026-10-26, R04's +2/+5 broke B07). Per-robot rack placement lives in `robot_labware_offsets` (CALIB-5); the Studio refuses shared writes for racks.
2. **run_start_auto_resync pushes geometry silently.** Any change to a definition's wells makes every robot re-upload its protocol at the next start (`protocol-freshness.ts` compares bundled wells to Mongo). It does not compare the `.py` text: to ship a protocol change, refresh `opentrons_protocols.fileContent` and either Sync or wait for a well change.
3. **The .py is the applier of labware offsets.** On API 2.18+ `Labware.set_offset()` adds a run-level offset that overrides anything sent in `POST /runs`. Rack offsets therefore travel as `tiprack_offset_*` / `tuberack_offset_*` RTPs; `offset_x/y/z` is carriage-only and always 0 since 2026-08-19.
4. **The Studio's "Move to hole" moves to the labware in the dropdown; "Pick up tip" uses the tip profile's rack.** With kind=tip they can be different racks. Compare like with like (CALIB-5 locks them together).
5. **Studio frames: tip-neutral teaching.** Decks are taught with "Calibrate tip" active, so stored hole coordinates only land when the fill applies the same probe adjust. A deck taught raw (no Calibrate tip) is off by the adjust in production, and the fill always probes (`use_tip_calibration` is forced true by BIMS).
6. **The probe adjust is mostly fixture geometry, not tip bend.** B07 ≈ (−2.5, 0), R04 ≈ (−6, −1): the C-string baseline and the probe recipe (wax starts at cal_x−0.6/cal_y−6.5, reagent at cal_x−1.4/cal_y−7.0) are part of the number. Changing the fixture, the probe Z, the baseline or the recipe moves every hole on that robot.
7. **"NO TIP DETECTED" after a rack pick-up means the rack is in the wrong place more often than it means no tip.** A tip pressed 2–5 mm off-centre seats crooked and misses the X switch within 5 mm.
8. **Health is a 60 s window on one overwritten heartbeat doc** (`scanner_events` `hb:<deviceId>`, `health.ts`). "Offline" means "no heartbeat in 60 s", nothing more. History is in `robot_link_samples` (OT2-LOG-1).
9. **restart_robot_server waits 90 s; the robot-server takes 2–3 min to boot.** "did not come back after restart" is a false negative until OT2-WIRED-1 phase 2 raises the wait.
10. **Run creation on a Pi 3 takes 15–30 s.** A fill start that "froze" usually created the run; `startPrepare` adopts an idle run with the same protocol and RTPs instead of making a second one.
11. **Heartbeat docs must stay one per device.** Storing one doc per heartbeat grew `scanner_events` to 1.5M docs (2026-07-31). New time series sample at ≤ 1/min and carry a TTL.
12. **Resume/adopt compares run-time parameters as strings.** Anything that must distinguish two starts (deck, offsets) has to be in the RTPs or in `startIntent.createArgs`.
13. **The daemon's serial devices are USB on the Pi.** Any design that moves the daemon off the robot has to move the calibrator fixture and barcode scanner too.
14. **Never deploy to Vercel from the CLI; never push to master directly.** Feature branch → push → preview; PR → master (CLAUDE.md, AGENTS.md).
