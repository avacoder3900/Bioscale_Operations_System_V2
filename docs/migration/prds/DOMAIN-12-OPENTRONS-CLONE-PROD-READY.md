# DOMAIN-12 — Opentrons Clone: Production Readiness

**Branch:** `feature/opentrons-clone-ui`
**Depends on:** DOMAIN-01 (AUTH), DOMAIN-04 (EQUIPMENT — provides `OpentronsRobot` model)
**Predecessors:** Tasks 1–5 of `OPENTRONS-CLONE-PLAN.md` (all complete — 34/34 verify on `hidden-leaf` 2026-04-17). Operator gate, nav link, dark mode, confirm dialogs, sort: all committed in `e968e4d` (2026-04-20).
**Mission:** Close the last functional gaps so the BIMS `/opentrons-clone` section is a **drop-in replacement** for the Opentrons desktop App during run setup. After this domain ships, an operator can complete a full real-protocol run (custom params, verified labware placement, verified pipettes, calibrated labware offsets) without opening the Opentrons App.

---

## 1. Context

### 1.1 What exists today (post-Task 5)
- Live per-robot pages for health, instruments, modules, calibration status, protocols, runs, labware offsets, settings, data files, logs, client data, system time.
- Stateless HTTP client at `src/lib/server/opentrons/client.ts` (openapi-fetch, live-generated types).
- Pass-through form actions for protocol upload/delete, run create/play/pause/stop/resume/delete, labware offset apply, home, lights, identify.
- Operator-admin password gate (`opadmin`, 8h cookie), dark-mode theme scoped to `/opentrons-clone/**`, confirm dialogs on every destructive/state-changing action.

### 1.2 What does NOT exist today
This domain exists because these four capabilities are present in the Opentrons desktop App and missing in the clone:

1. **Runtime parameters** — protocols declare tunable parameters (`add_parameters(...)` in Python). The clone's "Create run" action sends `{ data: { protocolId } }` with no `runTimeParameterValues`, so every run uses the protocol's compiled-in defaults. The Opentrons App surfaces these as a form before run creation.
2. **Deck / labware setup checklist** — the App enumerates required labware from the protocol's analysis and requires the operator to tick "ready" for each slot before allowing run start.
3. **Pipette attach confirmation** — the App compares the protocol's required pipettes against `GET /instruments` and blocks run creation on mismatch.
4. **Labware Position Check (LPC)** — the App's interactive jog-and-save wizard that measures real per-labware offsets and attaches them to the run via `POST /runs/{id}/labware_offsets`.

### 1.3 Success definition
Definition of Done for the domain:
- An operator can open `/opentrons-clone/:robotId/protocols/:protocolId`, fill in custom parameters, confirm the deck, confirm the pipettes, run LPC, and create a run — all without leaving BIMS.
- The verify script `npx tsx scripts/verify-opentrons-clone.ts hidden-leaf.local` continues to pass 34/34.
- No new Mongoose models. No AuditLog entries for robot events. No MongoDB caching of robot state (guardrail from `OPENTRONS-CLONE-PLAN.md`).
- `PRODUCTION-READY.md` written at repo root summarizing the pass with a manual-walkthrough checklist.

