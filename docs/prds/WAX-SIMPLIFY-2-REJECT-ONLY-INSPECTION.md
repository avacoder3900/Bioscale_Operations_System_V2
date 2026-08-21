# WAX-SIMPLIFY-2 — Reject-only visual inspection at `wax_filled` (Wax Reject page)

**Date:** 2026-08-17 · **Owner:** Jacob · **Status:** Approved (conversation 2026-08-17)
**Supersedes:** WAX-INSPECTION-READY-REJECTED (photo → `wax_qc` → verdict) and the inline-CV
verdict intent of WAX-FLOW-4 — both **shortcut, not deleted**; the CV infra stays for later.
**Series:** WAX-SIMPLIFY-1 · WAX-SIMPLIFY-2 (this) · WAX-SIMPLIFY-3

## Intent (Jacob)

"Shortcut all of the wax QC stuff and computer vision models — we will bring that back when we
need it. We are going to visually inspect all these carts at wax filled. If they are visually
rejected we put them in a separate bucket and have a new UI screen where we scan them as wax
rejected and snap a pic of them. This way we capture all of our images of failures for data
training, and not being rejected implicitly means you are accepted."

## Decision

- Inspection happens by eye at the bench on `wax_filled` carts. **No status change for a pass.**
  Not-rejected ⇒ accepted. There is no `wax_qc` "photographed, awaiting verdict" state anymore.
- Rejects go in a physical reject bucket, then get processed on a new page **Wax Reject**:
  scan → photo → Reject. Status → `wax_rejected`. Every reject has a photo; that photo is the
  training data.
- `wax_ready` remains a valid status (legacy carts already there; the future CV/human-verdict
  path lands there again when it returns). Nothing new produces it for now.
- Existing `wax_qc` carts migrate to **`wax_filled`** (Jacob's call: under "not rejected =
  accepted" they're accepted, and they'll be eyeballed at the bench regardless).

## New page — `/manufacturing/cart-mfg/wax-reject`

Permissions: `manufacturing:read` view, `manufacturing:write` reject.
Menu: cart-mfg sidebar entry **"Wax Reject"** next to Wax Filling; **remove** the "Wax Inspect"
entry from the menu (route stays reachable by URL — WAX-FLOW-4 kept as backup, not destroyed).

Pattern: sibling of `/wax-inspect` and `/reagent-inspect` — reuse their scanner-wedge sticky
context, station dropdown (Pi WebRTC + USB fallback), and `POST /api/cv/capture` round-trip.
Strip the verdict/PASS-FAIL UI; the only action is Reject.

Flow (one screen, optimized for a bucket of carts, no mouse):
1. **Scan** cart QR (autofocused hidden input). Server lookup: must exist and be `wax_filled`
   (also accept legacy `wax_qc`/`wax_stored` rows so an unmigrated cart can still be rejected;
   `wax_ready` accepted too — a visual reject after CV said ready is legitimate). Anything else →
   red banner with the status, no action.
2. **Snap** — Space / button captures the frame → `POST /api/cv/capture` with
   `phase: 'wax_filled'`, `cartridgeRecordId`. Photo saved to R2 + CvImage as today. Because a
   photo on this page *means* "rejected", the capture request carries `defaultLabel:
   'wax_rejected'` (or the page immediately calls the existing label endpoint) so the CvImage is
   pre-labelled fail for training. Optional short **reason** field (chips: `underfill`,
   `overfill`, `bubble`, `smear`, `other` + free text) — not required to keep the loop fast, but
   stored when given.
3. **Reject** — button (Enter). `POST /api/cv/wax-verdict { cartridgeId, verdict:'rejected',
   reason?, imageId }`. Server sets `status:'wax_rejected'`, `priorStatus`, mirrors into
   `waxQc {status:'Rejected', rejectionReason, operator, timestamp, source:'human'}` (DHR keeps
   rendering), AuditLog `wax_inspection_verdict`. If no photo was taken for this scan the button
   is disabled with "snap a photo first" — **photo is mandatory for a reject** (that's the
   whole point).
4. Context clears, focus returns to the scan input. **Session feed** below: this session's
   rejects (thumb, barcode, reason, operator, time), newest first; server pre-loads the last 50
   `wax_rejected` carts.
5. Header readouts: live count of `wax_filled` (bench queue) and `wax_rejected` today.

## Server / API changes

- `api/cv/wax-verdict/+server.ts`: eligible-from set becomes `['wax_filled','wax_ready','wax_qc',
  'wax_stored']` (the last two for unmigrated rows). Keep `'ready'` verdict accepted by the API
  (CV return path) but the Wax Reject UI never sends it. Add optional `imageId` to the audit row.
- `api/cv/capture/+server.ts`: **delete** the `wax_stored → wax_qc` auto-advance block
  (WAX-INSPECTION-READY-REJECTED §2). Photographing never changes wax status now.
- `wax-inspect/+page.svelte` `ALLOWED_STATUSES`: drop `wax_stored`; keep page working for the
  day CV returns; add a small grey banner "Wax QC is currently visual-only — use Wax Reject.
  This page stays for CV model deployment." No other changes.
- `cv/induct/+page.server.ts` phase-tracking copy: wax row says "Wax Reject: photograph +
  reject `wax_filled` → `wax_rejected`; passes are implicit".
- `waxQc.status` enum unchanged (`Accepted|Rejected|Pending`); `waxQc.source` field exists.

## Migration (shared script from WAX-SIMPLIFY-1)

`status:'wax_qc'` → `wax_filled`, `priorStatus:'wax_qc'`, AuditLog. Photos already on those
records stay in `photos[]`.

## Not in scope

- CV auto-verdict, model deployment at `wax_filled` (infra intact; nothing wired).
- `wax_rejected` disposition / scrap workflow (rejects sit at `wax_rejected`; the existing
  `/scrap` page can take them from there — verify it accepts `wax_rejected`; if not, add it).
- Removing `wax_qc` from the enum — keep for historical rows; remove from *producing* paths only.

## Acceptance

- Scan a `wax_filled` cart on Wax Reject, snap, Reject → `wax_rejected`, photo on record,
  CvImage labelled fail, AuditLog row; scan input refocused.
- Reject without a photo is impossible from the UI.
- Scan a `reagent_filled` cart → banner, no change.
- Photographing a cart anywhere no longer changes its wax status.
- Menu shows Wax Reject, not Wax Inspect; `/wax-inspect` still loads.
- `npm run check` baseline, build green.
