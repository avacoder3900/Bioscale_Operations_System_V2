# Opentrons Clone Plan — Handoff Document

**Date:** 2026-04-17
**Handoff from:** Claude session in `wax-and-reagent-split-up` branch (at `Bioscale_Operations_System_V2-1/`)
**Handoff to:** New Claude session in this worktree (`Bioscale_Operations_System_V2-opentrons-phase1-3/`)
**Status:** Planning complete. Implementation not started.

This document is the single source of truth for building the Opentrons clone inside BIMS. Read it end-to-end before touching code.

---

## 1. Goal

Build a **full-parity, in-BIMS clone of the Opentrons desktop App**. When it's done, operators should be able to do everything in BIMS that they do in the Opentrons App today — connect to robots, see health/calibration/instruments, upload/manage protocols, start/pause/stop/abort runs, view run logs, manage labware offsets, read settings.

This is **Step 1** of a two-step plan. Step 2 (later, separate work) wires the clone into the existing Opentron Control page and the wax/reagent filling workflows.

---

## 2. Locked architecture decisions

### 2.1 Bridge host
The **existing lab Mac** that has been running the Opentrons App for years is the bridge. NOT a new Mac mini. BIMS dev/prod runs on that Mac, or on any machine on the same LAN as the robots. All 3 OT-2s share the same local WiFi network as that Mac.

Production BIMS on Vercel **cannot** reach `*.local:31950`. That's OK — Step 1 runs locally on the lab Mac. Production deployment is a later concern.

### 2.2 Thin-client model — NO MongoDB in Step 1
The robot's HTTP API on port 31950 is the source of truth for everything: protocols, runs, calibration, logs, settings. BIMS is a **pure pass-through**:

- No `OpentronsRunRecord` Mongo model
- No `OpentronsProtocol` Mongo model
- No `AuditLog` entries for robot actions
- No caching robot state into our DB
- No mirroring run history into our DB

If the operator reloads a page, we re-fetch from the robot. If we want to display a list of protocols, we `GET /protocols` live. If we want run history, we `GET /runs`. All persistence that matters lives on the robot.

**Why:** gain verified operational parity with the Opentrons App before coupling to business workflows. When Step 2 starts and we need traceability (CartridgeRecord ↔ runId), we add persistence layers on top of a proven control layer, not mixed in with it.

### 2.3 Communication
- **Protocol:** HTTP/1.1
- **Port:** 31950
- **Discovery:** `<hostname>.local` via mDNS (muddy-water, OT2CEP20210817R04, hidden-leaf)
- **Auth:** none (local network, trust boundary is WiFi)
- **Required header on every request:** `Opentrons-Version: *`
- **Content type:** JSON, except protocol upload (multipart form-data)
- **Live updates:** polling only (no websockets, no SSE from the robot)
- **Type source:** each robot serves its own OpenAPI spec at `http://<robot-ip>:31950/openapi` — we can ingest this to auto-generate TypeScript types for all request/response shapes

### 2.4 Calibration wizards — skipped in Step 1
The Opentrons App has three interactive calibration wizards (pipette offset, tip length, deck). They're multi-step state machines with real-time motor jog, "touch this point, confirm" prompts, video guides. They use `/maintenance_runs` under the hood.

**We do NOT reimplement these in Step 1.** Reasons: low frequency (monthly per robot at most), high implementation cost (a week+ each), physical presence required anyway (operator standing at the robot), and risk asymmetry (a bug silently writes bad offsets, corrupting every subsequent run).

**What BIMS provides instead:**
- Read-only calibration status card per robot (last calibrated, offsets, tip length, staleness days)
- Alert when calibration is stale (>7 days since last, tunable)
- A visible "Open Opentrons App on this Mac to calibrate" prompt when wizards are needed

Revisit wizard reimplementation only if Step 2/3 exposes a real pain point.

### 2.5 UI target
The existing `/manufacturing/opentron-control` page (already built on the `wax-and-reagent-split-up` branch) is the visual target for where clone functionality will eventually surface. For **Step 1**, do NOT wire anything from this new clone into that page, into the wax-filling pages, or into the reagent-filling pages. Build the clone as a standalone section first. Wire-up is Step 2.

---

## 3. What NOT to do in Step 1

Strict guardrails:

