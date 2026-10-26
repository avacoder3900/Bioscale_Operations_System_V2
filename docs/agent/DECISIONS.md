# Decisions (robot side) — newest first

Format: date · decision · who · why · where it is written down. Re-deciding one of these needs the person named.

- **2026-10-26 · Wired-first, iMac as gateway, WiFi off after cutover, no automatic fallback (queue or WiFi), logging before path changes, 50-day retention, no alerts, per-robot rack offsets** · Jacob · the full chain is in `docs/prds/OT2-WIRED-1-PLAN.md` §1. Router/jack: none available; the iMac is the only wired hub.
- **2026-10-26 · Rack offsets are per robot × rack definition × slot and travel as RTPs → `set_offset`** · Jacob ("yes do it") · one shared definition moved every robot; the `.py` overrides `POST /runs` offsets on API 2.18+ · `docs/prds/CALIB-5-PER-ROBOT-RACK-OFFSETS.md`. Supersedes CALIB-3 decision 2 for racks.
- **2026-10-26 · Migration: shared drybath back to Oct-14 geometry; R04 20 µL offset (+2, +4, 0); B07 drybath 0 with a note; 200 µL rack keeps its −1 mm Z for everyone** · Jacob/Claude · "current state is the default" interpreted as "no robot moves from the geometry it completed a run on" · CALIB-5 §3, applied 2026-10-26 ~20:20Z.
- **2026-10-21 · R04 reagent probe Z 39.8 (40.8 missed the Y switch)** · Samantha/Claude · probe-only test · audit `save_calibrator` 2026-10-21T15:57Z.
- **2026-10-07 · Audit verdict: transport fine, WiFi and code-level timeouts are the problem; eight ordered changes** · Alejandro · `docs/OT2-TAILNET-CONNECTION-AUDIT-2026-10-07.md` §0, §6. S1–S5 shipped as TAILNET-6 (af886a5f); run-create adopt shipped (ffa55706).
- **2026-09-25 · B14 first onto the tailnet; `/opentrons-clone` kept as the Opentrons UI over the tailnet** · Jacob · `OT2-TAILNET-3`, `OT2-TAILNET-5` Q1.
- **2026-08-28 · The tip-calibrator fixture is keyed by deck (Particle id), not robot** · Jacob · the fixture is bolted to the carriage · `tip-calibrator-fixture.ts` header.
- **2026-08-19 · Positional model: one source of truth for a hole is the deck definition; all global offsets forced to 0; the per-tip probe is the only correction** · Jacob · the Studio applied no global offset while runs did, so verified ≠ run · `calibration-rtps.ts` header.
- **2026-08-17 · Lab gateway deferred** · Jacob · scanner is USB on each robot; the iMac is a workstation · `docs/prds/LAB-GATEWAY-1-DEFERRED.md`. Partially revisited 2026-10-26 (iMac becomes the NAT gateway only).
- **2026-08-17 · Direct OT-2 control over Tailscale, queue as fallback** · Jacob · `docs/prds/OT2-TAILNET-0-PLAN.md`. Fallback becomes explicit in OT2-WIRED-1 phase 2.
- **2026-07-31 · Heartbeats are one overwritten doc per device** · ops · Atlas incident at 1.5M docs · `api/agent/scanner/event/+server.ts`.
