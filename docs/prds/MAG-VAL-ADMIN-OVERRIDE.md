# PRD: MAG-VAL — Magnetometer Validation Admin Override

**Author:** Alejandro Valdez
**Date:** 2026-03-31
**Status:** Draft
**Priority:** P1 — Critical for QC traceability
**Branch:** `thermocouple-and-spec-validation`

---

## 1. Problem Statement

Magnetometer validation data is already logged, persisted to the SPU record (`validation.magnetometer`), and audit-trailed. The companion PRD `DHR-VALIDATION-DISPLAY` covers displaying this data on the SPU detail page.

**What's missing:** When a device fails magnetometer validation (e.g., SPU 0238 — wells 3 & 4 Ch A are 8–28 gauss below threshold), there is no mechanism to approve the device. If engineering determines the failure is acceptable (borderline, known calibration offset, etc.), an admin must currently edit the database directly. This is not traceable, not auditable, and not compliant.

## 2. Goal

Add an **admin override** action on the magnetometer session detail page (`/validation/magnetometer/[sessionId]`) that:
- Requires admin password re-entry (not just session auth — explicit re-authentication)
- Requires a written justification
- Flips the session to passed while preserving the original failure data
- Updates the SPU record to reflect the override
- Creates a full audit trail

## 3. Scope

| What | In scope? | Notes |
|------|-----------|-------|
| Admin override action | **Yes** | Backend form action |
| Password re-authentication | **Yes** | bcrypt verify against admin user |
| SPU record update on override | **Yes** | Updates `validation.magnetometer.status` → `overridden` |
| Audit logging | **Yes** | Full before/after snapshot |
| Override on session detail `.svelte` | **No** | UI is frozen per CLAUDE.md |
| DHR display of override status | **No** | Covered by DHR-VALIDATION-DISPLAY PRD |
| Override for thermocouple/lux/spect | **Deferred** | Same pattern, apply later |

## 4. Relationship to DHR-VALIDATION-DISPLAY

| Concern | This PRD | DHR PRD |
|---------|----------|---------|
| Override backend logic | ✅ | — |
| Override audit trail | ✅ | — |
| SPU validation data display | — | ✅ |
| Override status badge (overridden vs passed vs failed) | — | ✅ (can add `overridden` status color) |
| Per-well data table | — | ✅ |
| Thermocouple/lux/spect display | — | ✅ |

## 5. Stories

### MAG-VAL-01: Admin Override Form Action

**Routes covered:**
- `POST /validation/magnetometer/[sessionId]` (action: `overrideApproval`)

**Action input (formData):**
```
adminPassword: string    — re-entered password for explicit auth
reason: string           — written justification (required, min 10 chars)
```

**Action logic:**
1. `requirePermission(event, 'admin:full')`
2. Validate `reason` is provided and >= 10 characters
3. Verify `adminPassword` against `event.locals.user` password hash via bcrypt
4. Load session — reject if already passed or already overridden
5. Save original state snapshot
6. Update `ValidationSession`:
   - `overallPassed: true`
   - `status: 'completed'`
   - `override: { by: { _id, username }, at: Date, reason, originalResult: { overallPassed, failureReasons, status } }`
7. Update `SPU.validation.magnetometer`:
   - `status: 'overridden'`
   - `overriddenBy: { _id, username }`
   - `overriddenAt: Date`
   - `overrideReason: reason`
8. Create `AuditLog` entry with action `OVERRIDE`, full old/new snapshots
9. Return `{ success: true }`

**Acceptance criteria:**
- Wrong password → `fail(403, { error: 'Invalid password' })`
- Missing/short reason → `fail(400, { error: 'Reason required (min 10 characters)' })`
- Non-admin user → blocked by `requirePermission`
- Already-passed session → `fail(400, { error: 'Session already passed' })`
- Successful override → session shows `overallPassed: true` with `override` object preserved
- SPU record updated with `overridden` status
- AuditLog created with full trail
- `npm run check` passes

### MAG-VAL-02: Expose Override State in Session Load

**Routes covered:**
- `GET /validation/magnetometer/[sessionId]` (load function update)

**Changes to load return:**
```typescript
// Add to existing session return object:
override: session.override ? {
  by: session.override.by,
  at: session.override.at,
  reason: session.override.reason,
  originalResult: session.override.originalResult
} : null
```

## 6. Data Changes

**ValidationSession model** — add `override` subdocument:
```typescript
override: {
  type: {
    by: { _id: String, username: String },
    at: Date,
    reason: String,
    originalResult: {
      overallPassed: Boolean,
      failureReasons: [String],
      status: String
    }
  },
  default: null,
  _id: false
}
```

No new collections. No migration needed (additive field).

## 7. Files to Modify

| File | Change |
|------|--------|
| `src/routes/validation/magnetometer/[sessionId]/+page.server.ts` | Add `overrideApproval` action, update load to return override |
| `src/lib/server/db/models/validation-session.ts` | Add `override` subdocument to schema |

## 8. Files NOT to Touch

| File | Reason |
|------|--------|
| Any `.svelte` file | UI frozen per CLAUDE.md |
| `src/routes/validation/magnetometer/+page.server.ts` | Main test page unchanged |
| SPU model | `validation.magnetometer` already uses `Mixed` type — override fields fit without schema change |

## 9. Testing

### Test with SPU 0238 (failed magnetometer)
1. Navigate to the failed session detail page
2. Submit overrideApproval with valid admin password + reason
3. Verify session `overallPassed` flipped to true
4. Verify `override` object preserved with original failure data
5. Verify SPU `validation.magnetometer.status` is `overridden`
6. Verify AuditLog entry created

### Negative tests
- Submit with wrong password → 403
- Submit with reason < 10 chars → 400
- Submit on already-passed session → 400
- Non-admin user → permission denied
