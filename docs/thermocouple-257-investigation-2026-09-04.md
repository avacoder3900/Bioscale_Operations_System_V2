# Thermocouple validation — SPU 257 investigation and fix

**Date:** 2026-09-04
**Investigator:** Alejandro Valdez (via Claude Code)
**Branch:** `fix/thermo-stale-upload-state` (off `master`)
**Status:** interim fix deployed to preview; rework specified in VALIDATION-07, not yet scheduled

---

## What was reported

SPU 257's thermocouple data would not upload. The page appeared to read the file, but no statistics or graph showed and there were no Pass/Fail buttons to click.

## What was actually wrong — two separate things

### 1. SPU 257's record contains SPU 247's data (confirmed)

Session `THERMO-000031`, recorded against **SPU 257**, stores:

| | stored on 257 | `247 temp data.xlsx` | `257 temp data.xlsx` |
|---|---|---|---|
| readings | 377 | **377** | 635 |
| min | 40.90 | **40.90** | 37.55 |
| max | 44.00 | **44.00** | 44.40 |
| avg | 43.303 | **43.303** | 43.594 |
| sd | 0.775 | **0.775** | 1.261 |
| mode | 43.9 | **43.9** | 44.3 |
| starts | 2026-09-02T18:44:23Z | **2026-09-02T18:44:23Z** | 2026-09-04T19:01:39Z |

The stored figures are an exact match for 247's file, reproduced by running the production parser (`parseThermoRows`) against the operator's actual spreadsheets.

Write timing confirms the mechanism:

- `THERMO-000030` → SPU **247**, `2026-09-03T20:34:06Z`
- `THERMO-000031` → SPU **257**, `2026-09-03T20:34:38Z` — 32 seconds later, identical payload

SPU 257's `validation.thermocouple.status` currently reads `passed`, signed off on another unit's measurement. **This has not been corrected** (see Outstanding).

### 2. The page kept a hidden copy of the last file

On `/validation/thermocouple` the parsed readings lived in Svelte component state, not in form fields:

```js
let readings = $state<Array<{ timestamp: number; temperature: number }>>([]);
let readingsJson = $state('');
```

`use:enhance` calls `update()`, which resets the `<form>` element but leaves that state untouched. After a successful save the stats, chart and verdict buttons stayed on screen fully populated — so changing only the SPU dropdown and pressing Pass re-submitted **the previous file** against the newly selected SPU. That is how 257 got 247's data.

Separately, `ThermoFileUpload.handleFile` never reset `readingCount`. A file that failed to parse left the previous file's green "N readings loaded" panel up with only the filename swapped, while `onparsed` was never called — the UI claimed data was loaded when the page held none. And because the stats, chart and both verdict buttons all sat inside one `{#if hasReadings && stats}` guard, that state made the verdict buttons vanish with no explanation. That is the symptom as reported.

## What was ruled out

- **The 257 file is fine.** Run through the production parser it returns 635 readings, `temperature from column B+C, time from column A`, no error. Structurally identical to 249's and 244's files, which uploaded successfully the same day.
- **Not a server or network failure.** The statistics and chart are computed and drawn entirely in the browser; if they did not render, the browser never had the readings. Nothing had been sent yet at that point.
- **Audit log caveat:** only 249 (`16:11Z`) and 244 (`17:13Z`) posted on 2026-09-04. This shows no session was *created* for 257, but on its own it does not distinguish "never sent" from "sent and rejected" — a server-side rejection also leaves no audit row. The missing client-rendered stats are what establish it as client-side.

## What was fixed — commit `855c6d33`

- `ThermoFileUpload.handleFile` now zeroes `readingCount` and calls `onclear()` as soon as a new file is chosen, so a failed parse can never leave an earlier file staged. This also hardens the run-detail board, which uses the same component.
- `/validation/thermocouple` clears the staged upload after a successful save (`onClear()`, SPU reset, and a `{#key uploadNonce}` remount of the upload component).
- Added a line telling the operator to load a file when nothing is staged, instead of silently omitting the verdict buttons.

No server or schema changes.

**Verification:** `npm run check` — zero errors and zero warnings in both touched files. The run-wide count (119) is inflated because this worktree borrows `node_modules` from `.worktrees/pm-test` (older commit); 39 `Cannot find module` errors plus their implicit-any cascade are missing-dependency artifacts, not regressions. The Vercel build compiled clean.