### 1.4 Out of scope (explicit)
- Pipette offset / tip length / deck calibration wizards — still skipped per `OPENTRONS-CLONE-PLAN.md §2.4`. These are maintenance flows, not per-run. Keep Opentrons App for these.
- Wiring into `/manufacturing/opentron-control`, `/manufacturing/wax-filling`, `/manufacturing/reagent-filling`. That's Step 2.
- Protocol API upgrade (ours are API 2.19; newer protocols don't apply here).
- Module setup UI — no modules are attached to any of the 3 robots today. If/when one is, revisit.

---

## 2. Stories

Seven stories total. Four functional chunks (A, B, C) plus D split into four sub-stories (D1–D4) so each fits cleanly into one Claude context window.

| ID | Title | Est | Depends |
|----|-------|-----|---------|
| OT-A | Runtime parameters form | ~1h | — |
| OT-B | Deck / labware setup checklist | ~45m | OT-A |
| OT-C | Pipette attach confirmation | ~45m | — |
| OT-D1 | Maintenance-run session wrapper + typed helpers | ~2–4h | — |
| OT-D2 | LPC wizard UI (jog + step-size + progress) | ~3–5h | OT-D1 |
| OT-D3 | Persist LPC offsets + apply on run create | ~1–2h | OT-D2 |
| OT-D4 | End-to-end LPC walkthrough verification | ~1–2h | OT-D3, OT-A, OT-B, OT-C |

---

## 3. Story OT-A — Runtime Parameters Form

### 3.1 Goal
Read the latest completed analysis's `runTimeParameters`, render a field per parameter with the correct input type, and pass operator-chosen values on the `POST /runs` call so the run executes with custom values instead of defaults.

### 3.2 User story
As an operator, I can adjust every tunable parameter the protocol exposes (cartridge count, sample-well on/off, beads A on/off, CSV file selection, enum choices) before I hit Create Run — just like in the Opentrons App.

### 3.3 OpenAPI reference
- `GET /protocols/{protocolId}/analyses/{analysisId}` → `CompletedAnalysis.runTimeParameters: Array<NumberParameter | EnumParameter | BooleanParameter | CSVParameter>`
- `POST /runs` body: `{ data: { protocolId, runTimeParameterValues?: { [variableName]: int | float | bool | string }, runTimeParameterFiles?: { [variableName]: fileId } } }`

Parameter shapes (verified against live `openapi.json`):
- **`NumberParameter`** — `{ variableName, displayName, description?, type: "int" | "float", default, value, min?, max?, unit? }`. Prefer `.value` (current assigned, defaults to `.default` when unset) for pre-fill.
- **`EnumParameter`** — `{ variableName, displayName, type: "int" | "float" | "str", default, value, choices: EnumChoice[] }` where `EnumChoice: { displayName, value }`.
- **`BooleanParameter`** — `{ variableName, displayName, type: "bool", default, value }`.
- **`CSVParameter`** — `{ variableName, displayName, type: "csv_file", file: FileInfo | null }` where `FileInfo: { id, name }`. **Value routes to `runTimeParameterFiles`, NOT `runTimeParameterValues`** — two separate submission fields on `POST /runs`.

### 3.4 Files touched
| File | Change |
|------|--------|
| `src/routes/opentrons-clone/[robotId]/protocols/[protocolId]/+page.server.ts` | Load surfaces analysis already. **Additionally** load `dataFiles` (for CSV param dropdowns). Add `runtimeParameterValues` parsing to `createRun` action. |
| `src/routes/opentrons-clone/[robotId]/protocols/[protocolId]/+page.svelte` | Replace the bare Create-Run section with a parameters form gated by validation. |

**Server-side changes in `createRun` action:**
- Accept a `rtpValues` form field (JSON-encoded `{variableName: int | float | bool | string}` for number/bool/enum) and a `rtpFiles` form field (JSON-encoded `{variableName: fileId}` for CSV).
- Validate each value against the analysis's parameter type/range (server-side gate — UI can be bypassed).
- Send `{ data: { protocolId, runTimeParameterValues, runTimeParameterFiles } }` to `POST /runs`. Omit keys for which operator provided no override.

**Client-side:**
- Render a `<fieldset>` per parameter, with `<input type="number" min max step>`, `<select>` (enum), `<input type="checkbox">` (boolean), or `<select>` listing available data files (CSV).
- Values pre-filled from `.value` (fallback to `.default`).
- On submit, serialize non-CSV params to `rtpValues` hidden field as JSON, and CSV params to a separate `rtpFiles` hidden field as JSON.
- Keep existing confirm() dialog on the Create Run button.

### 3.5 Acceptance criteria
1. Protocol detail page lists every `runTimeParameter` with appropriate input type and default pre-filled.
2. Number params enforce `min`/`max` at the input level and on the server.
3. Boolean params render as a labeled checkbox.
4. Enum params render as a `<select>` with `displayName` visible and `value` as the option value.
5. CSV params render as a `<select>` of available data files from `GET /dataFiles` (options show `name`, value is `id`), plus a "none" option. Chosen file's `id` is submitted in the `rtpFiles` field on the form, routed server-side to `runTimeParameterFiles`.
6. Submitting the form calls `POST /runs` with both `runTimeParameterValues` (for number/bool/enum) and `runTimeParameterFiles` (for CSV) populated from operator input. Coder may include all fields or only non-default overrides — either is acceptable; the robot handles both.
7. The verify script's run-lifecycle assertions still pass (Rows 13–19, 18a–d).
8. A protocol with no `runTimeParameters` renders the Create Run button with no parameters section (no empty fieldset).
9. If the latest analysis is still pending, the parameters form is disabled with an informational message; the existing "waiting for analysis" UX is preserved.
10. Dark mode is respected (reuse existing `.ot-dark` scoping — do not introduce new color utilities that aren't already overridden in `+layout.svelte`).

### 3.6 Edge cases
- Analysis has errors → disable Create Run regardless of parameters.
- Analysis has `runTimeParameters` but they all lack defaults → server submits with empty `runTimeParameterValues` (legal — robot uses its own defaults).
- Operator enters a value outside `min`/`max` via URL-manipulated form → server-side validation rejects with `fail(400, { error: ... })`.
- Data files endpoint returns 502 → CSV select shows "robot unreachable" and Create Run is disabled.
- Protocol has a CSV parameter but operator hasn't uploaded any data files yet → CSV select shows only "none" option with a link to `/opentrons-clone/:robotId/data-files` for upload; Create Run stays enabled only if CSV param is optional (robot-side decides).
- Operator selects a CSV file that has since been deleted on the robot → server-side validation catches on POST; `fail(400, { error: "CSV file no longer exists; refresh and re-pick" })`.

### 3.7 Test plan
1. Upload a protocol **with** parameters (use `Full Deck Protocol Single Channel.py` — has `cartridges: int(1..20)`, `sample_well: bool`, `beads_a: bool`, etc.) and confirm every parameter appears.
2. Upload a protocol **without** parameters (write a 5-line minimal protocol) and confirm no parameters section appears.
3. Change `cartridges` to 5 and Create Run. Fetch `GET /runs/{id}/commands` and confirm the run's internal state reflects the override (`runTimeParameterValues.cartridges === 5`).
4. Re-run verify script — 34/34.

### 3.8 Done definition
- All 10 acceptance criteria pass.
- Test plan 4 steps pass (two upload paths + one command-inspection + verify-script green).
- Commit message: `feat(opentrons-clone): OT-A runtime parameters form` with Co-Authored-By line.
- `progress.txt` appended with one-line summary.
- `PROGRESS.md` updated with OT-A row.
- Pushed to `feature/opentrons-clone-ui`.

---

## 4. Story OT-B — Deck / Labware Setup Checklist

### 4.1 Goal
Before the operator can Create Run, they must confirm — per slot — that the required labware has been physically placed. The checklist is derived from the latest completed analysis.

### 4.2 User story
As an operator, when I'm about to start a real run, I see a list like "Slot 1 — opentrons_96_tiprack_300ul — [ ] ready" for every slot the protocol uses. I tick each after placing the labware. The Create Run button stays disabled until they're all ticked.

### 4.3 OpenAPI reference
- `CompletedAnalysis.labware: Array<{ id, loadName, displayName?, location: { slotName?, moduleId?, labwareId? } }>`
- `CompletedAnalysis.modules: Array<{ id, model, location: { slotName } }>` (not populated today, but schema-valid).
- `CompletedAnalysis.pipettes: Array<{ id, mount, pipetteName }>` — used by OT-C, not OT-B.

### 4.4 Files touched
| File | Change |
|------|--------|
| `src/routes/opentrons-clone/[robotId]/protocols/[protocolId]/+page.svelte` | Add a "Deck setup" section above the parameters form. Render a table of slot ↔ labware. Track ticked state in a local `$state` array. Pass `deckConfirmed` to the Create Run button's `disabled` condition. |

No server changes. State is purely client-side — confirmation is UX, not validation.

### 4.5 Acceptance criteria
1. Section renders one row per `analysis.labware[i]` where the location has a `slotName` (skip module-nested labware for now — modules are out of scope).
2. Each row shows: slot name, labware `displayName` (fallback to `loadName`), labware load name as a small mono subtitle.
3. Each row has a checkbox; the Create Run button is `disabled` until **every** checkbox is ticked.
4. A "Check all" button toggles all checkboxes on.
5. Uncheck resets Create Run back to disabled immediately.
6. If analysis has zero labware (edge case), no checklist section renders and Create Run is not gated by it.
7. Confirmed state is NOT persisted across page reloads — each visit is a fresh ticked set.

### 4.6 Test plan
1. Upload `Full Deck Protocol Single Channel.py` (lots of labware). Confirm every slot appears with a checkbox. Confirm Create Run disabled. Tick all. Confirm Create Run enabled.
2. Tick most but one. Confirm Create Run disabled again.
3. Use "Check all." Confirm Create Run enabled.
4. Reload. Confirm all checkboxes reset to unchecked.

### 4.7 Done definition
- 7 acceptance criteria pass.
- 4 test-plan steps pass.
- Verify script 34/34.
- Commit, progress.txt, PROGRESS.md, push.

---

## 5. Story OT-C — Pipette Attach Confirmation

### 5.1 Goal
Compare the protocol's required pipettes (from analysis) against the currently-attached pipettes (from `GET /instruments`). If they don't match, show a red mismatch card and block Create Run.

### 5.2 User story
As an operator, if the protocol wants a P300 on the left and I've left a P1000 mounted from a previous run, I see a red "Mismatch — swap the pipette" card and I literally cannot create the run. No more 30-second-into-run aborts.

### 5.3 OpenAPI reference
- `CompletedAnalysis.pipettes: Array<{ id, mount: "left" | "right", pipetteName: string }>` — e.g. `"p300_single_gen2"`.
- `GET /instruments` → `.data: Array<{ mount: "left" | "right", instrumentName?: string, instrumentModel?: string, ok?: boolean, ... }>`.

### 5.4 Comparison rule
For each `analysis.pipettes[i]`:
- Find the `/instruments` entry with the same `mount`.
- If not present → mismatch.
- If `instruments[mount].instrumentName !== analysis.pipettes[i].pipetteName` → mismatch.

Ignore mounts the protocol doesn't use (e.g. protocol only needs left; don't care what's on right).

### 5.5 Files touched
| File | Change |
|------|--------|
| `src/routes/opentrons-clone/[robotId]/protocols/[protocolId]/+page.server.ts` | Load `instruments` for the comparison (already loaded on the robot-detail page; duplicate the safeGet here — no shared service). |
| `src/routes/opentrons-clone/[robotId]/protocols/[protocolId]/+page.svelte` | Add a "Pipettes" section above the deck checklist. Render required vs attached per mount. Pass `pipettesOk` to the Create Run disabled condition. |

### 5.6 Acceptance criteria
1. Section shows one row per protocol-required mount: "Left: needs p300_single_gen2 — have p300_single_gen2 ✓" (green) or "Left: needs p300_single_gen2 — have p1000_single_gen2 ✗" (red).
2. If every required mount matches, overall state is "OK" (one-line green summary). If any mismatches, overall state is red and Create Run is disabled.
3. If the robot is offline (no `/instruments`), the section shows "Cannot verify — robot offline" and Create Run is disabled.
4. A protocol that requires zero pipettes (not realistic but schema-valid) treats this gate as a no-op.
5. UI respects dark mode.

### 5.7 Test plan
1. With `hidden-leaf` (p300 left, p20 right) and the `Full Deck Protocol Single Channel.py` (needs p300 left), confirm green OK.
2. Upload a protocol that requires a p1000 on left, confirm red mismatch and disabled button.
3. Power off the robot (or simulate by changing `isActive`), confirm "offline" message and disabled button.

### 5.8 Done definition
- 5 acceptance criteria pass, 3 test-plan steps pass, verify 34/34, commit + push + logs.

---

## 6. Story OT-D1 — Maintenance-Run Session Wrapper

### 6.1 Goal
Build the server-side infrastructure to create, drive, and end a **maintenance run** on the robot for the purpose of jogging a pipette to measure labware offsets. Maintenance runs are the OT-2's mechanism for ad-hoc operator-driven motion without polluting the "runs" history; LPC uses them under the hood.

### 6.2 OpenAPI reference
- `POST /maintenance_runs` — creates a session, returns `{ data: { id, status, ... } }`
- `GET /maintenance_runs/{id}` — current state
- `DELETE /maintenance_runs/{id}` — tear down
- `POST /maintenance_runs/{id}/commands` — enqueue a command; body `{ data: Command, waitUntilComplete?: boolean, timeout?: number }`

Commands needed for LPC (all `*Create` schemas confirmed present in live `openapi.json`):
- `loadPipette` — loads pipette into the maintenance session
- `loadLabware` — loads a labware definition into a specific slot in the session (MUST run before `pickUpTip` / `moveToWell` for each labware the operator will jog to)
- `pickUpTip` — pick up tip from a loaded tiprack
- `moveToWell` — move pipette over a well in loaded labware; supports `wellLocation: { origin: "top"|"bottom"|"center", offset: { x, y, z } }`
- `moveRelative` — single jog; `params: { pipetteId, axis: "x"|"y"|"z", distance }` (confirmed present)
- `savePosition` — capture robot's current position; returns `{ position: { x, y, z } }`
- `dropTip` — drop tip back into a tiprack well
- `home` — home axes; `params: { axes: ["x"|"y"|"z"|"leftZ"|"rightZ"|"leftPlunger"|"rightPlunger"] }`

Exact `Params` sub-schemas live in `openapi.json`; helpers MUST use openapi-fetch's `.POST(path, { body })` with the discriminated-union payload so `tsc` catches schema drift. Writing narrower typed wrappers (e.g. `loadPipette(mount, name): Promise<Result>`) is acceptable and recommended for readability — just make sure the underlying fetch call is typed.

### 6.3 Files touched
| File | Change |
|------|--------|
| `src/lib/server/opentrons/maintenance.ts` | **NEW.** Typed helpers: `createMaintenanceRun`, `endMaintenanceRun`, `enqueueCommand`, `loadPipette`, `pickUpTip`, `moveToWell`, `jog`, `savePosition`, `dropTip`, `homeAxes`. Each wraps the raw HTTP call with typed params + error handling. |
| `src/routes/api/opentrons-clone/robots/[robotId]/maintenance/+server.ts` | **NEW.** `POST` creates session (returns id); `DELETE` ends the session. |
| `src/routes/api/opentrons-clone/robots/[robotId]/maintenance/[mrId]/command/+server.ts` | **NEW.** `POST` enqueues a command on the given maintenance run. Validates `commandType` against an allowlist (the 7 listed above). Returns the robot's command response. |

Permission guard: every endpoint requires `manufacturing:write` and a valid BIMS session.

### 6.4 Acceptance criteria
1. All helpers are strongly typed against `openapi-types.ts` — no raw `any` on command payloads.
2. Commands are enqueued with `waitUntilComplete: true` and a sensible timeout (default 30s, overridable) so the server waits for the robot to finish the motion before returning.
3. On command failure (robot errored, command rejected), helper throws a descriptive error including the robot's error detail.
4. `endMaintenanceRun` is idempotent — safe to call twice, safe to call on an already-dead session.
5. API endpoints return the robot's response body verbatim (no re-shaping) so the client can inspect command state.
6. Server-side orphan cleanup: a helper `endOrphanMaintenanceRuns(robot)` iterates `GET /maintenance_runs` and DELETEs any found. Called by `POST /.../maintenance` before creating a new one. (Browser-side lifecycle lives in D2 AC #13, not here.)
7. No `AuditLog.create` for any maintenance-run activity (per guardrail — it's ephemeral mechanical state, not business state).

### 6.5 Test plan
1. Unit-like: `npx tsx` one-liner that creates a maintenance run, enqueues `loadPipette` for the real attached pipette, then `endMaintenanceRun`. Confirms the session starts and terminates cleanly.
2. Negative: enqueue an invalid command type → server returns 400 before hitting the robot.
3. Negative: try to enqueue after the session is ended → robot returns 4xx, helper surfaces it cleanly.
4. Verify script: 34/34 still passes (maintenance-run infra is additive — nothing existing changes).

### 6.6 Done definition
- 7 acceptance criteria met.
- Test plan 4 steps pass.
- Commit, progress.txt, PROGRESS.md, push.

---

## 7. Story OT-D2 — LPC Wizard UI

### 7.1 Goal
An interactive page that walks the operator through LPC one labware at a time. Presents a jog pad, a step-size selector, and a "save and continue" button. Stores offsets in component state as the operator goes, then hands them off at the end.

### 7.2 User story
As an operator, I click "Run Labware Position Check" from the protocol detail page. I'm prompted to confirm the attached pipette, load a tip, then for each labware I jog the pipette to the exact center of the reference well using +/- X/Y/Z buttons at 1mm or 0.1mm steps, and click "Save and Next." At the end, I see a summary of all offsets and a "Apply and Create Run" button that hands off to OT-D3.

### 7.3 Files touched
| File | Change |
|------|--------|
| `src/routes/opentrons-clone/[robotId]/protocols/[protocolId]/lpc/+page.server.ts` | **NEW.** Load the protocol, its analysis (for pipette + labware requirements), instruments, and available tip racks. Returns initial wizard state. |
| `src/routes/opentrons-clone/[robotId]/protocols/[protocolId]/lpc/+page.svelte` | **NEW.** The wizard itself — a state machine: `attach-tip` → `labware-1-of-N` → ... → `review` → handoff. Jog pad is a 3×3 grid of buttons (`Y+`, `Y-`, `X+`, `X-`, `Z+`, `Z-`, `home`, step-size toggle). |

### 7.4 Wizard state machine
```
start
 → init: createMaintenanceRun, loadPipette, loadLabware(each labware the protocol needs)
 → attach-tip: pickUpTip on operator-selected tip rack                    [server: pickUpTip]
 → measure-labware-i of N (loop):
     moveToWell(labware_i, wellA1, wellLocation.origin=top, offset=0,0,0) [server: moveToWell]
     savePosition (BEFORE any jog) → `initialPos_i`                        [server: savePosition]
     operator jogs with arrow buttons                                     [server: moveRelative per click]
     operator clicks "Save" → savePosition → `finalPos_i`                 [server: savePosition]
     client computes offset: `vector_i = finalPos_i - initialPos_i`       (robot provides nominal via initialPos; no need to compute from labware defs)
     client stores { definitionUri: labware_i.definitionUri, location: { slotName: labware_i.location.slotName }, vector: vector_i } in state
     before advancing: home z-axis, moveToWell of next labware             [server: home + moveToWell]
 → drop-tip back to the tiprack                                           [server: dropTip]
 → end maintenance run                                                    [server: DELETE /maintenance_runs/{id}]
 → review (show table of collected offsets)
 → handoff "Create run with these offsets"                                [navigate to protocol page with offsets]
```

### 7.5 Acceptance criteria
1. On page load, wizard auto-creates a maintenance run and displays the selected pipette (from analysis).
2. Operator picks a tip rack from a dropdown of loaded tip racks on the robot (derived from analysis.labware filtered by loadName starting with `opentrons_*_tiprack_*`).
3. "Attach tip" runs `pickUpTip`, confirms with UI feedback.
4. Jog pad: 6 direction buttons (+X, -X, +Y, -Y, +Z, -Z) + step-size selector (1mm or 0.1mm). Each press enqueues a `moveRelative` and UI waits for completion before enabling the next click.
5. A "Home Z (safe lift)" button lifts the pipette z-axis to max travel at any time. Used both routinely between labware (before moveToWell of the next one) and as an operator-triggered abort. If pressed during a labware measurement, the in-progress (uncommitted) position is discarded and the operator must re-approach.
6. "Save and continue" on each labware calls `savePosition`, diffs against expected, stores the offset in component state, and moves to the next labware.
7. Before moving to the next labware, the wizard auto-moves the pipette above the next slot (safe Z) so operators don't accidentally crash.
8. Review screen shows a table of all collected offsets per labware.
9. "Back" button on any step re-measures that labware (does NOT lose previously-collected offsets; it replaces just that one).
10. "Cancel" button at any time calls `endMaintenanceRun` and redirects back to the protocol page. Confirmation dialog first ("Discard LPC in progress?").
11. Handoff to OT-D3: offsets are stored in `sessionStorage.setItem('ot_lpc_offsets:<protocolId>', JSON.stringify(offsets))` and operator is navigated to the protocol detail page with `?lpc=applied`. Protocol page reads sessionStorage on load and clears the key after reading (one-time consumption). Rationale: avoids URL-length limits (5+ labware × ~150 chars/offset can exceed browser URL caps).
12. Dark mode is respected; jog buttons are large touch-target-friendly (>= 44px square).
13. Beforeunload handler calls `endMaintenanceRun` if the wizard is abandoned via tab close.

### 7.6 Safety behaviors
- On page error or unhandled exception, call `endMaintenanceRun` and surface the error.
- Timeouts on every command (default 30s) — if a `moveToWell` hangs beyond that, surface "robot not responding, LPC aborted" and tear down.
- Jog distance hard-capped: 1mm step max (no 10mm "accidentally smash the deck" option).

### 7.7 Test plan
1. Navigate to an uploaded protocol → click "Run LPC" → wizard loads.
2. Select a tip rack, click Attach tip, confirm the robot actually picks up a tip (manual verify at R04 by operator).
3. Use jog buttons (+X, -X, +Y, -Y, +Z, -Z) at both step sizes. Confirm motion direction matches button label.
4. Save a labware position, confirm wizard advances.
5. Go back, confirm re-measurement replaces just that offset.
6. Complete all labware, reach review screen, confirm offsets table is sane.
7. Cancel mid-wizard, confirm maintenance run is torn down (check `GET /maintenance_runs` — empty after).
8. Close the browser tab mid-wizard, confirm maintenance run is torn down within 5s.

### 7.8 Done definition
- 13 acceptance criteria met.
- Test plan 8 steps pass (steps 2–6 require a human at R04; coder-agent should at minimum unit-test the command sequence against the robot).
- Verify script 34/34.
- Commit, progress.txt, PROGRESS.md, push.

---

## 8. Story OT-D3 — Persist Offsets + Apply On Run Create

### 8.1 Goal
When the operator finishes the LPC wizard (OT-D2) and chooses "Apply and Create Run," the collected offsets are sent along with the run-creation POST so every labware in the run is corrected.

### 8.2 OpenAPI reference (verified)
- `POST /runs` body directly supports `labwareOffsets: Array<LegacyLabwareOffsetCreate | LabwareOffsetCreate>`:
  - `LegacyLabwareOffsetCreate`: `{ definitionUri, location: { slotName, moduleModel?, definitionUri? }, vector: { x, y, z } }`
  - `LabwareOffsetCreate`: `{ definitionUri, locationSequence, vector }` — newer; for adapter/module stacks.
- `POST /runs/{runId}/labware_offsets` also exists (the existing power-user surface on the run detail page uses this).

### 8.3 Implementation approach
**Option A (chosen):** pass offsets in the `POST /runs` create body directly. Single atomic call — no partial-run rollback risk. Use `LegacyLabwareOffsetCreate` shape since LPC produces simple slotName-based offsets.

### 8.4 Files touched
| File | Change |
|------|--------|
| `src/routes/opentrons-clone/[robotId]/protocols/[protocolId]/+page.server.ts` | `createRun` action: accept an optional `offsets` form field (JSON → `LegacyLabwareOffsetCreate[]`). Include in the POST body alongside `rtpValues` / `rtpFiles` from OT-A. |
| `src/routes/opentrons-clone/[robotId]/protocols/[protocolId]/+page.svelte` | On load, if `?lpc=applied` is present, read `sessionStorage.getItem('ot_lpc_offsets:<protocolId>')`, parse, clear the key (one-time), and show a "N offsets from LPC will be applied" banner plus a "clear" link. Pass the JSON through to the createRun form as a hidden `offsets` field. |

### 8.5 Acceptance criteria
1. When `?lpc=applied` is present AND the corresponding sessionStorage key exists, the protocol detail page displays a banner listing the number of offsets and a "clear" link. Clicking clear removes the banner and unsets the hidden `offsets` field.
2. The createRun action passes offsets to the robot. On success, the new run's `GET /runs/{id}` shows the offsets in `labwareOffsets` array.
3. If the robot rejects the offsets (schema mismatch, unknown definitionUri), the single atomic POST fails — no run is created, no rollback needed. `createRun` surfaces the robot's error detail via `fail()`.
4. An operator who skips LPC (no `?lpc=applied` and no sessionStorage key) still gets the normal createRun flow from OT-A.

### 8.6 Test plan
1. Complete a mock LPC (or hand-stuff sessionStorage with a valid offsets array) and confirm the offsets land on the newly created run: fetch `GET /runs/{id}` and assert `labwareOffsets.length === N`.
2. Intentionally send a bad offset (unknown labware URI) and confirm the single atomic POST fails without creating a run: no new entry in `GET /runs` after the attempt.

### 8.7 Done definition
- 4 acceptance criteria met, 2 test-plan steps pass, verify 34/34, commit + push + logs.

---

## 9. Story OT-D4 — End-to-End LPC Verification + PRODUCTION-READY.md

### 9.1 Goal
After OT-A through OT-D3 are shipped, verify the entire chain works end-to-end and document it.

### 9.2 Deliverables
- Extend `scripts/verify-opentrons-clone.ts` with a new HTTP-level section: "Production-readiness smoke test" that:
  - Row 36: Maintenance run lifecycle — POST/GET/DELETE `/maintenance_runs` round-trip
  - Row 37: Maintenance-run command validity — enqueue a `home` command (no physical consumables), confirm 2xx
  - Row 38: Offsets atomic — POST /runs with a bogus labwareOffset → confirm 4xx (no orphan run created)
  - Row 39: Offsets happy path — POST /runs with a valid single no-op offset → confirm 2xx AND `run.labwareOffsets.length === 1` AND clean up (DELETE /runs/{id})
- UI-level checks for OT-A / OT-B / OT-C are NOT in the verify script (it's HTTP-only). They are verified by code inspection + live browser walkthrough documented in PRODUCTION-READY.md. Rows 36–39 are the script additions; target new total is 38/38.
- Write `PRODUCTION-READY.md` at repo root with:
  - Timestamp, robot tested against
  - Results table (Rows 36–40)
  - Manual-walkthrough checklist for the operator (10-line procedure)
  - Known limitations still remaining (e.g. "pipette offset calibration still requires Opentrons App")
  - "How to run" instructions for future debugging

### 9.3 Acceptance criteria
1. Verify script's new section passes on `hidden-leaf`.
2. `PRODUCTION-READY.md` is correct, dated, honest about what was and was not exercised.
3. `PROGRESS.md` final update: all 7 stories (OT-A through OT-D4) marked done, Opentrons Clone Step 1.5 complete.
4. Final commit summary PR'd (as a description, not an actual PR — still feature branch only).

### 9.4 Done definition
- All previous stories passing in one re-run of the verify script.
- `PRODUCTION-READY.md` exists, `PROGRESS.md` updated, final commit made, pushed.

---

## 10. Cross-cutting concerns

### 10.1 Guardrails (inherit from OPENTRONS-CLONE-PLAN.md)
- No new Mongoose models.
- No `AuditLog.create` for robot actions.
- No MongoDB caching of robot state (reading `OpentronsRobot` for IP lookup is fine — that's the one exception).
- No touching `src/routes/manufacturing/wax-filling/`, `reagent-filling/`, or `opentron-control/`.
- No touching `src/routes/opentrons/` (master scaffold).

### 10.2 Patterns to follow (from CLAUDE.md + progress.txt)
- Every `+page.server.ts` load: `requirePermission(locals.user, 'manufacturing:read')`.
- Every mutation: `requirePermission(locals.user, 'manufacturing:write')`.
- `await connectDB()` before any Mongoose call.
- `.lean()` on all queries.
- `JSON.parse(JSON.stringify(...))` on returned data.
- Confirm dialogs on destructive/state-changing buttons (pattern already established in today's commit).
- Dark mode: reuse `.ot-dark` scoped overrides; don't introduce new Tailwind utility classes that aren't already re-colored in `+layout.svelte`.

### 10.3 Forbidden shortcuts
- No raw `fetch` outside of the `createRobotClient`/`robotBaseUrl` helper pattern (exception: existing multipart upload and raw-body endpoints already use raw fetch; same pattern allowed for new ones that need it).
- No `any` in public function signatures. Use `openapi-types.ts`.

### 10.4 Verification between stories
After EVERY story commit:
```bash
npx tsx scripts/verify-opentrons-clone.ts hidden-leaf.local
```
Must return 34/34 (38/38 after OT-D4). If it drops below 34, stop and fix before proceeding to the next story.

### 10.5 Rollback plan
- Every story is its own commit. If story OT-DN breaks something, `git revert` that one commit.
- Operator-admin password gate remains functional regardless — a half-done pass still has the gate.

---

## 11. Known risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `moveRelative` command rejected by API 8.7.0 | Low (spec has `MoveRelativeCreate`) | If it errors at runtime despite spec presence, emulate via `savePosition` + `moveToCoordinates` at the saved coords + delta. |
| Maintenance run rejects commands because tip rack isn't "loaded" in the session first | High | D1 must include a `loadLabware` helper that loads the tip rack into the maintenance session before `pickUpTip`. |
| Operator abandons LPC without tear-down | High | beforeunload handler (D2 AC #13) + server-side cleanup on next LPC start (end any orphan maintenance runs first). |
| Offsets collected in mm don't land correctly because coordinate system is swapped | Medium | D2 must wait for manual sign-off from a human at the robot before marking OT-D2 done. Coder agent surfaces this as "awaiting human confirmation" and stops. |
| Runtime parameter validation rejects server-valid inputs due to float-vs-int edge cases | Low | Server-side validation mirrors the OpenAPI schema exactly (use `type === "int" ? parseInt : parseFloat`). |

---

## 12. Definition of Done for the Domain

All of:
1. OT-A, OT-B, OT-C, OT-D1, OT-D2, OT-D3, OT-D4 stories show `done` in `prd.json`.
2. `PRODUCTION-READY.md` exists at repo root.
3. Verify script returns ≥ 38/38 against `hidden-leaf` (34 original + 4 new from §9.2).
4. Branch is pushed; no unpushed commits.
5. `PROGRESS.md` lists the Step 1.5 section with all stories marked done.
6. `progress.txt` has an appended block for this domain.
