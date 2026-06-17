# AUDIT — `feature/opentrons-api-phase1-3` vs `master`

**Date:** 2026-04-17
**Branch:** `feature/opentrons-api-phase1-3`
**Merge-base with master:** `c6ccec0` (`feat: add lot barcode scan, fix save button, link to wax filling traceability`)
**Scope:** only the 3 opentrons commits ahead of merge-base. Master has advanced independently; those unrelated changes do not belong to this audit.

Categorization key:
- **A** — HTTP proxy / client / UI / pure-pass-through code. Keep for Step 1.
- **B** — MongoDB persistence layer. Defer to Step 2.
- **Mixed** — Same file contains both; call out line ranges.

Out-of-scope master-side scaffolding (already on master, not touched by this branch — noted for context only):
- `src/lib/server/db/models/opentrons-robot.ts` — `OpentronsRobot` Mongoose model (A/B ambiguous — preexisting; a DB-free replacement config source would be nicer, but not our audit's call).
- `src/lib/server/opentrons/proxy.ts` — exports `robotBaseUrl` (A) and `updateRobotHealth` (likely B — name implies DB write). Inspect in Task 2.

---

## 1. Commit-by-commit A/B table

| # | SHA | Title | Verdict | A % | B % |
|---|-----|-------|---------|-----|-----|
| 1 | `638b349` | Phase 1 — real-time robot status via health poller + SSE | **Mixed** | ~60 | ~40 |
| 2 | `99fd8de` | Phase 2 — protocol management with BIMS-side CRUD + robot deploy | **Mostly B** | ~10 | ~90 |
| 3 | `c84bebd` | Phase 3 — run lifecycle, traceability, run status polling | **Mostly B** | ~5 | ~95 |

**Phase 1 Mixed:** polling shell + SSE route + client store are A, but the poll loop reads `OpentronsRobot` and `OpentronsRunRecord` from Mongo and calls a (likely) DB-writing `updateRobotHealth`.
**Phase 2 Mostly B:** introduces `OpentronProtocol` model and full CRUD against it. Only the multipart-upload + analysis-polling pattern inside `deploy/+server.ts` is useful A.
**Phase 3 Mostly B:** introduces `OpentronsRunRecord` model. Everything persists. The only A content is the HTTP shape of `POST /runs` / `POST /runs/{id}/actions` / `GET /runs/{id}` — those patterns can be rebuilt trivially from the OpenAPI spec (Task 3).

---

## 2. File-by-file A/B table

Total: 13 files touched by the 3 commits (11 added, 2 modified).

| # | File | Commits | Verdict | Notes |
|---|------|---------|---------|-------|
| 1 | `src/lib/stores/robot-health.ts` | P1 | **A** | Pure client-side SSE store + auto-reconnect. Zero DB. Port verbatim. |
| 2 | `src/routes/api/opentrons-lab/robots/health-stream/+server.ts` | P1 | **A** | SSE endpoint body is DB-free. Only depends on a cleaned `health-poller.ts`. Port verbatim (after #3). |
| 3 | `src/lib/server/opentrons/health-poller.ts` | P1 + P3 | **Mixed** | Polling architecture is A; DB coupling is B. See §3 for lines to strip. |
| 4 | `src/lib/server/db/models/index.ts` | P2 + P3 | **Mixed** | Adds 2 export lines for new models. Strip both. See §3. |
| 5 | `src/lib/server/db/models/opentrons-protocol.ts` | P2 | **B** | Entire file is a Mongoose model. Do not port. |
| 6 | `src/routes/api/opentrons-lab/protocols/+server.ts` | P2 | **B** | GET/POST both hit `OpentronProtocol` in Mongo. Replace in Step 1 with pass-through to `GET/POST /protocols` on the robot. |
| 7 | `src/routes/api/opentrons-lab/protocols/[protocolId]/+server.ts` | P2 | **B** | Pure CRUD on `OpentronProtocol`. Replace with robot-side detail/delete pass-through. |
| 8 | `src/routes/api/opentrons-lab/protocols/[protocolId]/deploy/+server.ts` | P2 | **Mixed** | Multipart upload + analysis poll loop is A; reading/updating `OpentronProtocol` is B. See §3 for salvageable line ranges. |
| 9 | `src/lib/server/db/models/opentrons-run-record.ts` | P3 | **B** | Entire file is a Mongoose model. Do not port. |
| 10 | `src/lib/server/opentrons/run-lifecycle.ts` | P3 | **B** | Every function reads or writes `OpentronsRunRecord` / `OpentronProtocol` / `OpentronsRobot`. The HTTP patterns inside are trivial to rebuild from the OpenAPI spec — rebuild, don't port. |
| 11 | `src/routes/api/opentrons-lab/run-records/+server.ts` | P3 | **B** | Pure `OpentronsRunRecord.find(...)` list. Drop entirely. |
| 12 | `src/routes/api/opentrons-lab/run-records/[recordId]/+server.ts` | P3 | **B** | Pure `OpentronsRunRecord` detail fetch. Drop entirely. |
| 13 | `src/routes/api/opentrons-lab/run-records/[recordId]/actions/+server.ts` | P3 | **Mixed** | Route shell (auth, validate, respond) is A; body calls `sendRunAction` which is B. See §3 — reusable if we rebuild `sendRunAction` as DB-free. |

---

## 3. Mixed files — specific line ranges

### `src/lib/server/db/models/index.ts`
Strip these two lines (the diff adds them at ~lines 40–41, right after the `OpentronsRobot` export):

```
export { OpentronProtocol } from './opentrons-protocol.js';
export { OpentronsRunRecord } from './opentrons-run-record.js';
```

### `src/lib/server/opentrons/health-poller.ts` (168 lines total)
- **Strip** line 6: remove `OpentronsRunRecord` from the `$lib/server/db` import. Keep `connectDB` and `OpentronsRobot` for now (robot list source; revisit whether this stays or moves to config in Step 1).
- **Strip** line 8 entirely: `import { pollRunStatus } from './run-lifecycle';`.
- **Strip** lines 137–145: the "Poll active OT-2 run records" block inside `pollAllRobots`. This reads `OpentronsRunRecord` from Mongo and calls the removed `pollRunStatus`. Drop it — per plan, run state lives on the robot.
- **Revisit (not strip)** lines 126–133: the `updateRobotHealth(...)` call. That function lives in master-side `proxy.ts`; name strongly suggests it writes to Mongo. During Task 2, inspect `proxy.ts` — if it writes `OpentronsRobot.updateOne(...)`, replace with a no-op or a pure in-memory setter.
- **Revisit (not strip)** lines 45–46 / 110–115: reads of `OpentronsRobot.find({ isActive: true })`. This is our only source for "which robots exist". Step 1 options: (a) keep reading `OpentronsRobot` as a read-only config collection, or (b) replace with a static env-var / JSON config (`ROBOTS=hidden-leaf,muddy-water,OT2CEP20210817R04`). Option (b) is more aligned with the plan's "no DB" stance and should probably win.

### `src/routes/api/opentrons-lab/protocols/[protocolId]/deploy/+server.ts` (137 lines total)
- **Salvage as reference patterns** (do not port verbatim; re-express in `src/lib/server/opentrons/client.ts` after Task 3):
  - Lines 33–55: multipart-form-data upload to `POST /protocols` on the robot (`Blob` + `FormData` wrapping, `opentrons-version: 3` header).
  - Lines 62–108: analysis polling loop against `GET /protocols/{id}/analyses` with 2s interval / 30s total timeout, including the labware/pipette extraction shape from `latest.result.labware`, `latest.result.pipettes`, `latest.result.runTimeParameters`.
- **Strip everything else in this file**: lines 8 (`OpentronProtocol`, `OpentronsRobot` imports are fine; `generateId` is irrelevant once there's no deployment record to write), lines 19, 24–26 (DB reads of `OpentronProtocol`), lines 90–99 (DB write of labware/pipette/params), lines 113–127 (deployment record write).

### `src/routes/api/opentrons-lab/run-records/[recordId]/actions/+server.ts` (27 lines total)
- The whole file is an ultra-thin route: auth → validate `actionType` → call `sendRunAction` → return. The shell is A but load-bearing only for `sendRunAction` which is B. Port the route shell verbatim in Step 1 **after** replacing `sendRunAction` with a DB-free function that takes `(robotId, opentronsRunId, actionType)` directly.

---

## 4. Recommendation

**Copy-and-strip, off `master`.** Not cherry-pick.

Reasons:
1. **Interleaving.** Category B is woven inside single files (`run-lifecycle.ts`, `health-poller.ts`, `deploy/+server.ts`). A clean cherry-pick of the 3 commits would land the DB models and CRUD wholesale — exactly what §3 of the plan forbids.
2. **Low yield.** Measuring by surviving-line count, maybe 25% of the branch's net LOC is A. Phase 2 and 3 are ≥90% B. Cherry-picking then deleting ~75% of the delta is strictly worse than starting clean and pulling in the ~4 reference patterns by hand.
3. **Master has moved.** The `master..HEAD` stat shows ~90 files changed unrelated to opentrons (CV/DHR/r2/parts/magnetometer reworks). Cherry-picks would hit unrelated merge conflicts.
4. **Task 3 obsoletes the ad-hoc types.** The plan calls for ingesting the live OpenAPI spec and generating TypeScript types. That replaces the hand-rolled request/response shapes scattered through `run-lifecycle.ts` and `deploy/+server.ts` — so re-expressing those patterns against the generated client is cheaper than porting then retrofitting.

### Concrete Task 2 plan
1. `git checkout master && git checkout -b feature/opentrons-clone-ui`.
2. Copy verbatim from this branch:
   - `src/lib/stores/robot-health.ts` → verbatim.
   - `src/routes/api/opentrons-lab/robots/health-stream/+server.ts` → verbatim.
3. Copy with strips per §3:
   - `src/lib/server/opentrons/health-poller.ts` → drop lines 6 (partial), 8, 137–145. Decide on `OpentronsRobot` read vs env-config for robot list. Audit `proxy.ts#updateRobotHealth` for DB writes and neutralize if present.
4. Leave behind (do **not** copy): both new Mongoose models, both `index.ts` export lines, all 4 protocol/run-record CRUD routes, `run-lifecycle.ts` in its current form.
5. Keep open in a reference tab (not committed) for Task 3 / Task 4 rebuild:
   - `deploy/+server.ts` lines 33–55 (multipart) and 62–108 (analysis poll).
   - `run-lifecycle.ts` lines 47–84 (create + play) and 122–145 (action forward) and 154–193 (status poll) — purely for the HTTP call shapes.
   - `run-records/[recordId]/actions/+server.ts` — the route skeleton.
6. Verify starting point: `npm run check` and `npm run build` clean. No new Mongoose models under `src/lib/server/db/models/`. No `AuditLog.create` with robot resourceTypes. No DB writes in any `/api/opentrons-lab/*` route.
7. Commit with subject `chore(opentrons): seed clone branch from Phase 1 A-category code`, reference this AUDIT.md, then start Task 3.

The `feature/opentrons-api-phase1-3` branch stays put as a parking lot for Step 2 to pull Mongo models from when persistence is actually needed.
