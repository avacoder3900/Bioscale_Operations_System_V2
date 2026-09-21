# VALIDATION-07: Thermocouple File Ingestion — the file becomes the record

**Author:** Alejandro Valdez (via Claude Code)
**Date:** 2026-09-04
**Status:** Draft
**Priority:** P1 — a confirmed data-integrity incident (SPU 257 recorded against SPU 247's file) traced to the current in-browser staging model
**Target branch:** `feat/thermo-file-ingestion` (branch from **`master`**)
**Related:** VALIDATION-05 (SPU validation runs — introduced the run-side thermo step and the "upload ≠ pass" split), R2-WORKER-UPLOAD-PROXY (the storage path this reuses)

> All file paths and line numbers below were verified against **`origin/master`** on 2026-09-04 from the `.worktrees/thermo-stale` worktree.

---

## 1. Problem Statement

The thermocouple validation record is built from numbers that exist only in browser memory. The operator's spreadsheet is never sent anywhere and never stored. This produced a real incident on 2026-09-03.

**The incident.** Session `THERMO-000031`, recorded against **SPU 257**, stores 377 readings, min 40.90 °C, max 44.00 °C, avg 43.303, sd 0.775, mode 43.9, `startedAt 2026-09-02T18:44:23Z`. Parsing `247 temp data.xlsx` with the production parser reproduces those figures exactly. SPU 257's own file (`257 temp data.xlsx`, recorded 2026-09-04 14:01–14:12) is a different measurement entirely: 635 readings, 37.55–44.40 °C, avg 43.594, mode 44.3.

`THERMO-000030` (SPU 247, `20:34:06Z`) and `THERMO-000031` (SPU 257, `20:34:38Z`) were written **32 seconds apart with an identical payload**. SPU 257's `validation.thermocouple.status` currently reads `passed`, signed off on another unit's data.

**Why it was possible.** In `src/routes/validation/thermocouple/+page.svelte` the parsed readings live in Svelte component state, not in form fields:

```js
let readings = $state<Array<{ timestamp: number; temperature: number }>>([]);
let readingsJson = $state('');
```

`use:enhance` calls `update()`, which resets the `<form>` element but leaves that state intact. After a successful save the statistics, chart and Pass/Fail buttons stayed on screen fully populated; changing only the SPU dropdown and pressing Pass re-submitted the previous file against the newly selected SPU.

`fix/thermo-stale-upload-state` (commit `855c6d33`) closes that specific drift by clearing the staged upload after a save and resetting `ThermoFileUpload` on every new file. **That patch removes the symptom, not the class of defect.** As long as "the file the operator sees" and "the data being submitted" are two separate things, they can disagree.

**What else is missing.** There is no artifact to audit against. Proving the 257 mix-up required parsing the operator's local spreadsheets and matching statistics — the record itself carries no filename, no hash, no stored file. `spu.validation.thermocouple.rawData.fileName` holds a filename string, but it is operator-supplied metadata, not evidence.

## 2. Goals

1. **The uploaded file is the record.** The actual `.xlsx`/`.csv` is transmitted, stored, and hashed; the session references it.
2. **One atomic request.** SPU identity and file bytes arrive together, so they cannot be recombined client-side.
3. **Parse on the server**, from the stored bytes, with a recorded parser version — so any session can be re-derived from its source.
4. **Delete the staged-readings state.** No `readings`/`readingsJson` in component state, no hidden JSON field.
5. **Upload and verdict become distinct persisted steps** — completing the split VALIDATION-05 §7.3 specified but only half-implemented.
6. **Preserve timestamp semantics** across the browser→server parse move (§7.5 — this is the sharpest migration hazard).

## 3. Non-Goals

- **No change to the statistics math.** `computeChannelStats` (`src/lib/server/thermocouple-stats.ts`) and `parseThermoRows` column-detection logic are moved, not rewritten.
- **No acceptance-range decision.** `STANDARD_THERMO_CRITERIA` stays `null`; operator verdict remains the record. That is a quality-policy call (OQ-3), not this build.
- **No backfill of historical sessions.** Sessions recorded before this change have no source file and never will. They must be displayed as such, not implied to have one.
- **No remediation of the 257 record.** That is a human correction against real data (OQ-4).
- No change to run orchestration, magnetometer, or optical confirmation.

---

## 4. Current State (`origin/master`, verified 2026-09-04)

### 4.1 The client parses and stages

`src/lib/components/validation/thermocouple/ThermoFileUpload.svelte:29-56` — `FileReader` → `XLSX.read(data, { type: 'array' })` → `parseThermoRows(rows)` → hands `readings` + `JSON.stringify(readings)` up via `onparsed`. The file object itself is discarded.

`src/routes/validation/thermocouple/+page.svelte` — stores that JSON in a hidden input:

```html
<input type="hidden" name="readings" value={readingsJson} />
<input type="hidden" name="fileName" value={fileName} />
```

Statistics are recomputed **a second time** client-side in a `$derived.by` for the preview, duplicating the server's `computeChannelStats` logic (mode bucketing is reimplemented, with a comment noting it "matches server computeMode").

Everything the operator needs — stats grid, chart, and both verdict buttons — sits inside a single guard:

```svelte
{#if hasReadings && stats}
```

so any failure to stage readings removes the verdict controls with no explanation.

### 4.2 The server trusts the JSON

`src/routes/validation/thermocouple/+page.server.ts:61-108` — the `upload` action reads `spuId`, `readings` (JSON), `fileName` (a string), `outcome`, and calls `processThermoUpload`. It never sees a file.

`src/lib/server/validation/thermo-upload.ts:86-89` carries the only defence — a plausibility guard rejecting parses that look like Excel date serials or row indexes:

```js
const implausible = temps.filter(t => !isFinite(t) || t < -100 || t > 1000).length;
if (implausible / temps.length > 0.2) { return { error: ... }; }
```

This catches a *mis-parsed* file. It cannot catch a *correctly parsed file belonging to a different SPU* — the 257 case.

### 4.3 Storage exists but is unused here

`src/lib/server/services/r2.ts` exports `uploadViaWorker(buffer, key, contentType)`, `downloadViaWorker`, `deleteViaWorker`, `getR2Url` (worker-proxy path, per R2-WORKER-UPLOAD-PROXY). Widely used by the CV pipeline (`src/routes/api/cv/capture/+server.ts`).

`src/routes/spu/work-instruction/+page.server.ts:80-135` is the closest prior art for what this PRD wants — a real file arrives, is turned into a `Buffer`, and is parsed **on the server** with a recorded `PARSER_VERSION`:

```js
const form = await request.formData();
const buffer = Buffer.from(await file.arrayBuffer());
parsed = await parseSpuWorkInstruction({ ... });
```

A competing, unrelated mechanism also exists: `src/routes/spu/[spuId]/+page.server.ts:380-422` pushes a thermocouple CSV **inline** onto `spu.attachments[]` (`kind: 'thermocouple_csv'`, full `content` string, 2 MB cap). It is not linked to any `ValidationSession` and is not part of the validation flow.

### 4.4 Schema

`src/lib/server/db/models/validation-session.ts` — `_id` nanoid, `results[]` sub-documents carry `rawData` / `processedData` as `Schema.Types.Mixed`, so **new fields are additive with no migration**. Indexes exist on `{spuId, startedAt}` and `{type, startedAt}`.

Note an existing inconsistency: top-level `overallPassed` is declared (line 21) but `processThermoUpload` never sets it — only `evaluateThermoSession` does. Every thermo session written through the upload path therefore reads `overallPassed: null` while `results[0].passed` is `true`. Worth fixing here (S5).

---

## 5. Design

### 5.1 Shape: two persisted steps

Replace the single "parse in browser → judge → save" action with:

**Step 1 — Ingest.** `POST` multipart `{ spuId, file }`. Server stores the bytes, parses them, computes stats, creates a `ValidationSession` with `status: 'in_progress'` and `results[0].passed: null`, then redirects to the session page.

**Step 2 — Verdict.** On the session page the operator reviews **server-rendered** stats and chart and records Pass or Fail against that session `_id`.

The verdict now references a session that already exists and whose source file is already stored. There is no window in which a verdict can be attached to data other than what is on screen, because the data on screen was loaded from the persisted record — not from browser memory.

This also delivers the "upload ≠ pass" semantics VALIDATION-05 §7.3 specified.

### 5.2 Storage

R2 via `uploadViaWorker`, key `validation/thermo/<sessionId>/<sanitized-filename>`. Persist on the session:

```js
sourceFile: {
  key, url, fileName, mimeType, size,
  sha256,              // hex digest of the uploaded bytes
  parserVersion,       // THERMO_PARSER_VERSION
  parsedRowCount,      // readings.length
  columnsNote,         // "temperature from column B+C, time from column A"
  uploadedAt, uploadedBy: { _id, username }
}
```

`sha256` gives cheap duplicate detection (§5.4) and lets a later re-parse prove it read the same bytes.

### 5.3 Parser relocation

Move `src/lib/components/validation/thermocouple/parse-thermo.ts` → `src/lib/server/validation/parse-thermo.ts` and add `export const THERMO_PARSER_VERSION`. The module is pure TypeScript with no DOM dependency and already runs unmodified under Node (verified against the four real operator files). `xlsx` is already a project dependency.

**One parser, server-side only.** The duplicate client-side statistics block in `+page.svelte` is deleted with the staged state.

### 5.4 Duplicate guard

On ingest, look up recent sessions carrying the same `sourceFile.sha256`. On a hit, **warn and require confirmation** — do not block:

> This exact file was already uploaded for **BT-M01-0000-0247** on Sep 3 as THERMO-000030. Upload it for BT-M01-0000-0257 anyway?

This is the guard that would have stopped the 257 incident at the moment it happened. It is a warning rather than a block because a legitimate re-upload after a mistaken verdict is a real workflow (see the three `previous[]` entries on SPU 212 in `VALRUN-000001`).

### 5.5 Timestamp semantics — the migration hazard

`parseDateLike` resolves the logger's `"14:01:39 2026-09-04"` to `"2026-09-04T14:01:39"` and calls `Date.parse`. Per spec, a date-time string with **no offset designator is interpreted in local time**. Verified:

| Runtime | `Date.parse('2026-09-04T14:01:39')` |
|---|---|
| Browser, America/Chicago | `2026-09-04T19:01:39.000Z` |
| Vercel function, UTC | `2026-09-04T14:01:39.000Z` |

Every stored session today was parsed **in the operator's browser**, so its timestamps are Central-interpreted. Confirmed against real data: `249 temp data.xlsx` starts at `10:56:58` in the file and its session records `startedAt 2026-09-04T15:56:58Z` — exactly +5.

Moving the parse to Vercel without handling this shifts every new session 5 hours (6 in winter) relative to every existing one. `startedAt` and `durationMs` feed the run board and history views, so the corruption would be quiet.

**Decision:** the client sends its IANA zone with the upload (`Intl.DateTimeFormat().resolvedOptions().timeZone`) and the server resolves naive timestamps in that zone. Store the zone on `sourceFile.sourceTimeZone` so the interpretation is auditable. Absolute forms (epoch, ISO-with-offset) are unaffected.

### 5.6 Failure handling

Ingest either fully succeeds or writes nothing. If R2 is unreachable the ingest **fails with a clear message** rather than recording a session with no artifact — the artifact is the point of this PRD (see Risk R2 for the counter-argument, which needs a decision).

---

## 6. UX Spec

**`/validation/thermocouple`** — reduces to: SPU select, file drop, **Upload**. No preview stats, no chart, no verdict buttons. On success, redirect to the session page. The dropzone shows filename and size only — never a parsed reading count, since the client no longer parses.

**`/validation/thermocouple/[sessionId]`** — already server-rendered from the persisted session (`+page.server.ts:26-56`) and already renders `ThermocoupleResult` + chart. Add:
- a **Source file** block: filename, size, SHA-256 (first 12 chars), parser version, source zone, and a download link;
- when `results[0].passed === null`, the **Pass / Fail** controls with the §5.1 explanatory copy;
- for legacy sessions with no `sourceFile`, an explicit "No source file retained (recorded before VALIDATION-07)" note.

Styling stays on the existing tron tokens (`var(--color-tron-*)`); reuse `ThermocoupleChart` and `ThermocoupleResult` unchanged.

**Run board** (`/validation/runs/[runId]`) — the inline `ThermoFileUpload` posts the file instead of readings; the cell keeps its `uploaded` → verdict states, which already match this model.

---

## 7. Stories

| ID | Story | AC |
|---|---|---|
| **VALIDATION-07-S1** | Move `parse-thermo.ts` to `$lib/server/validation/`, add `THERMO_PARSER_VERSION`, add unit tests over the four real operator files in `New SPU thermo data/` | Tests assert 257 → 635 readings / 37.55 / 44.40 and 247 → 377 / 40.90 / 44.00; `npm run check` clean in touched files |
| **VALIDATION-07-S2** | Timezone-aware `parseDateLike` (accepts an IANA zone; absolute forms unchanged) | Given `"14:01:39 2026-09-04"` + `America/Chicago`, returns `2026-09-04T19:01:39Z` under `TZ=UTC` — proving parity with the historical browser-parsed record |
| **VALIDATION-07-S3** | `ingestThermoFile()` server module: buffer → sha256 → parse → stats → R2 → `ValidationSession` (`in_progress`, `passed: null`) + `sourceFile` + AuditLog | Uploading 257's file creates a session whose stats match S1's fixture and whose `sourceFile.key` downloads back byte-identical (sha256 match) |
| **VALIDATION-07-S4** | Rewrite `/validation/thermocouple` to post the file; delete `readings`/`readingsJson` state and the duplicate client stats block | No `readings` hidden input exists; grep for `readingsJson` returns nothing outside history |
| **VALIDATION-07-S5** | Verdict action on the session page; sets `results[].passed`, session `status`, **and top-level `overallPassed`** (§4.4), plus the `spu.validation.thermocouple` rollup + AuditLog | A session can be passed or failed only from its own page; `overallPassed` is non-null on every new session |
| **VALIDATION-07-S6** | SHA-256 duplicate warning with explicit confirmation | Re-uploading 247's file for a different SPU shows the warning naming the earlier SPU and session, and only proceeds on confirm |
| **VALIDATION-07-S7** | Run board posts the file through the same `ingestThermoFile()` | Run cell reaches `uploaded` with a `sourceFile`; no second parser path exists |
| **VALIDATION-07-S8** | Source-file block on the session page + legacy "no source file retained" state | A pre-VALIDATION-07 session renders the legacy note and no dead download link |

S1–S5 are the shippable core; S6–S8 can follow.

---

## 8. Open Questions / Risks

### Risks with the new approach

**R1 — Two steps where there was one.** Operators currently upload and judge on one screen; this splits it across a redirect. Mitigation: redirect straight into the session page so it reads as one flow. Still a real change to a floor workflow that runs many times per batch — worth watching before rolling to production.

**R2 — R2 becomes a hard dependency on recording validation data.** Today the flow needs no external service; afterwards, a worker or R2 outage blocks validation entirely. The alternative (record the session, store the file best-effort, flag it for retry) keeps the floor moving but reintroduces sessions with no artifact — the exact hole this PRD closes. **This is a genuine trade-off and I do not think it is mine to pick (OQ-1).**

**R3 — Request size and function limits.** Vercel caps request bodies at 4.5 MB. Real files are 15–27 KB, but `218 data stays at 40C.xlsx` is 257 KB and a long soak could grow. Set an explicit 10 MB client-side guard with a clear message; note that a file large enough to matter would also blow the 4.5 MB platform limit first, so the guard must be below it.

**R4 — Timestamp shift (§5.5).** The highest-risk item. If the zone is not threaded through, every new session silently shifts 5–6 hours against history. S2 exists specifically to prove parity under `TZ=UTC`. A browser that reports an unexpected zone (VPN, misconfigured kiosk) would also skew — consider recording both the zone and the raw naive string.

**R5 — Parser version drift.** Storing `parserVersion` invites re-parsing old files with a newer parser. If that ever changes a stat on a session an operator already passed, the verdict no longer matches the displayed data. Recommend: re-parse is **read-only/diagnostic**, never a silent overwrite; a changed result becomes a new session.

**R6 — Two thermocouple file mechanisms remain.** `spu.attachments[]` (§4.3) still accepts inline CSVs unconnected to any session. Leaving both invites the wrong one being used. Retiring it is out of scope here but should be tracked.

**R7 — Storage growth and retention.** Every validation now writes a permanent object. Volume is trivial (tens of KB × hundreds of runs), but there is no retention policy and no deletion path when a session is voided.

**R8 — The fix already shipped may mask urgency.** `855c6d33` makes the current flow safe enough day-to-day, which historically is how a P1 rework becomes a P3 that never lands. Worth an explicit decision to schedule or defer rather than letting it drift.

### Questions that need your decision

- **OQ-1 (blocks S3):** R2 unreachable — fail the upload, or record the session and retry the artifact later? See R2.
- **OQ-2:** Should the duplicate guard (S6) ever hard-block, or always warn-and-confirm?
- **OQ-3:** `STANDARD_THERMO_CRITERIA` is still `null`, so every session passes on operator review of min/max/mode. Out of scope here — but is a defined acceptance range wanted as its own PRD?
- **OQ-4:** SPU 257's record still reads `passed` on 247's data. Correct it (and audit the rest of the Sep 3 batch for the same pattern) as a separate data task?

---

## 9. Test / Validation Plan

1. `npm run check` — zero new errors in touched files (the run-wide baseline is inflated in borrowed-`node_modules` worktrees; see progress.txt 2026-09-04).
2. Unit tests (S1/S2) over the four real operator files, asserting exact stats parity with what production already recorded for 247/249/244 — this is the regression net for the parser move.
3. `TZ=UTC npm test` — S2's parity assertion must hold under a UTC runtime, simulating Vercel.
4. Vercel preview: upload 257's real file, confirm 635 readings / 37.55 / 44.40, download the stored artifact and verify the SHA-256 matches the local file.
5. Duplicate check: re-upload 247's file against a different SPU and confirm the warning names THERMO-000030.
6. Legacy check: open a pre-change session (e.g. `XcmhVzH4IpNF5iGOXUL7D`) and confirm it renders with the "no source file retained" note and no broken link.

## 10. Out of Scope

Acceptance-range definition (OQ-3); 257 remediation (OQ-4); retiring `spu.attachments[]` (R6); retention policy (R7); any change to magnetometer or optical confirmation.

---

## Appendix A — File change map

**Add**
- `src/lib/server/validation/parse-thermo.ts` (moved; + `THERMO_PARSER_VERSION`, timezone param)
- `src/lib/server/validation/parse-thermo.test.ts`
- `src/lib/server/validation/thermo-ingest.ts` (`ingestThermoFile`)

**Modify**
- `src/routes/validation/thermocouple/+page.server.ts` — `upload` action takes a file
- `src/routes/validation/thermocouple/+page.svelte` — drop staged state + duplicate stats block
- `src/routes/validation/thermocouple/[sessionId]/+page.server.ts` / `+page.svelte` — verdict action, source-file block
- `src/lib/components/validation/thermocouple/ThermoFileUpload.svelte` — emit the `File`, not parsed readings
- `src/routes/validation/runs/[runId]/+page.server.ts` — `uploadThermo` posts the file
- `src/lib/server/validation/thermo-upload.ts` — `processThermoUpload` accepts pre-parsed input from the ingest module; set `overallPassed`
- `src/lib/server/db/models/validation-session.ts` — document `sourceFile` (Mixed; additive, no migration)

**Remove**
- `src/lib/components/validation/thermocouple/parse-thermo.ts` (moved)

## Appendix B — Reference pointers

- `fix/thermo-stale-upload-state` @ `855c6d33` — the interim fix this supersedes
- `src/routes/spu/work-instruction/+page.server.ts:80-135` — server-side upload+parse prior art
- `src/lib/server/services/r2.ts` — `uploadViaWorker` / `downloadViaWorker`
- `docs/prds/VALIDATION-05-spu-validation-run.md` §7.3 — the "upload ≠ pass" split this completes
- `docs/prds/R2-WORKER-UPLOAD-PROXY.md` — storage path
- Evidence files: `OneDrive - Linbeck Group, LLC/Desktop/New SPU thermo data/{247,249,244,257} temp data.xlsx`
