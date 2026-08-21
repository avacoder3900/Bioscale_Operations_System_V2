# KB2-31 — Scheduler capacity v2: the knob, the effort split, the schedule, the blend

**Status:** approved 2026-08-20. Source: `scheduler-capacity-v2-spec.md` (workshopped in
the Claude app, TASK-096), applied verbatim except one deviation noted below.
Companion: KB2-32 (MCP surface). Amends KB2-28.

## Problem (from the spec, condensed)
The roadmap's two answers disagree by 14 months. CPM (Oct 26) assumes unlimited parallel
hands — a floor, not a forecast. The capacity clamp (Dec 2027) divides 123.75 remaining
est-days by 1.75/wk measured velocity — but the board historically recorded ONE person's
batch-logged completions while most of Brevitest's work happened off-board: the
speedometer measured the till, not the kitchen. Second distortion: elapsed-time tasks
("Run internal diurnal round 1", est 15d) are ~90% calendar wait with 2–3 hands-on days;
the clamp charges all 15 against capacity AND their completion will spike measured
velocity optimistically. Duration and effort are different quantities; the schema had one
field for both.

## Fixes (spec priority order; #1 alone is shippable)

### 1. `capacity.teamEstDaysPerWeek` policy knob
- `KanbanPolicy.capacity = { teamEstDaysPerWeek: Number|null (default null), … }`.
- Clamp: `effectiveVelocity = capacity.teamEstDaysPerWeek ?? measuredVelocity`.
- Roadmap output: `velocityDaysPerWeek` (effective, used), `measuredVelocityDaysPerWeek`,
  `velocitySource: 'policy' | 'blend' | 'measured'`. Initial live value: **10**
  (Nick 3 + Jacob 3 + Alejandro 3 + Javier 1).
- **DEVIATION from spec:** the spec says "agent will set this via kanban_set_policy" —
  but MCP policy writes are **human-only by PERM-05** (self-declared actors are not
  authorization; the path is deliberately closed). Standing security decision wins:
  capacity is set by a human on `/kanban/policy` (new Capacity section). The agent gets
  live exploration through the NON-PERSISTED what-if overrides on `kanban_roadmap`
  (KB2-32) — explore via agent, commit via human.

### 2. `effortDays` vs duration split
- `KanbanTask.effortDays: Number` (optional, > 0). Semantics:
  CPM pass (chain length / dates) keeps using the duration ladder
  (`estimateDays` → sizeClass → median). Capacity clamp (remaining workload) sums
  `effortDays ?? duration`.
- Calibration + measured velocity are computed over `effortDays ?? estimateDays` — the
  same field the clamp consumes — so elapsed tasks stop poisoning both.
- Post-deploy data pass (agent, via KB2-32 `kanban_set_estimates`): internal run ≈3,
  external run ≈5, mini-validation ≈4, stability ≈2, gold-std design ≈5, gold-std run ≈3.

### 3. Dated capacity schedule
- `capacity.schedule: [{ from: Date, teamEstDaysPerWeek: Number }]` (sorted; later wins)
  — models intern onboarding (e.g. `{from: 2026-10-01, rate 15}`).
- Clamp becomes piecewise: walk forward from today consuming remaining effort at each
  period's rate until exhausted → `clampFinish`. Output includes
  `resolvedCapacitySchedule` so projections are self-explaining.

### 4. Blend to measured (the board settles into real data)
- `n` = completed tasks WITH an explicit estimate (`effortDays ?? estimateDays`) in the
  trailing window. `n ≥ measuredMinN (15)` → measured; `n ≥ blendMinN (8)` → blend
  `measured·n/15 + policy·(1−n/15)`; else policy. No knob set → legacy measured-only.
- Measured velocity: TRAILING window (`trailingWindowWeeks`, default 6), valued over
  `effortDays ?? estimateDays` for estimated tasks (ladder for unestimated) — the
  pre-team era ages out. Thresholds live in `capacity.{blendMinN,measuredMinN,
  trailingWindowWeeks}`, tunable on the policy page.
- Blend applies only when the knob is set; measured-mode uses trailing-window velocity.

## Legacy guarantee (acceptance #5)
With `capacity.teamEstDaysPerWeek` null and no `effortDays` anywhere, all NUMBERS are
identical to KB2-28 behavior (8-week-mean velocity, same clampFinish); the output merely
gains the new self-describing fields (`velocitySource: 'measured'`, etc.).

## UI
- `/kanban/policy`: new Capacity section — teamEstDaysPerWeek (nullable number), blend
  thresholds, trailing window, and a schedule textarea (lines: `YYYY-MM-DD rate`),
  validated server-side (rates > 0, dates ISO, sorted).
- `/kanban/roadmap` footnote: shows effective vs measured velocity, velocitySource, and
  the resolved schedule. No other UI change.

## Non-goals (per spec)
No per-person resource leveling; no CPM/backward-pass changes; no milestone-semantics
changes; no UI redesign.

## Acceptance (spec's checks, adjusted for the PERM-05 deviation)
1. Human sets capacity=10 on /kanban/policy → A4M clampFinish ≈ mid-Nov 2026,
   velocitySource 'policy', recipe-lock goes comfortably feasible.
2. effortDays data pass drops A4M remaining by ~28d; projection moves.
3. Schedule entry {2026-10-01, 15} improves the projection; removing it degrades it;
   roadmap echoes the schedule.
4. ≥15 recent estimated completions → velocitySource flips 'measured'; trailing window
   excludes stale history.
5. Legacy: knob null + no effortDays → numbers identical to pre-KB2-31.
