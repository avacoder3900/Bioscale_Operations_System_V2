# Session Handoff — Analytics Demo + Training Mode (2026-04-23 → 04-24)

**Previous-session Claude / user: jacobq@brevitest.com**
**For:** the next terminal / next session, to pick up where this one left off

> Read `docs/AUDIT-HANDOFF-2026-04-23-CARTRIDGE-REFACTOR.md` first if you haven't — this doc assumes that refactor context. This handoff covers what happened AFTER that audit (analytics + demo training work + misc fixes).

---

## 0. Environment + CORE RULE

- Repo: `C:\Users\nicho\Desktop\Bioscale_Operations_System_V2\Bioscale_Operations_System_V2-1`
- Stack: SvelteKit 2 + Svelte 5 + Mongoose 9 + MongoDB Atlas, Vercel deploy from `main`
- Run scripts with `npx tsx scripts/<name>.ts`, env loads from `.env`
- Type-check: `npx svelte-check --tsconfig ./tsconfig.json`

### 0.1 CORE RULE — NEVER PUSH TO MAIN

**You do not have permission to push/merge/deploy to `main`.** The user explicitly reserved it. Stop at `master`. Even when a prior conversation granted "blanket permissions," main is excluded. See `~/.claude/.../memory/feedback_no_master_merge.md`.

If work reaches master, hand off: *"pushed to master at `<sha>` — ready for you to promote to main."*

---

## 1. What happened in this session (chronological)

### 1.1 Manufacturing analytics page — Phase 1 (scaffolded earlier, refined here)

`/manufacturing/analysis` — 11-tab page (Overview, Cycle Time, Yield & Failures, Material Flow, Compare, SPC Alerts, FMEA, Manual Input, All Runs, Reports & Export, DOE Planner). Backed by new Mongoose models: `ProcessAnalyticsEvent`, `SpecLimit`, `FmeaRecord`, `SpcSignal`, `CauseEffectDiagram`. Stats helpers in `src/lib/server/analytics/stats.ts`. Landed earlier, still live.

### 1.2 Demo twin page

New route `/manufacturing/analysis/demo` — fabricated-data clone of the real page.

- **Seed generator:** `src/lib/server/analytics/demo-seed.ts` — deterministic (LCG seeded with `20260423`), cached at module scope. Generates 1,115 runs + 16 FMEA + 18 SPC signals + 80 manual events + 4 spec limits + 2 cause-effect diagrams. **Nothing writes to Mongo.**
- **Server route:** `src/routes/manufacturing/analysis/demo/+page.server.ts`. All form actions are no-ops returning `"Demo training mode — changes are not persisted to Mongo."`
- **Svelte:** copy of the real `+page.svelte` with demo banner, training content, password gate wrapper.

### 1.3 Demo data flow rebalance

Original seed had wax over-consuming by 2,292 carts from upstream WI-01, reagent under-consuming by 61%, and tiny top-seal (42) / QA-QC (28) counts that didn't match realistic scale. Rebalanced process mix so cartridge flow is physically coherent (each stage ≤ upstream accepted):

```
laser-cut     63 runs (4,999 sheets produced)
cut-thermoseal 40 runs (1,990 sheets — parallel supply)
cut-top-seal  92 runs (4,536 top-seal sheets)
wi-01        105 runs (4,969 backed cartridges)
wax          230 runs (consumes 4,817, produces 4,570 accepted after 5% reject)
reagent      265 runs (consumes 4,531, produces 4,279)
top-seal     180 runs (applies to 4,155)
qa-qc        140 runs (releases 4,100)
```

Per-stage flow verified by `scripts/audit-demo-consistency.ts` (checked-in). Pareto total = run-level rejects + aborts exactly. Overall FPY ≈ 98.5%, RTY ≈ 89.6%.

### 1.4 Training mode on the demo page

The demo page doubles as a teaching tool.

- **Password gate** — cookie-based. Password = `processadmin`, 24-hour session. Set with `httpOnly + sameSite=strict + secure`. Wrong password → friendly error. Lock button expires session. Gate is in `+page.server.ts` load + `unlock` / `lock` actions.
- **Training ON/OFF toggle** — hides/shows all green "📚 Training — X Tab" panels.
- **Glossary drawer** — toggleable blue panel with plain-language definitions of 23 terms: FPY, RTY, scrap vs reject, mean/median/σ/IQR, histogram shapes, control charts, UCL/LCL, LSL/USL, Cp, Cpk, Pp/Ppk, DPMO, process sigma, Pareto, Nelson rules, ANOVA, p-value, Ishikawa/5M1E, FMEA, DOE, common vs special cause, Gage R&R, SPC vs capability.
- **Per-tab training guides** — every tab has a green-bordered "📚 Training — X Tab" panel at top. Each covers: what you're looking at, how to read each chart, stat-term explanations, how the tab connects to others, real-world workflow. Written for a sophomore engineering student new to process engineering.
- **Start Here banner** — top-of-page intro explaining the whole page's purpose + common vs special cause (the most important concept).