- ❌ **No new Mongoose models** for robot state (protocols, runs, commands, offsets, logs, etc.)
- ❌ **No `AuditLog.create` calls** for robot actions
- ❌ **No edits to** `src/routes/manufacturing/wax-filling/` or `src/routes/manufacturing/reagent-filling/` or `src/routes/manufacturing/opentron-control/`
- ❌ **No reimplementation of calibration wizards** (pipette offset / tip length / deck)
- ❌ **No caching robot state to our DB**, even "for performance"
- ❌ **No Vercel-specific concerns** — Step 1 runs on the lab Mac on the LAN

If something feels like it needs persistence, park it. Step 2 is the right time.

---

## 4. Parity checklist

Every row below must be reachable and functional in the BIMS clone by end of Step 1. Each maps to a specific OT-2 HTTP endpoint. All pass-through, no Mongo.

| # | Clone surface | OT-2 HTTP endpoint(s) | Notes |
|---|---|---|---|
| 1 | Robot list + health | `GET /health` | Per-robot. Polled every ~10s for online/offline |
| 2 | Server/API version | `GET /server/version` | Display next to each robot |
| 3 | Instruments (pipettes) | `GET /instruments`, `GET /pipettes` | Attached pipettes, mount, tip state |
| 4 | Modules | `GET /modules` | Temp/mag/thermocycler (none attached today; surface still needed) |
| 5 | Calibration status (read-only) | `GET /calibration/status`, `/calibration/pipette_offset`, `/calibration/tip_length`, `/labwareOffsets` | Display + staleness calc |
| 6 | Protocol list | `GET /protocols` | |
| 7 | Protocol upload | `POST /protocols` (multipart) | `.py` + optional support files |
| 8 | Protocol detail | `GET /protocols/{id}` | |
| 9 | Protocol analysis | `GET /protocols/{id}/analyses`, `GET /protocols/{id}/analyses/{aid}` | Labware/pipette/command breakdown |
| 10 | Protocol delete | `DELETE /protocols/{id}` | |
| 11 | Protocol file download | Need to verify exact path from live OpenAPI | Export `.py` back to operator |
| 12 | Runs list | `GET /runs` | |
| 13 | Run create | `POST /runs` with `{data: {protocolId}}` | Optional runtime params via data files |
| 14 | Run detail | `GET /runs/{id}` | |
| 15 | Run current state | `GET /runs/{id}/currentState` | **Not `/state`** — confirmed from PRD |
| 16 | Run commands (history) | `GET /runs/{id}/commands`, `GET /runs/{id}/commands/{cid}` | Step-by-step log |
| 17 | Run command errors | `GET /runs/{id}/commandErrors` | |
| 18 | Run actions (play/pause/stop/resume) | `POST /runs/{id}/actions` with `{data: {actionType: "play"}}` | Valid action types: `play`, `pause`, `stop`, `resume-from-recovery` |
| 19 | Run delete | `DELETE /runs/{id}` | |
| 20 | Enqueue command to run | `POST /runs/{id}/commands` | Ad-hoc commands inside a run |
| 21 | Home robot | `POST /robot/home` | All axes or specific mount |
| 22 | Lights read/write | `GET /robot/lights`, `POST /robot/lights` | |
| 23 | Identify robot (blink) | `POST /identify` | Blink lights for N seconds — useful for multi-robot |
| 24 | Labware definitions | `GET /labware/definitions` | |
| 25 | Labware offsets (read) | `GET /labwareOffsets` | |
| 26 | Labware offsets (per-run) | `POST /runs/{id}/labware_offsets` | Apply offsets when creating a run |
| 27 | Settings list | `GET /settings` | Feature flags |
| 28 | Settings update | `POST /settings` | |
| 29 | Settings reset | `POST /settings/reset` | Reset categories: calibration, protocols, etc. |
| 30 | Server logs download | Verify from live OpenAPI — robot exposes log files | Raw log file stream |
| 31 | Error recovery policy | `GET /errorRecovery/settings`, `PATCH /errorRecovery/settings` | |
| 32 | Networking info | `GET /networking/status` | IP, interfaces, WiFi state |
| 33 | Data files | `POST /dataFiles`, `GET /dataFiles`, `GET/DELETE /dataFiles/{id}` | CSV upload for runtime params |
| 34 | Client data (K/V) | `PUT/GET/DELETE /clientData/{key}`, `DELETE /clientData` | Arbitrary robot-side key/value — useful for batch/lot stamps **without** our DB |
| 35 | System clock | `GET/PUT /system/time` | Surface in robot detail; alert if drifted |

**Not in Step 1** (explicitly out of scope):
- Maintenance runs (`POST /maintenance_runs`) — only needed for wizards, which we skip
- Jupyter notebook server (port 48888) — deprecated API version
- SSH terminal surface — out of scope for a web UI
- WebSocket RPC — deprecated, don't touch
- WiFi scan/connect/disconnect — ops handle networking outside BIMS

