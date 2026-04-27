---
feature_id: 001
status: approved  # draft | in-review | approved
---

# Technical Plan: Labels tab barcode scan

## Architecture

Pure client-side feature. Scanning and highlighting happen in the browser against data already returned by the existing `+page.server.ts` load function (`data.images`). No new server endpoints, no schema changes, no network calls at scan time.

```
┌──────────── /cv/projects/[id] ────────────┐
│                                           │
│  +page.server.ts  ──►  data.images[]      │
│                          (up to 100)      │
│                                           │
│  +page.svelte  (Labels tab)               │
│    ├── <input bind:value={scanValue}/>    │  ← new
│    │     on:keydown.enter → applyScan()   │
│    ├── derived: sortedImages              │  ← new
│    │     = scanned matches (asc) + rest   │
│    └── {#each sortedImages} … tile …      │
│           badges: SCANNED / TOP|BOTTOM    │  ← new
└───────────────────────────────────────────┘
```

Because the load function already returns every image for the project sorted by `createdAt: -1` (capped at 100), all filtering happens client-side. If the 100-image cap becomes a problem in practice we revisit; it is out of scope here.

## Data model

No changes. Relies on existing `CvImage` fields:

- `filename: string` — already contains the barcode per the Capture-tab convention `cartridge_capture_{barcode}_{NNN}.jpg`.
- `_id`, `imageUrl`, `label`, `cartridgeTag` — used as-is for rendering.

## API / interface changes

None. No new endpoints, no modified endpoints. Existing `/api/cv/images/:id/label` continues to handle Good/Defect labeling untouched.

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| — | — | No API changes | — |

## Technology choices

| Decision | Chose | Rejected | Reason |
|----------|-------|----------|--------|
| Barcode input | Hardware-scanner-friendly `<input>` with Enter submit | jsQR webcam scan | User stated "field to scan a barcode" (Q3 in spec); hardware USB scanner acts as a keyboard and fires Enter on completion. Webcam scan already exists in Capture tab. |
| Match algorithm | `filename.includes(barcode)` after trim | Regex on suffix pattern | Filenames embed the full barcode string (UUID); substring match is exact enough given UUID length (36 chars) and tolerant of future filename variations. |
| Sort key for TOP/BOTTOM | Parse trailing `_NNN` integer from filename | `createdAt` timestamp | Capture counter is monotonic per project and is the source of truth the user cited; timestamps could tie or be edited. |
| Match placement | Derived `sortedImages` (matches first, rest after, stable relative order) | Separate "pinned row" + regular grid | One grid is simpler, keeps existing CSS, satisfies REQ-002 (full gallery visible) and REQ-005 (matches at top). |
| Scroll-into-view | `scrollIntoView({ behavior: 'smooth', block: 'start' })` on first match's DOM node inside `tick()` after state update | Computed `window.scrollTo(y)` | Works correctly when grid reorders; no brittle offset math. |
| Highlight | Tailwind class `ring-2 ring-[var(--color-tron-cyan)] animate-pulse` + "SCANNED" badge | Inline style, new CSS keyframes | Tailwind's `animate-pulse` already used elsewhere in the app; zero new CSS. |

## Test strategy

- **Unit tests:** none (logic is trivial derivations on an in-memory array; a unit test harness for the svelte file would be disproportionate).
- **Integration / contract tests:** none (no API surface added).
- **Manual verification:** covered by each REQ's acceptance criterion in the spec. Specifically:
  1. Seed a project with `cartridge_capture_TESTBC_029.jpg` and `cartridge_capture_TESTBC_030.jpg` plus a few unrelated images via the existing Capture/Import path.
  2. Open Labels tab → confirm input auto-focuses.
  3. Type `TESTBC` + Enter → confirm both tiles move to the top, have pulsing cyan border + SCANNED badge, and are tagged TOP and BOTTOM in capture-number order.
  4. Scan a second barcode → confirm the previous two tiles drop back to their natural position and the new matches are pinned.
  5. Scan a barcode with no matches → confirm message appears and grid order is unchanged.
  6. Scan empty / whitespace → confirm nothing happens.
- **Regression risk:**
  - The Labels tab shares state (`labeling`, `data.images`) with Good/Defect/Induct flows — need to make sure reordering doesn't break the `{#each image (image._id)}` keyed rendering. Svelte 5 keyed `each` handles reorder cleanly, so risk is low.
  - Other tabs (Import, Capture, Train, Test, Review, Integrate) are unaffected — the new state is tab-local.

## Rollout

No feature flag. Single commit to the feature branch (`thermocouple-and-spec-validation` or a new branch depending on your preference), normal PR → main.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `{#each}` keyed by `image._id` thrashes DOM on reorder and breaks the lightbox / induct button state | Low | Svelte 5 preserves component state across keyed reorders; spot-check in manual verification step 3. |
| 100-image cap in the load function causes a scanned barcode to be "not found" because its images were captured long ago and are past page 1 | Low today, grows over time | Out of scope; note in spec as future work. Current Labels tab already has this limitation. |
| Barcode scanner adds a stray character (some models prepend a prefix) | Medium | `.trim()` the input on submit; match is substring so prefix chars on the scanner won't prevent the match as long as the UUID appears intact. |
| Operator scans odd number of images for a barcode (e.g., three captures) and the TOP/BOTTOM alternation misleads them | Medium | Documented in spec REQ-009 and acceptance; index 0, 2, 4 = TOP, 1, 3, 5 = BOTTOM per operator's stated convention. If they recapture, the newest capture wins in their workflow. |

## Requirements trace

| REQ-ID | Covered by |
|--------|------------|
| REQ-001 | `+page.svelte` markup for Labels tab — new input element inside `{#if activeTab === 'labels'}` block |
| REQ-002 | `sortedImages` derived state preserves every input image |
| REQ-003 | `onMount` / effect triggered by `activeTab === 'labels'` calls `.focus()` on input ref |
| REQ-004 | `applyScan()` computes `matches = data.images.filter(i => i.filename.includes(barcode))` |
| REQ-005 | `sortedImages` = matches sorted by capture-number ascending, followed by non-matches in original order |
| REQ-006 | After `applyScan()`, `tick()` then `firstMatchEl.scrollIntoView(...)` |
| REQ-007 | `applyScan()` overwrites `scannedIds` state (Set) before re-derivation |
| REQ-008 | Tile rendering: `ring-2 ring-[var(--color-tron-cyan)] animate-pulse` when `scannedIds.has(image._id)` |
| REQ-009 | `topBottomTag(image)` helper: index of image in `matchesSorted`, even → TOP, odd → BOTTOM |
| REQ-010 | When `matches.length === 0`, set `scanError = 'No images found for barcode {value}'` and do not mutate `scannedIds` |
| REQ-011 | Early return in `applyScan()` if `barcode.trim() === ''` |
