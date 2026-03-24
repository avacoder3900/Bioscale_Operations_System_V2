# SEC-05 — Equipment Permission Enforcement

## Overview
**Domain:** Security — Equipment routes
**Dependencies:** SEC-01
**Files:** ~6 page server files

Equipment pages have inconsistent protection. The activity page checks `equipment:read`, but deck/tray pages have **zero auth checks** — not even `locals.user`. Their create/update/delete actions are completely unprotected.

---

## Story SEC-05-01: Add equipment:read to Equipment Route Loads

### Files to Change
1. `src/routes/spu/equipment/decks-trays/+page.server.ts` — load: add `requirePermission(locals.user, 'equipment:read')`
2. `src/routes/spu/equipment/detail/+page.server.ts` — load: add `requirePermission(locals.user, 'equipment:read')`
3. `src/routes/spu/equipment/temperature-probes/+page.server.ts` — load: add `requirePermission(locals.user, 'equipment:read')`
4. `src/routes/spu/equipment/fridges-ovens/+page.server.ts` — load: add `requirePermission(locals.user, 'equipment:read')` (currently only uses `isAdmin()` for a UI flag)

### Acceptance Criteria
- Users without `equipment:read` get 403 on all equipment sub-pages

---

## Story SEC-05-02: Add equipment:write to Deck/Tray CRUD Actions

### Files to Change
1. `src/routes/spu/equipment/decks-trays/deck/+page.server.ts`
   - All actions (create, update, delete): add `requirePermission(locals.user, 'equipment:write')`

2. `src/routes/spu/equipment/decks-trays/tray/+page.server.ts`
   - All actions (create, update, delete): add `requirePermission(locals.user, 'equipment:write')`

3. `src/routes/spu/equipment/fridges-ovens/+page.server.ts`
   - All actions (create, update, archive, etc.): add `requirePermission(locals.user, 'equipment:write')`

### Acceptance Criteria
- Users without `equipment:write` get 403 on deck/tray/fridge CRUD actions
- Users WITH `equipment:write` can create, edit, delete equipment as before