### 1.5 Demo operator rename

All 12 fake operators renamed to full names with first names rhyming with Nick/Nicholas/Alejandro and last names rhyming with Cox/Valdez:

`Nick Fox, Rick Knox, Mick Cox, Vic Brooks, Nico Sanchez, Leandro Valdez, Alejandro Hernandez, Alessandro Gonzalez, Sandro Rodriguez, Evandro Fernandez, Dario Martinez, Armando Gutierrez`

Real `/manufacturing/analysis` page is untouched — rename + training + password apply to `/demo` only.

### 1.6 Configurable pre-QC cooldown

Was: hardcoded 10-minute minimum between "cooling confirmed" and "complete QC" in two `completeQC` actions.
Now: `ManufacturingSettings.waxFilling.minCoolingBeforeQcMin` (default 2 minutes, seeded via `scripts/set-cooling-before-qc-2min.ts` with AuditLog).

Editable at `/manufacturing/wax-filling/settings` → Time Parameters → "Min Cooling Before QC". Also displayed on the unified Opentron Control settings viewer at `/manufacturing/opentron-control/settings`.

Two completeQC files updated: `src/routes/manufacturing/wax-filling/+page.server.ts` + `src/routes/manufacturing/opentron-control/wax/[runId]/+page.server.ts`.

### 1.7 WI-01 audit (read-only — deferred to Friday)

Read-only audit completed but no code changes. Findings:

- "WI-01" is the legacy Work Instruction name for the Cartridge Backing process. Obsolete as a naming convention; the process itself is alive.
- 28 code occurrences across 17 files; 65 doc occurrences across 11 files; 26 script occurrences.
- Mongo fingerprint: 13 LotRecords have `qrCodeRef` starting with `WI01-`; 35 `inventory_transactions.notes` match `/WI-?01/i`; 16 backing-type LotRecords use the page.
- Hard dependencies if renamed: URL path `/manufacturing/wi-01`, sidebar link, conditional nav rendering, `qrCodeRef = 'WI01-${nanoid(8)}'` generator, the `'wi-01'` ProcessType enum baked into 5 Mongoose models.
- DB layer already uses `'backing'` — it's mostly the URL + enum key + QR prefix that still say WI-01.
- User said: "waiting for Friday to work through WI-01 changes and proper nomenclatures." Hold off unless they bring it up.

### 1.8 Deploy fix — brace escape

Vercel deploy broke on a Svelte compile error in the demo page's glossary: `min{(USL − μ)/3σ, (μ − LSL)/3σ}` — Svelte parses `{...}` as a template expression. Rewrote as prose: `min of (USL − μ)/3σ and (μ − LSL)/3σ`. Unblocked the build. Commit `1573df7`.

If you add more training text to svelte files, watch for bare `{` / `}` in plain text — escape with HTML entities or rewrite.

### 1.9 Misc

- Other terminals were active in parallel during this window. Commits from `Nicholas-Cox221 <ncox@brevitest.com>` and automated merges show up — that's research-run work, ECC-01 fridge refs, scrap-tracking fixes. Their handoff is in `docs/AUDIT-HANDOFF-2026-04-23.md`.
- `.claude/settings.local.json` kept conflicting between branches across my pushes. Resolved by discarding my local copy (`git checkout --`).
- `ralph/equipment-connectivity-prd` feature branch was used as a snapshot landing zone; their merge commit landed in dev.

---

## 2. Branch state at end of session

| Branch | Commit | Notes |
|---|---|---|
| `dev` | `1573df7` | latest — includes analytics demo + training + brace fix |
| `master` | `b622586` | behind dev by training-mode work + brace fix — **next step: merge dev → master and push** |
| `main` | `87ceba7` | **OFF-LIMITS.** User promotes manually when they want. Currently far behind master. |

---

## 3. Open items to pick up

