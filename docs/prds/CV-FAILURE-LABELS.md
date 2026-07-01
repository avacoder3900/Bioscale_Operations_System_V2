# PRD: Common Failure Labels — create, tag photos, tag at capture time

## Supersedes
This replaces the "Label Creation" tab shipped on `master` in commit `62a4463ed` (2026-07-01),
which was built against the wrong data model — `ManufacturingSettings.rejectionReasonCodes`
(the formal wax/reagent QC rejection-code system, with `code`/`label`/`processType`/`sortOrder`
fields, already managed on the wax-filling and reagent-filling settings pages). That system is
unrelated to what's wanted here. This PRD's feature should replace that tab's contents; the tab
itself can stay in the same nav slot.

## Problem
Operators reviewing cartridge photos in the Image Stream have no way to flag *what went wrong*
on a specific photo. `CvImage.cartridgeTag.labels` already exists in the schema and is filterable
(shipped 2026-07-01), but nothing ever writes to it after image creation — there's no UI to tag an
existing photo, and no UI to tag a photo at the moment it's captured. The field is populated only
if a caller happens to pass `labels` to `POST /api/cv/images/record`, which nothing currently does.

## Change
A simple, freeform "common failures" vocabulary, usable in three places:

### 1. Manage tab (Image Stream, existing 4th tab slot)
- One list of failure labels (plain text, e.g. "Bubble in wax", "Cracked cartridge", "Misaligned
  top seal"). No code/process-type/sort-order — just text.
- Big **+** button at the top → inline text input → submit → label exists immediately (optimistic
  UI, no page reload). No separate "add reason" form step.
- Each existing label: delete button. (No edit-in-place needed per the description — delete +
  re-add covers renames; add if requested later.)

### 2. Image Stream — tag photos after the fact
Two clearly separate sections on each photo (lightbox), both already-existing `cartridgeTag`
fields, finally with UI to write to them:
  - **Notes** — free-text textarea → `cartridgeTag.notes`. Already exists as a field and is
    already searchable (2026-07-01 notes-search feature); this PRD just adds the write UI.
  - **Labels** — select-only chips from the premade `FailureLabel` list → `cartridgeTag.labels`.
    No free-text entry here — that's what Notes is for. Click a chip to toggle it on/off for
    this photo. New labels only ever get created via the Manage tab's + button (Section 1).
- Both persist immediately per edit (no separate save step) via the endpoints below.

### 3. Capture flow — tag at the point of taking the photo
- On `/capture` (the live station capture page), after a photo is taken: the same two sections
  (Notes textarea + Labels chip-picker) appear, scoped to the photo just captured.
- Wired into the existing `POST /api/cv/capture` call so both are set at creation time rather
  than requiring a second round-trip after the fact.

## Data model
**New model** `FailureLabel` (collection `failure_labels`) — deliberately minimal, not reusing
`ManufacturingSettings.rejectionReasonCodes`:
```typescript
{
  _id: String,           // generateId()
  text: String,          // the label itself, e.g. "Bubble in wax"
  createdBy: { _id: String, username: String },
  createdAt: Date
}
```
Unique on `text` (case-insensitive) so the type-new-label path can't silently create duplicates —
if it matches an existing label, reuse that one instead of inserting.

**No change** to `CvImage.cartridgeTag.labels` (`[String]`, already exists) — this feature is
what finally writes to it.

## API
- `POST /api/cv/failure-labels` — create `{ text }`; returns existing match if `text` already
  exists (case-insensitive) instead of erroring or duplicating.
- `DELETE /api/cv/failure-labels/[id]` — delete a label. Does **not** retroactively strip it from
  already-tagged photos (those keep the string in `cartridgeTag.labels` — it's just no longer
  offered as a suggestion). Flag in the confirm dialog if it's currently in use on N photos.
- `PATCH /api/cv/images/[id]/tags` — new endpoint (sibling to the existing
  `PATCH /api/cv/images/[id]/label` which handles `qcLabel` pass/fail) — body
  `{ labels?: string[], notes?: string }`, partial-updates `cartridgeTag.labels` /
  `cartridgeTag.notes` on that image. Follows the same auth/permission pattern as the existing
  `label` endpoint. Used by both the Image Stream lightbox and (indirectly) capture-time tagging.
- `POST /api/cv/capture` — extend to accept optional `labels` (JSON array) and `notes` (string)
  fields in the form data, passed through into `cartridgeTag` on creation (mirrors how
  `/api/cv/images/record` already accepts `cartridgeTag.labels`/`notes`, just not
  `/api/cv/capture`; also generalizes the existing forensic-only `notes` handling in that
  endpoint rather than adding a second parallel notes path).

## Files
- **New** `src/lib/server/db/models/failure-label.ts`
- **New** `src/routes/api/cv/failure-labels/+server.ts` (POST, GET list)
- **New** `src/routes/api/cv/failure-labels/[id]/+server.ts` (DELETE)
- **New** `src/routes/api/cv/images/[id]/tags/+server.ts` (PATCH — labels + notes)
- **Edit** `src/routes/api/cv/capture/+server.ts` — accept + write `labels` and (generalized) `notes`
- **Edit** `src/routes/cv/stream/+page.server.ts` — add `failureLabels: FailureLabel.find()` as a
  new, separate field powering the Manage tab + tag-picker. Leave `failureCodeOptions`
  (rejectionReasonCodes-backed, powers the existing Common Failure *filter* dropdown) untouched.
- **Edit** `src/routes/cv/stream/+page.svelte` — replace the Manage tab's contents (drop the
  code/processType/sortOrder form, replace with the simple +-button flow); add the Notes textarea
  + Labels chip-picker to the lightbox
