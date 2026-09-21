# SPU-INV-06 — SPU Device Journal (Free-Form Log Entries)

**Status:** Draft
**Branch:** `feat/spu-tweaks`

## Problem

Everything on an SPU is structured (statuses, validation, service records, audit rows), but
there's nowhere to record the unit's *story* — "this one ran hot during the June pilot",
"customer reported flaky LTE, watch it", "rebuilt after drop, treat early data with suspicion".
That semantic context lives in people's heads. `ownerNotes` is a single overwritable string,
service notes are locked to servicing jobs, and AuditLog is machine-shaped.

## Decision: new feature, not a repurpose

Considered repurposing `ownerNotes` (no history, single field) and `serviceRecords[].notes`
(wrong scope — tied to a service cycle). A dedicated journal is ~1 subdocument array and one
action; repurposing would distort existing semantics for no savings.

## Design

1. **Model** (`src/lib/server/db/models/spu.ts`): new `journal[]` subdocument array —
   `{ _id: String (generateId), text: String (required), createdBy: { _id, username },
   createdAt: Date }`. Trackable string `_id` per the CLAUDE.md subdocument rule.
2. **Append-only.** Entries are a diary: no edit, no delete from the UI. That keeps the story
   trustworthy (matches the QMS culture of the rest of the record). Corrections are just new
   entries. (An admin can always fix data at the DB level.)
3. **Action** `addJournalEntry` on `/spu/[spuId]` (`spu:write`): trims, requires non-empty,
   caps at 5000 chars, `$push`es with author + timestamp, writes an AuditLog row.
4. **UI**: a "Journal" card on the detail page's Device Information tab, full width, below the
   info/status grid. Textarea + "Add Entry" on top; entries below, newest first, whitespace
   preserved (`whitespace-pre-wrap`), each with author + timestamp. Empty state invites the
   first entry.

## Non-goals

- No markdown rendering, attachments, tagging, or cross-SPU journal search (add later if the
  feature earns it).
- No journal on the `/spu` list view.

## Acceptance

- Any user with `spu:write` can append entries from the detail page; `spu:read` users see them.
- Entries survive refresh, ordered newest-first, attributed and timestamped, audit-logged.
- `npm run check` at or below the 11-error baseline.
