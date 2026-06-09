---
id: 001
name: labels-barcode-scan
status: implemented  # draft | in-review | approved | implemented
created: 2026-04-21
author: alejandrov@fannininnovation.com
---

# Specification: Labels tab barcode scan

## Problem

Operators labeling cartridge images in the CV project Labels tab currently scroll through the full image grid (up to 100 images) to find the specific cartridge they just physically inspected. When they have a cartridge in hand, the fastest way to locate its images is by the barcode already embedded in each filename (e.g. `cartridge_capture_fd168533-fddd-46a6-b086-2740ca096f57_029.jpg`). No mechanism exists to scan that barcode and jump to the matching tiles.

## User journey

1. Operator opens `/cv/projects/{id}` and clicks the **Labels** tab.
2. A barcode-scan input is visible at the top of the Labels tab with focus.
3. Operator holds the cartridge in front of the USB barcode scanner (or types the UUID). The scanner enters the barcode string and sends Enter.
4. The system finds every `CvImage` in the current project whose `filename` contains that barcode.
5. The matching images are pinned to the top of the Labels grid, highlighted with a distinct cyan border and a "SCANNED" badge, and annotated as **TOP** or **BOTTOM** based on capture order.
6. The page auto-scrolls so the pinned matches are centered in view.
7. Operator labels each matching image Good / Defect as usual; the rest of the gallery remains visible below, unfiltered.
8. Operator scans the next cartridge. Previously pinned matches return to their original position in the grid, and the new matches are pinned.

## Requirements (EARS notation)

**Ubiquitous:**
- REQ-001: The system shall render a barcode-scan input at the top of the Labels tab whenever the tab is active.
- REQ-002: The system shall keep the full image grid visible (no filtering) regardless of scan state.

**Event-driven:**
- REQ-003: When the Labels tab is activated, the system shall auto-focus the barcode-scan input.
- REQ-004: When the user submits a barcode string (Enter key), the system shall query the current project's images and mark every image whose `filename` contains that barcode as "scanned."
- REQ-005: When a scan produces one or more matches, the system shall reorder the grid so all scanned matches appear first in capture-number-ascending order.
- REQ-006: When a scan produces one or more matches, the system shall auto-scroll the Labels grid so the first match is visible.
- REQ-007: When the user submits a new barcode, the system shall clear the previous scan's highlighting before applying the new one.

**State-driven:**
- REQ-008: While an image is a scanned match, the system shall render it with a pulsing cyan border and a "SCANNED" badge.
- REQ-009: While an image is a scanned match, the system shall display a TOP or BOTTOM tag derived from its position in the match list sorted by capture number ascending (index 0, 2, 4… = TOP; index 1, 3, 5… = BOTTOM).

**Unwanted-behavior:**
- REQ-010: If a submitted barcode matches zero images in the current project, the system shall display "No images found for barcode {value}" below the input and leave the grid order unchanged.
- REQ-011: If the submitted barcode contains only whitespace, the system shall ignore the submission.

## Acceptance criteria

- [ ] REQ-001: Loading `/cv/projects/{id}` with the Labels tab selected shows the scan input at the top.
- [ ] REQ-002: After any scan (match or no match), every image that existed before the scan is still rendered somewhere in the grid.
- [ ] REQ-003: After clicking Labels, typing into a keyboard immediately enters characters into the scan input (no click required).
- [ ] REQ-004: Given two seeded images `cartridge_capture_ABC_029.jpg` and `cartridge_capture_ABC_030.jpg`, submitting `ABC` highlights exactly those two tiles.
- [ ] REQ-005: Given the two seeded images above plus 50 other images, after scanning `ABC` the first two tiles in the grid are `_029` then `_030`.
- [ ] REQ-006: After a scan that matches, `window.scrollY` changes to bring the first match into view.
- [ ] REQ-007: Scanning barcode A then barcode B leaves only barcode B's matches with the SCANNED badge.
- [ ] REQ-008: A scanned match tile has a visually distinct pulsing cyan border.
- [ ] REQ-009: Given three matches `_029`, `_030`, `_031` for the same barcode, the tags are TOP, BOTTOM, TOP.
- [ ] REQ-010: Submitting a UUID with no matches shows the "No images found" message and the grid order is identical to pre-scan.
- [ ] REQ-011: Submitting an empty string or spaces does not change anything.

## Out of scope

- Using the webcam to read the barcode optically (the existing Capture tab already has this; the Labels tab uses hardware scanner / keyboard input only).
- Persisting the "last scanned" state across page reloads.
- Changing the capture-tab filename convention.
- Cross-project barcode search (scan is scoped to the current project).
- Any change to the Good/Defect labeling workflow itself.

## Open questions

- [x] Q1: TOP/BOTTOM rule confirmed — sort matches by trailing capture number ascending, alternate TOP/BOTTOM starting with TOP. (`_029` = TOP, `_030` = BOTTOM.)
- [x] Q2: Svelte-edit exception granted for `src/routes/cv/projects/[id]/+page.svelte` for this feature.
- [x] Q3: Scan input stays at the top of the Labels tab permanently. Each new scan replaces the previous scan's highlights; the new matches become the pinned top row.

## Dependencies

- Existing `CvImage` model (`src/lib/server/db/models/cv-image.ts`) — no schema change needed.
- Existing Labels tab in `src/routes/cv/projects/[id]/+page.svelte`.
- Existing filename convention from the Capture tab (`cartridge_capture_{barcode}_{NNN}.jpg`).