---

## 5. Branch strategy

### 5.1 Current state
The branch you are on, `feature/opentrons-api-phase1-3`, is a mixed branch. It contains both:

- **Category A — HTTP proxy/client code** (reusable, belongs in Step 1): the glue that turns BIMS requests into HTTP calls to `<robot>:31950` with proper headers, timeouts, error shaping.
- **Category B — MongoDB persistence layer** (premature for Step 1, needed in Step 2): new Mongoose models (confirmed in the branch): `opentrons-protocol.ts`, `opentrons-run-record.ts`, and any code that writes `OpentronsRunRecord` / `OpentronsProtocol` / `AuditLog` docs on robot events.

### 5.2 Plan — work in branches, don't touch master
1. **Audit** `feature/opentrons-api-phase1-3` first. Categorize every changed file and every new commit as A or B. Produce a written punch list. See §6 Task 1.
2. **Create a new branch** off `feature/opentrons-api-phase1-3` (or off master, whichever gives the cleanest starting point — decide after the audit). Suggested name: `feature/opentrons-clone-ui`.
3. **Cherry-pick Category A** into the new branch. Leave Category B in place in `feature/opentrons-api-phase1-3` as a parking lot for Step 2.
4. **If Category A and Category B are deeply interleaved inside the same files**, the cleanest move is to copy the relevant files into the new branch and strip the Mongo code line-by-line rather than cherry-picking. The audit will tell us which of these two modes to use.
5. **Do NOT merge anything into master in this phase.** All work stays on feature branches until Step 1 is demonstrated end-to-end against a real robot.

### 5.3 The `wax-and-reagent-split-up` branch (separate concern)
A separate branch (`wax-and-reagent-split-up`) is restructuring the wax/reagent filling UI and adding the new `/manufacturing/opentron-control` page. That branch is orthogonal to Step 1. It can be merged on its own schedule without blocking (or being blocked by) Step 1. Do not touch it from this worktree.

---

## 6. First-session tasks (ordered)

Do these in order. Don't start #2 until #1 is done. Each step ends with a concrete artifact.

### Task 1 — Audit `feature/opentrons-api-phase1-3`
**Goal:** produce an A/B categorization for every file and commit on this branch vs master.

- Run `git log master..HEAD --oneline` and categorize each commit.
- Run `git diff master..HEAD --stat` and categorize each file.
- For each file, mark A (HTTP/UI, keep), B (Mongo, defer), or Mixed (split).
- For Mixed files, list specific line ranges that are Category B.

**Artifact:** `AUDIT.md` at the top of the worktree with:
1. Commit-by-commit A/B table
2. File-by-file A/B table
3. List of Mixed files with specific line ranges to strip
4. Recommendation: cherry-pick vs. copy-and-strip

Do NOT delete anything yet. Audit-only.

### Task 2 — Create the Step-1 branch
Based on the audit:
- If most of the branch is pure Category A: cherry-pick commits onto a new branch off master → name it `feature/opentrons-clone-ui`.
- If Category A and Category B are interleaved: create the new branch off `feature/opentrons-api-phase1-3`, then delete the Mongo code.

Either way, the new branch at the end of Task 2 should:
- Build cleanly (`npm run check`, `npm run build`)
- Have no new Mongoose models
- Have no `AuditLog.create` for robot actions
- Have the HTTP proxy/client code intact

**Artifact:** a new branch with a single commit describing the Step-1 starting point.

### Task 3 — Ingest the live OpenAPI spec
On any reachable robot (start with `hidden-leaf`, it has the calibrated offsets), fetch `http://hidden-leaf.local:31950/openapi` and save it to `src/lib/server/opentrons/openapi.json`. Use it to generate TS types via `openapi-typescript` (or similar). This becomes the typed contract between BIMS and the robot.

**Artifact:** typed OT-2 client module (`src/lib/server/opentrons/client.ts` or similar), generated from the live spec. Stateless. No DB.

### Task 4 — Build out the parity checklist surfaces
Work through the 35 rows in §4 in a sensible order (suggested: connection → instruments → protocols → runs → calibration → logs → settings). For each row:
- Add a server route that proxies the relevant endpoint
- Add a UI page/section that reads from the proxy
- Test against a real robot on the lab LAN

