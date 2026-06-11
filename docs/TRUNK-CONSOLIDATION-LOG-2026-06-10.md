# Trunk Consolidation — Decisions Log (2026-06-10)

**Goal:** fold every *live* branch into one trunk and land it on `master` (Vercel production), so the team stops diverging across `main`/`master`.

**Method:** integration branch `jq/consolidate-trunk` based on `origin/main`; each branch folded as its own `--no-ff` merge commit (so any single branch is revertable). No force-pushes, no history rewrites — old `master` tip `213b8f5` is preserved and every decision is reversible.

**Guiding rule (Jacob's call):** most-recent content wins; union additive files (nav, registries, env, crons); regenerate lockfiles.

## Branches folded (15)
`dev`, `jq/reagent-qc-lot-tracking`, `feature/opentrons-api-phase1-3`, `feature/arm-protocols`, `feature/opentrons-clone-ui`, `spu-assembly-revamp`, `ui/rog-tron-recolor`, `robot-arm-calibration`, `feat/cv-train-infer-split` (reconciled — see below), `wax-creation`, `wax-prep`, `qol-changes`, `feat/scanner-on-ot2`, `feat/scanner-phase-0`*, `feat/robot-arm-phase-a`*, `feature/cartridge-back-process`, + `origin/master` (kanban). *(\* already fully contained — no-op.)*

`feat/erpnext-framework` (Nic): his only unique commit was a no-op against current code (see log). `archive/*` branches excluded by design (already merged or deliberately abandoned; one is a `revert-*`).

## Conflict resolutions (every non-trivial one)

| Branch | File(s) | Resolution |
|---|---|---|
| opentrons-api | `models/index.ts` | UNION — kept all 4 opentrons model exports |
| arm-protocols | `services/robot-arm/*.py` | THEIRS — arm-protocols is the newest arm service (05-27) |
| arm-protocols | `cart-mfg/robot-arm/+page.svelte` | DELETED — arm landing moved to `/control` |
| arm-protocols | `reagent-filling` + `wax-filling` `+page.server.ts` | UNION — jq's cart-mfg relocation + arm-protocols' OT-2 Start Run panel (verified `robotProtocols`/`lastTipState` defined in load) |
| opentrons-clone-ui | `opentrons/maintenance.ts` | **COLLISION** — kept OURS (`opentron-control`, 05-21, newest) as `maintenance.ts`; preserved clone-ui's (04-21) as **`maintenance-clone.ts`**; repointed the 3 `opentrons-clone` importers. Both OT-2 stacks survive. |
| opentrons-clone-ui | `health-poller.ts` | OURS — main's evolved DB-writing version vs clone-ui's thin stub |
| opentrons-clone-ui | `.gitignore`, `+layout.svelte` | UNION (nav: kept Shipping + added Opentron Clone link) |
| opentrons-clone-ui | `package.json` | UNION — `openapi-fetch` + `pdf-parse` |
| spu-assembly-revamp | CV files (`cv-image/inspection/project`, `api/cv/infer|train`, `cv/projects/[id]`) | OURS — main (05-16…05-27) newer than spu (05-15) |
| rog-tron-recolor | `parts/accession/+page.svelte` | UNION — tron palette (`red-300`) + main's type-safe `!` assertions |
| robot-arm-calibration | calibrate page, `.env.example` | OURS — arm-protocols (05-27) newer than calib (05-18). NOTE: calib's `alejandros-pc`→`arm-pi` host rename NOT taken |
| cv-train-infer-split | **whole CV subsystem** | **RECONCILED to main** — see CV note below |
| cv-train-infer-split | `robot-arm-run.ts`, `api/robot-arm/webhook` | OURS — arm-protocols (05-27) > cv-train (05-12) |
| cv-train-infer-split | `.env.example` | UNION — CV inference/training vars + robot-arm Tailscale block |
| wax-prep | `cart-mfg/wax-creation/+page.server.ts` | OURS — current cart-mfg far newer than wax-prep (04-14) |
| qol-changes | `parts/accession/+page.svelte` | OURS — rog-tron-recolor (05-07) already supersedes qol (04-22) |
| scanner-on-ot2 | `equipment/activity/+page.server.ts` | OURS — 05-06 typed version newer than scanner (05-04) `any[]` |
| **master** | kanban files (`analytics.ts`, `WipTimelineWidget`, `wip-timeline`, analytics page) | OURS — main's kanban (05-21) is newer **and larger** than master's (05-17) |
| master | `package.json` (bwip-js) | KEEP bwip-js — it IS used (`print-barcodes` + `replicate-print`); master's "drop bwip-js" predates those features |
| master | `notifications.ts`, `mocreo-sync.ts`, `vercel.json` | OURS — main superset (reminder/gateway-recovery logic + extra crons) |
| cartridge-back-process | all conflicts | OURS — current client-side bwip-js + cart-mfg WI-01 supersede April work; `wi-01` stays deleted; removed stale `api/barcodes/generate-pdf` (imported dropped `pdf-lib`) |
| Nic / erpnext-framework | `wax-batch/validate` | NO-OP — the `lot.waxMelt` melt-ready gate Nic removed no longer exists (refactored to `WaxBatch.remainingVolumeUl`); intent already satisfied; cherry-pick skipped |

## CV note (see `docs/CV-CONSOLIDATION-NOTES-FOR-ALEJANDRO.md` for full detail)
`feat/cv-train-infer-split` is a **divergent refactor** of the CV subsystem, not a foldable branch — it structurally conflicts with main's deployed capture-station CV. Mixing broke the type-check, so the CV subsystem was kept **100% main-coherent**; cv-train's incoherent net-new training/labeling routes were removed; its harmless Python/workflow scaffolding kept. cv-train's serverless-training direction should land as its own follow-up PR. Its branch on `origin` is untouched.

## Type-check status
`npm run check`: the remaining errors are all **pre-existing in `main`/`jq`** (r2.ts Buffer/BodyInit, AskBimsWidget literal comparison, assembly/[sessionId] implicit-any ×8, run-inference `anomaly_score` — all already shipping on production `main`). The consolidation added **0 net-new type errors** after reconciliation (the one new one — `wi-01` `RecentLot.bucketBarcode` — was fixed by adding the optional field).
