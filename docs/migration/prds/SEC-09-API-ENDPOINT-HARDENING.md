# SEC-09 — API Endpoint Hardening

## Overview
**Domain:** Security — REST API endpoints
**Dependencies:** SEC-01
**Files:** ~5 API server files

Several API endpoints have insufficient auth. One debug endpoint has zero auth and exposes integration token metadata. Others check authentication but not authorization.

---

## Story SEC-09-01: Remove or Protect api/box/debug Endpoint

### Description
`src/routes/api/box/debug/+server.ts` has **no authentication at all** and exposes Box integration token metadata. This should either be removed entirely or gated behind `admin:full`.

### What to Change
**Option A (recommended):** Delete the file entirely. Debug endpoints should not exist in production.

**Option B:** Add `requirePermission(locals.user, 'admin:full')` to the GET handler.

### Acceptance Criteria
- The `/api/box/debug` endpoint either no longer exists or requires `admin:full`

---

## Story SEC-09-02: Add Permission Checks to BOM/Search, Inventory/Transactions, Kanban/Move APIs

### Files to Change
1. `src/routes/api/bom/search/+server.ts`
   - GET: add `requirePermission(locals.user, 'inventory:read')` (currently only checks `locals.user` exists)

2. `src/routes/api/inventory/transactions/+server.ts`
   - GET: add `requirePermission(locals.user, 'inventory:read')` (currently only checks `locals.user` exists)

3. `src/routes/api/kanban/move/+server.ts`
   - POST: add `requirePermission(locals.user, 'kanban:write')` (currently only checks `locals.user` exists)

### Notes
These API endpoints are called by the frontend (AJAX/fetch). They rely on the session cookie for authentication (same as page routes). The `locals.user` check covers authentication, but authorization (permission check) is missing.

### Acceptance Criteria
- BOM search requires `inventory:read`
- Inventory transactions API requires `inventory:read`
- Kanban move API requires `kanban:write`
- All three return 403 (not 500) when permission is denied