UI pages live under a new route root — suggestion: `/opentrons-clone/` or `/robots/` (decide based on what doesn't conflict with existing routes — check `src/routes/` first).

Keep pages dumb: fetch → render. No Svelte stores for robot state. No caching. Every page-load refetches.

### Task 5 — Verify end-to-end against a real robot
Once all 35 rows are built, run through a full flow on an actual robot (ideally `hidden-leaf`):
1. See robot online
2. Upload a protocol (`.py` file from our existing wax-filling or reagent-filling scripts)
3. See analysis results
4. Create a run
5. Play it (on an empty deck or with a dry-run flag)
6. Watch live command log
7. Pause and resume
8. Stop
9. View run history
10. View server logs
11. Read calibration status

If every one of those works end-to-end, Step 1 is done. Write a short VERIFIED.md with a timestamp and which robot you tested against.

---

## 7. Open items the new session should resolve

- **Exact route root for the clone** — `/opentrons-clone`, `/robots`, `/opentrons`, or something else? Check existing routes first; don't collide.
- **Protocol file download endpoint path** — PRD implies it exists; confirm from live OpenAPI.
- **Server log download endpoint path** — same; confirm from live OpenAPI.
- **Permission model** — does the clone UI require a new permission string (e.g., `opentrons:control`), or reuse `manufacturing:write`? Read `src/lib/server/permissions.ts` and `SECURITY.md` before deciding.
- **Error handling for offline robots** — when a robot isn't reachable, how does the UI communicate that? Probably: a per-robot status card that degrades gracefully. Decide the UX pattern early and use it consistently.
- **Multi-robot concurrency** — operators may want to see all 3 robots in parallel on one page (`/opentrons-clone/`) and also drill into one at a time (`/opentrons-clone/[robotId]/`). Plan route structure accordingly.

---

## 8. Research corpus

All background research is at:
`C:\Users\nicho\Desktop\Opentron-Integration-Research\`

Contents:
- `01_Opentron-API-Integration-PRD.pdf` + `01_...PRD_OCR.txt` — primary PRD, text via OCR
- `02_OPENTRONS-COMPLETE-GUIDE.pdf` + `.txt` — plain-English tech guide
- `03_OPENTRONS-FINAL-REPORT.pdf` + `.txt` — verification report
- `04_OPUS-FINAL-OPENTRONS-REPORT.pdf` + `.txt` — model comparison + integration plan
- `05_opentrons-knowledge-base.md` — detailed endpoint reference
- `06_homemade-opentrons-research.md` — DIY alternatives (not applicable)
- `07_Opentron-Cheat-Sheet.pdf` — image-based, not OCR'd (not critical)
- `08_opentron-control-analysis.md` + `.pdf` — the Opentron Control page analysis (for the separate wax/reagent split branch)
- `prd_pages/` — page-by-page PNGs + per-page OCR of the primary PRD

Read the PRD OCR (`01_..._OCR.txt`) for the canonical endpoint list. Supplement with `05_opentrons-knowledge-base.md` for deeper context on specific endpoints.

---

## 9. Our 3 robots (from prior research)

| Robot | Serial | Hostname | Position | Known offsets |
|---|---|---|---|---|
| Left (B14) | OT2CEP20200309B14 | `muddy-water` | Left bench | TBD |
| Middle (R04) | OT2CEP20210817R04 | `OT2CEP20210817R04` | Center | TBD |
| Right (B07) | OT2CEP20200217B07 | `hidden-leaf` | Right bench | x=0.4, y=-1.0, z=-2.8 |

All P300 Single-Channel GEN2, running API level 2.19 (latest available at time of research was 2.27 — protocol API upgrade is a separate future task).

Start integration testing against `hidden-leaf` — it has known good offsets.

---

## 10. Success criteria for Step 1 (exit condition)

Step 1 is done when all of the following are true:

1. A BIMS operator can open the clone UI and see all 3 robots with live health status.
2. They can click into any online robot and see: instruments, modules, calibration status (read-only with staleness indicator), protocols list, runs list, settings, server logs.
3. They can upload a protocol file, analyze it, create a run, play/pause/stop/resume it, and watch the command log update in near-real-time (polling is fine).
4. They can abort a run cleanly.
5. They can read and display labware offsets; they can apply per-run labware offsets when starting a run.
6. The UI never crashes or hangs when a robot goes offline; it degrades gracefully.
7. Nothing in MongoDB changes as a result of any action in the clone UI.
8. `VERIFIED.md` exists at the repo root with a timestamped end-to-end walkthrough.

Only after those eight are true do we start Step 2 (wiring the clone into Opentron Control + wax/reagent filling flows).

---

*End of handoff doc.*