**Preview:** https://bioscale-operations-system-mongodb-git-fix-the-3ea973-brevitest.vercel.app
(immutable: `https://bioscale-operations-system-mongodb-ak88vhsqf-brevitest.vercel.app`, `dpl_99GNjkSAT9VfgP5ZcztWx4Qjcf2f`)

### Worth testing on the preview

Upload a file, hit Pass, then pick a different SPU — the stats and chart should be gone and the verdict buttons unavailable until a new file is loaded. That is the exact sequence that produced the bad 257 record.

## Interim workaround on production

The fix is not on `master` yet. The bug needs stale state, so a fresh page load avoids it:

1. Hard-reload `/validation/thermocouple` (Ctrl+Shift+R)
2. Select SPU 257, drop `257 temp data.xlsx`
3. **Before pressing Pass, confirm it reads 635 readings, min 37.55, max 44.40, mode 44.3.** If it shows 377 readings or min 40.90, that is 247's file still staged — clear and reload rather than saving.

## The durable fix — VALIDATION-07

`855c6d33` closes the drift but not the class of defect: as long as "the file on screen" and "the data being submitted" are separate things, they can disagree. `docs/prds/VALIDATION-07-thermocouple-file-ingestion.md` (commit `feb8fbc9`) specifies the rework — upload the actual file, store it in R2, hash it, parse it server-side, and record the verdict against the persisted session.

### The hazard that rework has to handle

The logger writes `"14:01:39 2026-09-04"` with no timezone. JavaScript reads such a string as **local** time, so it resolves differently depending on where the parse happens:

| Runtime | `Date.parse('2026-09-04T14:01:39')` |
|---|---|
| Browser, America/Chicago | `2026-09-04T19:01:39.000Z` |
| Vercel function, UTC | `2026-09-04T14:01:39.000Z` |

Every session in the database was parsed in a browser and is therefore Central-interpreted — `249 temp data.xlsx` starts at `10:56:58` in the file and its record says `15:56:58Z`, exactly +5. Moving the parse to the server without threading the operator's timezone through would shift every new session 5–6 hours against all existing history, silently, in fields the run board and history views rely on.

### Other risks flagged in the PRD

R2 becomes a hard dependency on recording validation data; two screens where there is currently one; Vercel's 4.5 MB request-body cap; re-parsing with a newer parser version must never rewrite a stat already signed off; `spu.attachments[]` still accepts unconnected thermocouple CSVs; no retention policy for stored files.

## Outstanding

1. **SPU 257's record still reads `passed` on 247's data.** Needs a human correction against the real file. The operator has both spreadsheets saved.
2. **Audit the rest of the 2026-09-03 batch** for the same pattern — sequential sessions with identical payloads. `THERMO-000027`/`000028` (both SPU 230) and `THERMO-000025`/`000026` (both SPU 247) are worth checking, though re-uploads to the *same* SPU are legitimate.
3. **VALIDATION-07 OQ-1 blocks the rework:** if R2 is unreachable, fail the upload or record the session and store the file later? Blocking stops the floor; not blocking recreates artifact-less sessions.
4. **No acceptance range is configured.** `STANDARD_THERMO_CRITERIA` is `null`, so every thermocouple session passes on operator review of min/max/mode. A quality-policy decision, not a code change.
5. **Merge or park** `fix/thermo-stale-upload-state`. It is a preview only; `master` is unchanged.

## Reference

| | |
|---|---|
| Fix commit | `855c6d33` |
| Deploy log commit | `71ec89d1` |
| PRD commit | `feb8fbc9` |
| Branch | `fix/thermo-stale-upload-state` |
| Session in question | `XcmhVzH4IpNF5iGOXUL7D` (`THERMO-000031`, SPU 257) |
| Comparison session | SPU 247's `THERMO-000030` |
| SPU 257 | `_id M1xSJtoDZVbJK2ja5lb17`, UDI `BT-M01-0000-0257` |
| Evidence files | `OneDrive - Linbeck Group, LLC/Desktop/New SPU thermo data/{247,249,244,257} temp data.xlsx` |
| Code touched | `src/lib/components/validation/thermocouple/ThermoFileUpload.svelte`, `src/routes/validation/thermocouple/+page.svelte` |
