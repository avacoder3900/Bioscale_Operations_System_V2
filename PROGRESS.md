# PROGRESS — Opentrons clone (Step 1)

Living checklist. Update after every commit.

## Tasks

| Task | Status | Commit |
|------|--------|--------|
| 1 — Audit `feature/opentrons-api-phase1-3` | ✅ done | `AUDIT.md` (on clone-ui branch) |
| 2 — Create Step-1 branch | ✅ done | `dfcedcd` |
| 3 — Ingest live OpenAPI spec | ✅ done | `685ba9b` |
| 4 — Parity rows (see below) | ✅ done | rows 20, 24 parked (API gap / low-priority) |
| 5 — Verify end-to-end against real robot | ✅ done (34/34 hidden-leaf) | `93a7acf`, `VERIFIED.md` |
| 6 — Operator gate, nav link, dark mode, confirm dialogs, sort | ✅ done | `e968e4d` |

## Step 1.5 — Production-readiness (DOMAIN-12)

PRD: `docs/migration/prds/DOMAIN-12-OPENTRONS-CLONE-PROD-READY.md`

| Story | Title | Status | Commit |
|-------|-------|--------|--------|
| OT-A | Runtime parameters form | ⏳ pending | — |
| OT-B | Deck / labware setup checklist | ⏳ pending | — |
| OT-C | Pipette attach confirmation | ⏳ pending | — |
| OT-D1 | Maintenance-run session wrapper | ⏳ pending | — |
| OT-D2 | LPC wizard UI | ⏳ pending | — |
| OT-D3 | Offsets applied on run create | ⏳ pending | — |
| OT-D4 | End-to-end verify + PRODUCTION-READY.md | ⏳ pending | — |

## Parity rows (§4 of OPENTRONS-CLONE-PLAN.md)

| # | Surface | Status | Notes |
|---|---------|--------|-------|
| 1 | Robot list + health | ✅ | `/opentrons-clone` landing + SSE store |
| 2 | Server/API version | ✅ | Covered via `/health` (no separate `/server/version` on API 8.7.0) |
| 3 | Instruments (pipettes) | ✅ | Robot detail page, `/instruments` |
| 4 | Modules | ✅ | Robot detail page, `/modules` |
| 5 | Calibration status (read-only + staleness) | ✅ | Robot detail page, deck + pipette offsets + tip length |
| 6 | Protocol list | ✅ | Per-robot `/opentrons-clone/:r/protocols`, live `GET /protocols` |
| 7 | Protocol upload | ✅ | Multipart form action → `POST /protocols` on robot |
| 8 | Protocol detail | ✅ | `/opentrons-clone/:r/protocols/:p` |
| 9 | Protocol analysis | ✅ | Latest analysis inline — runtime params, pipettes, labware |
| 10 | Protocol delete | ✅ | Form action → `DELETE /protocols/{id}` |
| 11 | Protocol file download | ⚠️ partial | Raw `.py` not in OT-2 API 8.7.0. Exposed `asDocument` analysis JSON via `/api/opentrons-clone/robots/:r/protocols/:p/analysis/:a/document`. |
| 12 | Runs list | ✅ | `/opentrons-clone/:r/runs` |
| 13 | Run create | ✅ | "Start a run" form action on protocol detail |
| 14 | Run detail | ✅ | `/opentrons-clone/:r/runs/:id` |
| 15 | Run current state | ✅ | Shown inline; 3s poll while active |
| 16 | Run commands | ✅ | Paginated list, scrollable |
| 17 | Run command errors | ✅ | Red banner when present |
| 18 | Run actions | ✅ | play/pause/stop/resume-from-recovery buttons |
| 19 | Run delete | ✅ | Danger-zone form action |
| 20 | Enqueue command | ⏳ | `POST /runs/{id}/commands` (advanced; parked) |
| 21 | Home robot | ✅ | Controls section on robot detail (robot + per-mount) |
| 22 | Lights | ✅ | Toggle button reflecting current state |
| 23 | Identify (blink) | ✅ | `POST /identify?seconds=10` |
| 24 | Labware definitions | ⚠️ not in API | `GET /labware/definitions` is 404; `/labware/calibrations` removed. Per-run definitions only. |
| 25 | Labware offsets (read) | ✅ | `/opentrons-clone/:r/labware` page + per-run block on run detail |
| 26 | Labware offsets (per-run) | ✅ | Power-user form on run detail → `POST /runs/{id}/labware_offsets` |
| 27 | Settings list | ✅ | `/opentrons-clone/:r/settings` — feature flags list |
| 28 | Settings update | ✅ | Per-row Enable/Disable form action |
| 29 | Settings reset | ✅ | Reset categories from `/settings/reset/options` |
| 30 | Server logs download | ✅ | Robot detail: api/server/serial/update_server.log links, streamed via `/api/opentrons-clone/.../logs/:logId` |
| 31 | Error recovery policy | ✅ | Toggle on settings page |
| 32 | Networking info | ✅ | Interface table on settings page |
| 33 | Data files | ✅ | `/opentrons-clone/:r/data-files` — list, upload, delete, download |
| 34 | Client data K/V | ✅ | Lookup + PUT + DELETE forms on data-files page |
| 35 | System clock | ✅ | Robot vs BIMS time + drift + Sync button on settings page |

## Commits on `feature/opentrons-clone-ui`

- `dfcedcd` — seed (Phase 1 A-category)
- `685ba9b` — Task 3 typed client
- `796361a` — Task 4a landing page (rows 1-2)
- `a87bc66` — Task 4b robot detail (rows 3-5)
- `e213175` — PROGRESS.md
- `01c823b` — Task 4c protocols section (rows 6-11)
- `28e838f` — PROGRESS update
- `4193c08` — Task 4d runs section (rows 12-19)
- `b57554c` — PROGRESS update
- `bf77ed0` — Task 4e controls (rows 21-23)
- `72da5d9` — Task 4f labware (rows 24-26)
- `d86d013` — PROGRESS update
- `2371ef2` — Task 4g settings/logs/data-files/client-data/time (rows 27-35)

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