- **Edit** `src/routes/capture/+page.svelte` — add the Notes textarea + Labels chip-picker after a
  photo is taken
- **Revert/remove**: the `createFailureReason`/`updateFailureReason`/`deleteFailureReason` actions
  in `cv/stream/+page.server.ts` (wrong data model, per Supersedes above)

## Permissions
- Creating/deleting failure labels: `manufacturing:read` is enough (this is a shared vocabulary,
  not a QC-config change — much lower stakes than `rejectionReasonCodes`, which stays gated on
  `manufacturing:admin`). Open question below.
- Tagging a photo (Image Stream or capture time): same permission already required to view/use
  those pages today — no new gate.

## Non-goals
- Not touching `ManufacturingSettings.rejectionReasonCodes` or the wax/reagent settings pages —
  that system stays as-is for its existing purpose (Common Failure filter dropdown on
  `/cartridge-admin` and `/cv/stream`, which is correctly built and unaffected).
- Not adding a processType/category to failure labels — flat list only, per the description.
- Not retroactively backfilling labels onto existing untagged photos.

## Open questions (need your call before I build this)
1. Permission for creating/deleting failure labels — `manufacturing:read` (any operator) or
   `manufacturing:admin` (leads only)? Defaulting to `manufacturing:read` unless told otherwise.
2. Thumbnail-card Notes/Labels access (quick-tag without opening the lightbox) — worth the extra
   UI, or lightbox-only is enough for v1? Defaulting to lightbox-only for v1.

## Acceptance
- Manage tab: click +, type "Bubble in wax", it appears in the list immediately, no reload.
- Image Stream lightbox: click a photo, see a Notes textarea and separate Labels chip-picker.
  Type a note, it persists (reload the page, it's still there). Toggle "Bubble in wax" on in
  Labels, it persists. No free-text entry inside the Labels picker — new labels only come from
  the Manage tab.
- `/capture`: after taking a photo, add a note and/or tag it with an existing label before moving
  to the next cartridge; the saved `CvImage` has both in `cartridgeTag`.
- Existing Common Failure filter dropdown (rejectionReasonCodes-backed) and Tag filter dropdown
  (cartridgeTag.labels-backed) on `/cartridge-admin` and `/cv/stream` are unaffected.
- `npm run check` stays at the 11-error baseline (0 new).

## Deployment note
Same as the rest of the 2026-07 cart-mfg/CV work — log the deployment in `progress.txt` per
CLAUDE.md's Deployment Log Entries format, push to a branch, let the GitHub integration deploy
(no local `vercel deploy`).
