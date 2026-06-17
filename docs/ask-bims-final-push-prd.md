# Ask BIMS — Final Push PRD

**Status:** Implementation-ready. Companion to `docs/ask-bims-final-push-plan.md` (the strategy doc). This PRD is the blueprint an autonomous build agent should follow.

**Branch:** continue on `feat/ask-bims-markdown-context`. Push after each phase so Vercel rebuilds the preview.

**Hard rules for the build agent:**
- Never push to `main`. Never push to `master`. Only push to `feat/ask-bims-markdown-context`.
- Never modify any `.svelte` file. UI changes are out of scope for this build. Where a feature needs a UI piece, ship the server side and document that the widget piece is a follow-up.
- Run `npx tsx scripts/test-ask-bims.ts --model haiku --max-cost 3` after each phase. **Halt on any baseline regression.** Suite must stay at 44/44.
- Add at least one new fixture in `tests/ask-bims/baseline.ts` per new tool, covering the happy path.
- Commit + push per phase. Each commit message names the phase and reports the post-phase harness result.
- Talk like a coworker in commit messages and tool descriptions (the operator-facing voice rules in the system prompt apply to the agent's own output too).

---

## Phase 1 — Daily integrity scan

**What:** Move the seven known data-integrity checks from on-demand (recomputed every time someone asks Ask BIMS) to a scheduled daily run that writes findings to the `BimsAnomaly` collection. The existing `check_data_integrity` tool then queries those findings instead of recomputing.

**Why:** Per the 2026 research, bad data drives most enterprise AI failures. A daily scan catches issues before operators do and makes integrity questions instant.

### The seven checks

1. **Null wax source lot** — wax filling runs in the last 30 days where `waxSourceLot` is null or empty.
2. **Over-consumed receiving lots** — any `receiving_lots` row where `consumedUl > quantity`.
3. **Stale temperature readings** — equipment where `lastTemperatureReadAt` is older than 4 hours.
4. **Stuck cartridges** — cartridge records in a non-terminal status (anything except `completed`, `cancelled`, `scrapped`, `voided`, `released`, `shipped`) where `updatedAt` is older than 7 days.
5. **Orphan reagent batch references** — `reagent_batch_records.tubeRecords[].sourceLotId` values that don't resolve to a `receiving_lots._id`.
6. **Inventory counter drift** — `PartDefinition.inventoryCount` differs from the sum of accepted `ReceivingLot.quantity - consumedUl` for the same part by more than 5%.
7. **Legacy status carriers** — cartridge records still using v1 status names (`packeted`, `transferred`, `refrigerated`, `received`) that should have been migrated.

### Files to create

- `src/routes/api/cron/bims-anomaly-scan/+server.ts` — the cron endpoint. Auth via `Authorization: Bearer ${CRON_SECRET}` per the existing cron pattern (see `/api/cron/mocreo/+server.ts` for the template).
- Register in `vercel.json` crons array:
  ```
  { "path": "/api/cron/bims-anomaly-scan", "schedule": "0 7 * * *" }
  ```
  (07:00 UTC = 02:00 Houston local; runs before the workday starts.)

### Files to modify

- `src/lib/server/ask-bims.ts` — the existing `check_data_integrity` tool. Switch it from "recompute everything" to "query `BimsAnomaly` for findings from the last 24 hours, group by kind, return summary." Keep the recompute path as a fallback if the collection is empty (first-run / cron hasn't ticked yet).

### Tool behavior change

The `check_data_integrity` tool's result shape stays roughly the same — the operator-facing answer doesn't change. Internally it's now reading pre-computed findings, which makes it fast and consistent across the day.

### Acceptance

- Cron endpoint runs locally via `curl` with the right `Authorization` header and writes rows to `BimsAnomaly`.
- After a single cron tick, `check_data_integrity` returns the same shape it did before but without computing anything new.
- Each of the seven checks has a unit-ish test or at least a manual verification noted in the commit message.
- Suite at 44/44 after the change.
- New fixture in `baseline.ts`: a question that exercises the cron-backed path.

---

## Phase 2 — Chemical inventory lookup

**What:** Bundle the BT + Fannin chemical inventories into the codebase and expose them through a new `lookup_chemical` tool, parallel to how `lookup_equipment_datasheet` already works for equipment.

**Why:** 148 Brevitest chemicals + 55 Fannin chemicals are about to live in a shared physical space. Ask BIMS has no way to answer "where's the methanol" or "do we have enough sodium azide" today. Biggest net-new capability.

### Data prep

Source files (already on disk, surveyed by the knowledge-dive subagent):
- `c:\Users\nicho\Downloads\Brevitest and Fannin Chemical Inventory Final (1).xlsx`

Convert the two sheets (Brevitest + Fannin) to CSV and place under `data/chemical-inventory/`:
- `data/chemical-inventory/brevitest.csv`
- `data/chemical-inventory/fannin.csv`
- `data/chemical-inventory/README.md` documenting source + columns

The xlsx package is already in the project (used elsewhere for BOM imports). Convert with:
```ts
import * as XLSX from 'xlsx';
const wb = XLSX.readFile(srcPath);
fs.writeFileSync(`data/chemical-inventory/brevitest.csv`, XLSX.utils.sheet_to_csv(wb.Sheets['Brevitest']));
fs.writeFileSync(`data/chemical-inventory/fannin.csv`, XLSX.utils.sheet_to_csv(wb.Sheets['Fannin']));
```

### Files to create

- `src/lib/server/chemical-inventory.ts` — parser + lookup function. Mirror `src/lib/server/equipment-datasheets.ts` structure exactly: `import.meta.glob` with Node fs fallback, in-memory cache on first read, substring-or-AND-of-words match.
- Test fixtures for the new tool in `baseline.ts` (2-3 entries).

### Files to modify

- `src/lib/server/ask-bims.ts` — add `lookup_chemical` tool definition (placed after `lookup_equipment_datasheet` in the TOOLS array; on the evolving side of the cache breakpoint) and case handler.

### Tool spec

```
{
  name: 'lookup_chemical',
  description: `Search the shared-lab chemical inventory by name, CAS number, or
tag (C-XXX for Brevitest, D-XXX for Fannin).
Source: data/chemical-inventory/brevitest.csv + fannin.csv

Use when: "where's the methanol", "how much sodium azide do we have",
"what's chemical C-042", "find any chemicals with CAS 67-56-1".

Returns up to 10 matching chemicals with: name, CAS, hazard class,
quantity, location, owning org (Brevitest or Fannin).

Critical: when both orgs maintain separate stocks of the same chemical
(about a dozen examples — DMSO, IPA, ethanol, PBS, NaOH, etc.), surface
that BOTH stocks exist in the dataIntegrityNotes so the operator knows
to confirm which one they want.

Don't use for: prepared reagents (use list_reagent_inventory instead —
those live in shared Mongo) or part-catalog items like PT-CT-114 (use
find_part).`,
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Chemical name, CAS number, or tag (C-NNN / D-NNN)' },
      hazardClass: { type: 'string', description: 'Optional filter — e.g. "HTX", "FLAM", "OX", "COR"' },
      org: { type: 'string', enum: ['brevitest', 'fannin', 'all'], description: 'Default: all' },
      limit: { type: 'number', description: 'Max results (default 10)' }
    },
    required: ['query']
  }
}
```

### Dual-stocking detection

When a query matches chemicals in BOTH org files, emit:
```
dataIntegrityNotes: [
  `Both Brevitest and Fannin keep their own stock of ${name}. Make sure
   you're reaching for the right bottle — they may have different lot
   numbers, opening dates, or storage locations.`
]
```

About a dozen chemicals are known to be dual-stocked (DMSO, IPA, ethanol, PBS, NaOH, BSA, glycerol, agarose, DTT, TCEP, NaCl, sucrose — see `project_chemical_inventory_fannin.md` memory entry).

### Acceptance

- "Where is the methanol?" returns a real answer with location + owning org.
- "Find any HTX chemicals" returns the regulated stuff with hazard flags.
- "Tell me about C-042" returns the row for that tag.
- A query that matches both orgs surfaces the dual-stocking note.
- Suite at 44/44 after the change.
- 3 new fixtures in `baseline.ts` covering: by name, by tag, by CAS.

---

## Phase 3 — Floor plan / location-aware answers

**What:** A `find_location` tool that resolves an equipment tag, zone name, or chemical location into a spatial description.

**Why:** Tags like B-01 and F-03 are codes, not directions. New hires (and people returning to the lab after time away) should be able to ask "where's Fridge 3?" and get a real answer.

### Data prep

The floor plan structure is already captured in memory (`project_floor_plan_layout.md`). Codify it as a small lookup table inside the tool source — no new bundled file needed for this phase. Structure:

```ts
const ZONES = {
  'tissue-culture': {
    name: 'Tissue Culture',
    position: 'top-left, Fannin-enclosed',
    org: 'fannin',
    tagsContained: ['F-01', 'F-02', /* ... */]
  },
  'open-lab': { /* ... */ },
  'manufacturing': { /* ... */ },
  'r-and-d': { /* ... */ },
  'prototyping': { /* ... */ },
  'inventory': { /* ... */ }
};

const TAG_TO_ZONE: Record<string, string> = {
  'B-01': 'inventory',
  // ... populated from the equipment CSVs we already have
};
```

The build agent should populate `TAG_TO_ZONE` by reading `data/equipment-datasheets/BT.csv` + `Fannin.csv` at module load (same `import.meta.glob` pattern) and using the existing Location column.

### Files to create

- `src/lib/server/floor-plan.ts` — zone definitions + tag-to-zone resolver.

### Files to modify

- `src/lib/server/ask-bims.ts` — add `find_location` tool definition + case handler.

### Tool spec

```
{
  name: 'find_location',
  description: `Resolve an equipment tag, zone name, or 'where is X' question
into a spatial description of the new shared manufacturing space.
Source: data/equipment-datasheets/ (tag-to-zone mapping) + the floor plan
captured at project_floor_plan_layout memory.

Use when: "where is fridge 3", "what's near the cartridge oven", "show me
everything in tissue culture", "which side of the lab is the OT-2 on".

Returns: zone name, position description (north wall, lower-left, etc.),
owning org (Brevitest or Fannin), and a list of equipment + chemicals
known to live in that zone.

Don't use for: live equipment status (use list_equipment) or generic
internet questions about lab layout.`,
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Equipment tag, zone name, or natural question' }
    },
    required: ['query']
  }
}
```

### Acceptance

- "Where is Fridge 3?" returns a spatial description, not just a tag.
- "What's in Tissue Culture?" returns equipment + chemicals in that zone.
- "Where are the OT-2 robots?" returns Manufacturing zone with neighboring equipment context.
- Suite at 44/44 after the change.
- 2 new fixtures in `baseline.ts`: tag-based and zone-based.

---

## Phase 4 — Thumbs feedback (server-side only)

**What:** Plumbing for thumbs up/down feedback on Ask BIMS answers, plus an admin view to triage thumbs-downs. The widget UI button is **out of scope for this build** (no .svelte changes). This phase ships the backend so a future session can wire the buttons in cheaply.

**Why:** Right now we have zero signal on whether operators are getting useful answers. The harness measures tool selection; nothing measures operator satisfaction.

### Data model

New collection `ask_bims_feedback`. Mongoose model at `src/lib/server/db/models/ask-bims-feedback.ts`:

```ts
{
  _id: nanoid,
  timestamp: Date,
  userId: string,
  username: string,
  question: string,         // last user turn
  answer: string,           // the agent's final answer text
  toolsUsed: string[],      // tool name array
  model: 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7',
  confidence: 'high' | 'partial' | 'degraded' | null,
  rating: 'up' | 'down',
  comment: string | null,   // optional, only on thumbs-down
}
```

Index on `(timestamp DESC)` and `(rating, timestamp DESC)`.

### Files to create

- `src/lib/server/db/models/ask-bims-feedback.ts` — Mongoose model.
- `src/routes/api/agent/ask/feedback/+server.ts` — POST endpoint that accepts `{questionId, rating, comment?}` and writes to the collection. Requires session auth (`locals.user`).
- `src/routes/admin/ask-bims/feedback/+page.server.ts` — admin-only load function returning recent thumbs-downs.

### Files to modify

- `src/lib/server/db/models/index.ts` — export the new model.
- `src/lib/server/ask-bims.ts` — when returning a result, include a stable `responseId` (nanoid) so the UI can refer to a specific answer when sending feedback. Field already exists in spirit via the conversation log; just make sure it's surfaced.

### What we are NOT building (future session)

- The actual thumbs buttons in `AskBimsWidget.svelte` — that's a .svelte change.
- The admin page UI (`+page.svelte` in `/admin/ask-bims/feedback/`).
- Server side is ready and tested; UI follow-up is a separate task.

### Acceptance

- `POST /api/agent/ask/feedback` writes a row when given a valid body.
- Unauthorized requests get 401.
- The admin load function returns recent thumbs-downs sorted newest first.
- Suite at 44/44 after the change.
- No new harness fixtures needed (this phase doesn't change agent behavior).

---

## Phase 5 — Reagent chain write path

**STATUS: BLOCKED on user confirmation.** This phase requires Jacob to confirm the variant + execution flow is far enough along to support writing reagent chain entries from the wax-filling and reagent-filling pages.

**The build agent should NOT attempt this phase autonomously.** If the agent reaches Phase 5 and Jacob has not been confirmed, halt and report.

### Scope (for when it unblocks)

- When a cartridge completes the wax-filling stage, push an entry into its `reagentChain[]` capturing the protocol execution that produced the wax tube it used.
- Same for reagent filling.
- Small backfill script for recent cartridges where the data is reconstructable from existing run records.

### Files that would change

- `src/routes/spu/wax-filling/.../+page.server.ts` — the completeRun action.
- `src/routes/spu/reagent-filling/.../+page.server.ts` — same.
- `scripts/backfill-reagent-chain.ts` — new.

### Acceptance criteria

- New cartridges produced after this ships return non-empty chains from `trace_reagent_chain`.
- Older cartridges remain empty (documented limitation).
- The `dataIntegrityNote` that currently fires on empty chains no longer fires for new carts.

---

## How the autonomous build should sequence

Phase order: **1 → 2 → 3 → 4 → (5 if unblocked, else halt)**.

Why this order:
- Phase 1 is the smallest and unblocks the integrity-note quality story.
- Phase 2 is the biggest user-facing win and should land while the new-space context is fresh.
- Phase 3 is small and benefits from Phase 2 (chemicals can now reference zones).
- Phase 4 is plumbing only — needs no UI work to be valuable; ships in isolation.
- Phase 5 stays blocked.

After each phase:
1. Run `npx tsx scripts/test-ask-bims.ts --model haiku --max-cost 3`.
2. If suite passes 44/44, commit + push. Commit message:
   ```
   feat(ask-bims): Phase X — <title>
   <2-3 sentence summary>
   <harness result>
   ```
3. If suite regresses, **HALT** and report. Do not push.

Final report: a single message back to the user listing every commit hash, what shipped, what was deferred, and the final suite result.

---

## Budget + safety

- Hard spend cap on the autonomous loop: **$10 in Anthropic API spend.** Halt at $9 to leave headroom for the final report.
- No modifications to `.svelte` files, `static/`, or `app.html`.
- No new dependencies in `package.json` without explicit user approval (everything needed is already installed: mongoose, xlsx, anthropic SDK, nanoid).
- No schema migrations beyond the new `ask_bims_feedback` and `bims_anomalies` collection writes.
- Don't touch authentication, permissions, or session code.

---

## What "done" looks like

- 4 of 5 phases shipped on `feat/ask-bims-markdown-context` (Phase 5 deferred pending Jacob).
- Suite passing 44+ (new fixtures added; final count likely 50-52).
- One follow-up doc explaining what the next operator-facing session needs to do (the UI piece for thumbs feedback, the Jacob conversation for the reagent chain).
- Vercel preview rebuilt and ready to walk through.

That's the punch list. The operator-facing voice rules baked in last session do the rest of the work — every answer for the new tools comes out in plain language by default.
