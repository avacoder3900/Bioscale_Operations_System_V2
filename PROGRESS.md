# PROGRESS — Opentrons clone (Step 1)

Living checklist. Update after every commit.

## Tasks

| Task | Status | Commit |
|------|--------|--------|
| 1 — Audit `feature/opentrons-api-phase1-3` | ✅ done | `AUDIT.md` (on clone-ui branch) |
| 2 — Create Step-1 branch | ✅ done | `dfcedcd` |
| 3 — Ingest live OpenAPI spec | ✅ done | `685ba9b` |
| 4 — Parity rows (see below) | 🟡 in progress | — |
| 5 — Verify end-to-end against real robot | ⏳ blocked on user (physical robot access) | — |

## Parity rows (§4 of OPENTRONS-CLONE-PLAN.md)

| # | Surface | Status | Notes |
|---|---------|--------|-------|
| 1 | Robot list + health | ✅ | `/opentrons-clone` landing + SSE store |
| 2 | Server/API version | ✅ | Covered via `/health` (no separate `/server/version` on API 8.7.0) |
| 3 | Instruments (pipettes) | ✅ | Robot detail page, `/instruments` |
| 4 | Modules | ✅ | Robot detail page, `/modules` |
| 5 | Calibration status (read-only + staleness) | ✅ | Robot detail page, deck + pipette offsets + tip length |
| 6 | Protocol list | ⏳ | `/opentrons-clone/protocols` (next) |
| 7 | Protocol upload | ⏳ | multipart `POST /protocols` |
| 8 | Protocol detail | ⏳ | `GET /protocols/{id}` |
| 9 | Protocol analysis | ⏳ | `GET /protocols/{id}/analyses` |
| 10 | Protocol delete | ⏳ | `DELETE /protocols/{id}` |
| 11 | Protocol file download | ⏳ | confirm path from OpenAPI |
| 12 | Runs list | ⏳ | `GET /runs` |
| 13 | Run create | ⏳ | `POST /runs` with `{data: {protocolId}}` |
| 14 | Run detail | ⏳ | `GET /runs/{id}` |
| 15 | Run current state | ⏳ | `GET /runs/{id}/currentState` |
| 16 | Run commands | ⏳ | `GET /runs/{id}/commands`, detail |
| 17 | Run command errors | ⏳ | `GET /runs/{id}/commandErrors` |
| 18 | Run actions | ⏳ | play/pause/stop/resume-from-recovery |
| 19 | Run delete | ⏳ | `DELETE /runs/{id}` |
| 20 | Enqueue command | ⏳ | `POST /runs/{id}/commands` |
| 21 | Home robot | ⏳ | `POST /robot/home` |
| 22 | Lights | ⏳ | `GET/POST /robot/lights` |
| 23 | Identify (blink) | ⏳ | `POST /identify` |
| 24 | Labware definitions | ⏳ | `GET /labware/definitions` |
| 25 | Labware offsets (read) | ⏳ | `GET /labwareOffsets` |
| 26 | Labware offsets (per-run) | ⏳ | `POST /runs/{id}/labware_offsets` |
| 27 | Settings list | ⏳ | `GET /settings` |
| 28 | Settings update | ⏳ | `POST /settings` |
| 29 | Settings reset | ⏳ | `POST /settings/reset` |
| 30 | Server logs download | ⏳ | confirm path from OpenAPI |
| 31 | Error recovery policy | ⏳ | `GET/PATCH /errorRecovery/settings` |
| 32 | Networking info | ⏳ | `GET /networking/status` |
| 33 | Data files | ⏳ | `POST/GET/DELETE /dataFiles` |
| 34 | Client data K/V | ⏳ | `PUT/GET/DELETE /clientData/{key}` |
| 35 | System clock | ⏳ | `GET/PUT /system/time` |

## Commits on `feature/opentrons-clone-ui`

- `dfcedcd` — seed (Phase 1 A-category)
- `685ba9b` — Task 3 typed client
- `796361a` — Task 4a landing page (rows 1-2)
- `a87bc66` — Task 4b robot detail (rows 3-5)

## Live robot facts (as of 2026-04-17)

All 3 robots online, API 8.7.0, firmware v1.1.0-25e5cea:
- hidden-leaf (OT2CEP20200217B07): p300 single-gen2 left, p20 single-gen2 right
  - deck cal 2023-11-21 (stale), pipette offsets Nov 2025 (fresh)
- muddy-water (OT2CEP20200309B14): (not inspected yet)
- OT2CEP20210817R04: (not inspected yet)

## Guardrails reminder

- No new Mongoose models.
- No AuditLog for robot actions.
- No DB caching of robot state (except reading `OpentronsRobot` as robot-list source).
- `/opentrons-clone/*` only; do not touch `/opentrons/*`, `/manufacturing/wax-filling/*`, `/manufacturing/reagent-filling/*`, `/manufacturing/opentron-control/*`.
