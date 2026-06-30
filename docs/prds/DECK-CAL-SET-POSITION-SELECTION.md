# PRD: Deck Calibration — "Set position" works on the whole highlight selection

## Goal
On the Deck Calibration Studio (`/manufacturing/cart-mfg/deck-calibration`), replace the
**"Set position → one hole"** feature (which refuses to run unless exactly one hole is
selected) with **"Set position → selection"**, which sets an exact x/y/z for *any* group of
holes the operator has highlighted (click, shift-click, or box-drag select).

## Why
The set-absolute-position tool is the natural way to type a known-good coordinate, but today
it's gated to `selection.size === 1`. Operators routinely highlight a group (a cartridge, a
column, a box-drag region) and want to drive that group to a position without falling back to
the relative `dx/dy/dz` "Offset → selection" tool or doing the arithmetic by hand.

## Semantics (the only physically meaningful multi-hole "set position")
A deck is a grid of *distinct* holes — forcing every selected hole to the same absolute
coordinate would collapse them onto one point, which is never wanted. So for a multi-hole
selection the typed x/y/z is the new position of an **anchor** hole, and the entire selection
translates rigidly by the same delta — preserving the holes' relative geometry. This mirrors
the existing **"Shift whole grid"** anchor-translate pattern, but scoped to the highlight
selection and driven by an *absolute target* instead of a typed `dx/dy/dz`.

- `delta = (setX − anchor.x, setY − anchor.y, setZ − anchor.z)`
- Applied to **every selected hole** via the existing `applyDeckEditBatch` engine.
- **Single-hole selection → identical to the old behavior** (delta applied to that one hole).

### Anchor selection
- The anchor is the **most-recently-clicked hole** while it remains in the selection.
- If the anchor is no longer selected (e.g. after a box-drag that didn't include it), it falls
  back to the **first selected hole in deck definition order**, so the anchor is always defined.
- The x/y/z inputs are **prefilled from the anchor's current coords** whenever the anchor
  changes; the operator edits and applies.
- The active anchor's well name is shown in the panel.

## Scope (single page, UI-only + reuse existing engine)
File: `src/routes/manufacturing/cart-mfg/deck-calibration/+page.svelte`

1. **Selection model** — track an `anchorWell` (set on each additive/single click that *adds*
   a hole). Derive an always-defined `anchor` (explicit anchor if still selected, else
   deck-order-first selected hole).
2. **Prefill** — drive `setX/setY/setZ` off the `anchor` (was: off the single selected hole).
3. **`applyAbsolute`** — accept `selection.size >= 1`; compute the delta from the anchor and
   apply it to the whole selection through `applyDelta` → `?/applyBatch` (unchanged server).
   Records one undo entry (inverse delta) exactly as today; bounds-guard, history, AuditLog,
   live-run update, and "Sync for real fills" semantics are all inherited unchanged.
4. **Panel UI** — rename to **"Set position → selection"**, show the anchor, update the help
   text and the button (enabled for `selCount >= 1`; label adapts to single vs group).

## Non-goals
- No server/model/API changes. `applyDeckEditBatch` already takes `wellNames[] + delta`.
- No change to the relative "Offset → selection", "Shift whole grid", jog/capture, or
  per-robot offset features.
- No new permissions (still `manufacturing:write` on `?/applyBatch`).

## Acceptance
- Highlight one hole → type x/y/z → apply → only that hole moves (regression: old behavior).
- Highlight a group (box-drag or multi-click) → the anchor is shown + prefilled → type a new
  anchor position → apply → all selected holes translate by the same delta; relative spacing
  preserved; canvas shows them all edited (amber ring); one undo reverts the whole group.
- Out-of-bounds members are reported via the existing `failed[]` path, not silently dropped.
- `npm run check` stays at the documented 11-error baseline (0 new); build green.
