# CV Reconciliation — cv-microscope branch vs. master's CV-PIPELINE-V2

**Date:** 2026-07-10 · **Status:** DECISION NEEDED — production deploy of `cv-microscope` is PAUSED

## What happened

Two CV redesigns were built in parallel by different working sessions:

- **Master / CV-PIPELINE-V2** (PRD 2026-07-07, merged via PRs #22–#26, **live in production**): found the same strict-mode field-stripping bug, fixed it, added versioned `trainedModels[]` + `deployAtPhases` + verify-before-deploy gating, a per-project **Needs-review tab**, an **/cv/induct** page, training-504 fix (embedding cache warm at capture), defects cast fix, and its own migration (`scripts/migrate-cv-pipeline-v2.ts`: label→qcLabel, classifier→trainedModels v1, status normalization).
- **This lineage** (`feat/cv-clean-datapath` → `cv-microscope`, preview-deployed only): full data-model purge with **`cartridge_records.photos[]` as the single source of photo truth** (qcLabel/labels/notes/annotations on the cartridge doc), `cv_images` demoted to embedding cache, verdict-only `cv_inspections`, one `phases[]` scope field, Stage Models page, cartridge intake, **and the entire microscope station**: sequence engine (15-shot grid, photoType/sequenceId/location{row,col}), MJPEG fast preview (35ms vs 261ms WebRTC, benched), Celestron 1080p V4L2 fix — running on station 3's Pi today.

## The one architectural disagreement

| | Master V2 (prod) | cv-microscope |
|---|---|---|
| Photo truth (qcLabel/labels/notes) | `cv_images` | `cartridge_records.photos[]` |
| photos[] role | thin pointer list | full record incl. QC + microscope fields |
| Scope field | `deployAtPhases` (+ declared schema) | `phases[]` (single field) |
| Model versioning | `trainedModels[]` + verify-gated explicit Deploy | `trainedModels[]` + auto-activate |
| Review flow | Needs-review tab (per project) | Stream filters + uncertainty data (passProbability) |
| Migrations run on prod | migrate-cv-pipeline-v2 (label→qcLabel etc.) | migrate-cv-labels --apply (2026-07-10: gap-filled photos[] from cv_images — additive, idempotent, harmless to V2 code) |

Convergent everywhere else: both declare the previously-stripped fields, version models, unify on qcLabel, normalize inspection statuses (V2: queued/running/completed; ours: running/completed/failed — near-identical).

## Unique value to preserve from each

**Master V2 (must not regress — it's live):** Needs-review tab, /cv/induct, verify-before-deploy gating + per-version photo provenance, training time-budget/504 fix, capture-time embedding warm.

**cv-microscope (must not lose — hardware is live):** microscope station end-to-end (agent sequence.py, grid locations, photoType descriptor, capture-ingest extensions), MJPEG fast preview + JWT auth + Tailscale Serve path, CAP_V4L2 fix (Celestron 640x480→1080p), camera device/profile envs, cartridge intake (+intake mode), Stage Models page, CVDEMO seed, stream/DHR microscope views.

## Options

1. **Port microscope onto V2 (RECOMMENDED).** New branch off master; port the microscope station + fast preview + intake + Stage Models onto V2's conventions (qcLabel on cv_images, deployAtPhases). photos[] keeps the microscope fields (photoType/sequence/location are additive there under either architecture). Prod features preserved; the photos[]-as-truth layer is shelved (revisit later or never — V2's declared-schema fix already solves the original bug).
2. **Deploy cv-microscope as-is.** Regresses Needs-review/induct/deploy-gating; re-forks photo truth. Not recommended.
3. **Merge V2 features into photos[]-truth.** Largest job; both migrations fight over truth location; prod behavior changes underneath users.

## Current live state (for whoever picks this up)

- Prod (master) serves V2. Station 3 Pi runs the cv-microscope agent (microscope profile, 1080p, sequence + /preview.mjpg live) — its BIMS_URL points at a dated preview deployment; sequence uploads against a V2-era endpoint will store photos but strict-drop photoType/sequence/location until V2's capture-ingest learns those fields (part of the port).
- migrate-cv-labels has been applied to prod (photos[] gap-filled). No further migration should run until the port decision.
- cv-microscope preview: https://bioscale-operations-system-mongodb-2fg7xaqd3-brevitest.vercel.app (@ f312ae6c).
