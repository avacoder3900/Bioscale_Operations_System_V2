# SPU-INV-10 — Unified Semantic Journal (Servicing Feeds the SPU Story)

**Status:** Approved (Jacob, 2026-09-04)
**Branch:** `feat/spu-tweaks`

## Concept (Jacob's framing)

The SPU journal (SPU-INV-06) and the servicing board's investigations should write to ONE
semantic journal per unit: closing/"publishing" a service job or group investigation (e.g.
"Timing Belt Investigation on all SPUs") appends its findings and notes in line with the manual
journal entries. Other systems join the same stream later. This is the lightweight realization
of the DHR-spine idea from the 2026-09-04 drift audit — the journal IS the unit's chronological
story, and it directly closes audit gap C (service closes previously wrote nothing narrative
onto the SPU).

## Design

1. **Journal entry schema grows source metadata** (additive; existing entries default to
   manual): `source: String ('manual' | 'service' | future kinds)`, `refKind`, `refId`,
   `refLabel` — a typed pointer to the producing record (e.g. service_record id + a
   human label like "Inspection — Timing Belt Investigation on all SPUs").
2. **One shared writer** — `src/lib/server/spu-journal.ts` exporting `appendSpuJournal()`.
   The manual add-entry action refactors onto it; every future producer (validation runs,
   release, etc.) is a one-line integration.
3. **Servicing board appends at close** (the "publish" moment — not per keystroke):
   - single `closeService` and bulk `closeGroupRemaining`: one entry per unit summarizing the
     job — service type, group name, reason, findings (with outcomes), notes, parts replaced,
     firmware changes, resolution, who closed it, returned-to status.
   - the detail page's inline `returnService` (quick flow) appends its issue/fix story too.
4. **UI**: the journal list stays one chronological stream; entries carry a small source badge
   (SERVICE vs nothing for manual) and show the refLabel. Append-only as ever.

## Non-goals

- No backfill of already-closed jobs (24 records; can script later if wanted).
- No journal writers for validation runs/overrides yet (next candidates, same helper).
- No cross-SPU journal search.

## Acceptance

- Closing a service job (single or group) appends a SERVICE-badged journal entry on each unit
  with findings/notes/resolution inline with manual entries, newest first.
- Manual entries unchanged; existing entries render as before.
- `npm run check` at or below the 10-error baseline.
