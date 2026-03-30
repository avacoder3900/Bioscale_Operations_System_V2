# Future Security Hardening — Audit Logging & Rate Limiting

**Status:** Documented for future implementation. Not blocking current development.
**Created:** Mar 24, 2026

---

## 1. Audit Logging on Admin Mutations

### Problem
The admin user/role management pages perform 12 mutation actions with zero AuditLog entries. In an FDA-regulated environment (21 CFR Part 11), every change to user access must be traceable.

### Actions missing audit logging

**User management** (`src/routes/spu/admin/users/+page.server.ts`):
- `createUser` — who created which account and when
- `updateProfile` — who changed a user's name/email/phone
- `deactivateUser` — who deactivated which account
- `reactivateUser` — who reactivated which account
- `resetPassword` — who reset whose password (do NOT log the password itself)
- `assignRole` — who changed whose role to what
- `removeRole` — who revoked which role from whom
- `sendInvite` — who invited which email

**Role management** (`src/routes/spu/admin/roles/+page.server.ts`):
- `createRole` — who created a new role with which permissions
- `updateRole` — who renamed/updated a role
- `deleteRole` — who deleted a role (and which users were affected)
- `setPermissions` — who changed which permissions on which role

### Implementation pattern
Each action needs ~5 lines added after the mutation:
```typescript
await AuditLog.create({
    _id: generateId(),
    tableName: 'users',        // or 'roles'
    recordId: userId,           // the affected record
    action: 'UPDATE',           // CREATE, UPDATE, DELETE
    oldData: { roles: previousRoles },
    newData: { roles: newRoles },
    changedBy: locals.user.username
});
```

### Estimate
~12 actions, ~5 lines each. One focused session. Low complexity, high compliance value.

---

## 2. Login Rate Limiting

### Problem
The login endpoint (`src/routes/login/+page.server.ts`) allows unlimited password attempts. No lockout, no backoff, no CAPTCHA.

### Risk assessment
- The app is deployed on Vercel (internet-facing)
- Passwords have no strength requirements (another issue to address)
- No monitoring or alerting on failed login attempts
- Acceptable risk during internal development, must be fixed before production use with external users

### Implementation options

**Option A: Database-backed lockout (simplest)**
Track failed attempts in a `login_attempts` collection or directly on the user document:
```typescript
// On failed login:
await User.updateOne({ _id: user._id }, {
    $inc: { failedLoginAttempts: 1 },
    $set: { lastFailedLoginAt: new Date() }
});

// Before password check:
if (user.failedLoginAttempts >= 5 &&
    Date.now() - user.lastFailedLoginAt < 15 * 60 * 1000) {
    return fail(429, { error: 'Account locked. Try again in 15 minutes.' });
}

// On successful login:
await User.updateOne({ _id: user._id }, {
    $set: { failedLoginAttempts: 0 }
});
```

**Option B: Vercel Edge rate limiting**
Use Vercel's built-in rate limiting middleware on the `/login` route. No code changes needed — configured in `vercel.json`. Limits by IP address.

**Option C: Both (recommended for production)**
Database lockout per-username + Vercel edge rate limiting per-IP. Covers both credential stuffing (many usernames from one IP) and distributed brute force (one username from many IPs).

### Related: Password strength validation
When implementing rate limiting, also add minimum password requirements:
- Minimum 8 characters
- At least one letter and one number
- Apply to: createUser, resetPassword, invite accept

### Estimate
Option A: ~30 minutes. Option B: configuration only. Option C: ~1 hour.

---

## 3. Other Medium-Priority Items (for reference)

These were identified during the security audit but are lower priority:

| Issue | Fix | Effort |
|-------|-----|--------|
| `removeRole` only revokes first roleHistory entry | Change `$` to `arrayFilters` | 5 min |
| `deleteRole` doesn't stamp roleHistory revocation | Add revocation timestamp update | 10 min |
| Login error leaks server internals | Change to generic error message | 1 min |
| No password strength validation | Add validation to 3 actions | 15 min |