### Immediate
1. **Merge dev → master and push.** One command, nothing fancy:
   ```
   git checkout master && git pull --ff-only && git merge dev --no-ff -m "Merge dev: analytics demo training mode + cooldown config + brace fix" && git push origin master
   ```
   Then tell the user: "pushed to master at `<sha>` — ready for you to promote to main."

2. **User wants to tackle WI-01 rename on Friday.** Scope is in §1.7 above. Don't start it unless they ask.

### Scaffolded but not wired
3. SPC signal auto-opener (nightly job) — the Nelson-rule detection code is in `stats.ts`; the scheduler that opens `SpcSignal` rows when rules trip on live data is not yet wired.
4. Phase-3 DOE analyzer — planner generates run matrices; main-effects / interactions / standardized-effects Pareto not built.
5. xlsx multi-sheet export on Reports tab (dep installed, not wired).
6. Gage R&R analysis UI (raw data collection via `ProcessAnalyticsEvent.msa_measurement` works; analysis does not).
7. Regression drivers-of-scrap tool (`simple-statistics` has OLS; no UI).
8. Extend `rejectionReasonCodes` taxonomy with `category` / `severity` / `costWeight`.

### Long-lived compliance risk
9. **Lot `V1BSHFzMXsNAxYiP59o6b` / bucket `2941bb67`** — WI-01 recorded 54 cartridges; 66 were actually pulled. 12 extra have unexplained provenance. Documented via `corrections[]` + AuditLog `RECONCILE`. These 12 cartridges must NOT ship to a customer without human QA review. Carry this forward until closed.

---

## 4. Files of note (where to look)

### New / heavily modified in this session
- `src/routes/manufacturing/analysis/demo/+page.server.ts` — password gate + no-op form actions
- `src/routes/manufacturing/analysis/demo/+page.svelte` — full demo UI + training overlays (~1,400 lines)
- `src/lib/server/analytics/demo-seed.ts` — fabricated-data generator (~450 lines)
- `src/routes/manufacturing/wax-filling/+page.server.ts` — configurable cooldown
- `src/routes/manufacturing/opentron-control/wax/[runId]/+page.server.ts` — mirror
- `src/routes/manufacturing/wax-filling/settings/+page.{server.ts,svelte}` — new editable field
- `src/routes/manufacturing/opentron-control/settings/+page.{server.ts,svelte}` — viewer includes new field
- `scripts/audit-demo-consistency.ts` — verify the demo flow stays coherent
- `scripts/smoke-test-demo-seed.ts` — smoke test the seed generator
- `scripts/set-cooling-before-qc-2min.ts` — one-shot setting seed (already ran, won't duplicate)
- `scripts/diag-wi01-mongo.ts` — WI-01 audit data layer

### Kept frozen (do not touch per CLAUDE.md)
- `src/routes/manufacturing/analysis/+page.svelte` — the REAL analytics page (training applies only to /demo)
- All other existing `.svelte` files unless user explicitly asks

### Memory (persistent across sessions)
- `~/.claude/projects/.../memory/MEMORY.md` — index
- `~/.claude/projects/.../memory/feedback_no_master_merge.md` — CORE RULE on main
- `~/.claude/projects/.../memory/feedback_autonomy.md` — autonomy excluding main
- `~/.claude/projects/.../memory/project_opentrons_integration.md`, etc.

---

## 5. Verification commands (run first to confirm state)

```bash
# Confirm demo generator still works + flow is coherent
npx tsx scripts/audit-demo-consistency.ts

# Check Mongo collections the analytics module uses
npx tsx scripts/diag-cartridge-audit.ts
npx tsx scripts/diag-equipment-reconcile.ts

# Confirm no Svelte compile errors
npx svelte-check --tsconfig ./tsconfig.json 2>&1 | grep ERROR | head -20

# Confirm build works (ignore any local EBUSY swapfile.sys — Windows quirk, not Vercel-relevant)
npm run build
```

If any of these misbehave, something drifted; diagnose before making changes.

---

## 6. Quick context reset for the next Claude

"You're continuing an analytics project. The real page at `/manufacturing/analysis` reads live Mongo and is production-functional. A training twin at `/manufacturing/analysis/demo` uses fabricated data (password `processadmin`) with educational overlays. User doesn't let anyone push to main — stop at master. Parallel terminals may have run; read `docs/AUDIT-HANDOFF-2026-04-23.md` + `docs/AUDIT-HANDOFF-2026-04-23-CARTRIDGE-REFACTOR.md` + this doc to catch up. Use `scripts/audit-demo-consistency.ts` to verify nothing drifted."

That's it. Pick up from §3 Open Items.
