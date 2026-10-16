# Consumer cartridge ownership — BIMS ↔ bioscale-app contract

**Status:** built 2026-10-15 on `feat/consumer-ownership` (BIMS) and `feat/cartridge-ownership` (bioscale-app).
**Decisions (2026-10-15):** clinic customers see their patients' results in the app and never use BIMS;
an account may claim a cartridge that was never shipped to it; cartridges are scanned in with the
phone camera and assigned an owner from the app.

Both apps share one Atlas database (`bioscale`). BIMS owns a cartridge from birth through shipping;
the brevitest-cloud Lambda owns the run-side fields (`rawData`, `analysis`, `statusUpdatedOn`);
the consumer app reads `cartridge_records` with the raw driver and must never write it. This
document is the one place that says **who may write what**, and the shapes both sides depend on.

## Entities

| Entity | Collection | Owner (writer) | Key |
| --- | --- | --- | --- |
| Customer | `customers` | BIMS | `_id` (nanoid) — the purchasing/shipping party: a clinic, or a person |
| Account | `app_users` | bioscale-app | `_id` = `${provider}:${sub}` — a sign-in identity. **Never key on email.** |
| Subject | `subjects` | bioscale-app | `_id` (nanoid) — the person whose blood is in the cartridge; a consumer's own self-subject, or a clinic's patient. Patient names are PHI and stay here. |
| Customer ↔ account link | `customer_accounts` | BIMS | `(customerId, accountId)` unique; `role` ∈ admin, staff, member; `status` ∈ active, revoked |
| Invite | `consumer_invites` | BIMS | `tokenHash` (SHA-256; token shown once); `role`; 7-day expiry |
| **Ownership** | `cartridge_ownership` | **BIMS only** | one **open** row per cartridge (partial unique index) |
| Claim attempts | `consumer_claim_attempts` | BIMS | per-account rate limiting; TTL 24 h |

Read-only mirror models in BIMS: `AppUser` (`app_users`), `AppSubject` (`subjects`) — `strict: false`,
never written.

### `cartridge_ownership` row

```
_id, cartridgeId,              // cartridge_records._id — the QR sticker payload
accountId | null,              // owning account (personal row); null on a clinic row
customerId | null,             // clinic scope; set on shipment rows and clinic claims
subjectId | null,              // app-owned patient; null = account holder / unassigned
source: shipment | claim | device | operator,
matchedShipment: bool,         // recorded, NOT enforced (see Eligibility)
shipmentCustomerId | null,
open: bool, claimedAt, claimedBy {kind: account|operator|system, id, label},
releasedAt, releasedBy, releaseReason: user|operator|reassigned|transfer, releaseNote
```

**Visibility rule (app):** an account sees a cartridge when the open row has `accountId == me`, or
`customerId ∈ my active customer links`. Clinic roles additionally filter by `subjectId`.

## How a row gets created

1. **Shipment** (BIMS, `shipping` page `addCartridgeToPackage`): the package's customer has
   exactly one active account → personal row for that account; several accounts (a clinic) →
   customer-scoped row with no account/patient (the app's *unassigned* bin); none → no row.
2. **Claim** (app → BIMS consumer API): the person scans or types the cartridge code; the app
   previews it, then confirms. Personal claim → `accountId = me`; clinic claim →
   `customerId = chosen clinic`, `subjectId = chosen patient or null`.
3. **Device** (reserved): brevitest-cloud stamping a paired reader's account at upload. Not built.
4. **Operator** (BIMS DHR page): release only; operators do not create rows by hand.

### Eligibility (`claimEligibility`, `src/lib/server/consumer/ownership.ts`)

Refused, in order: cartridge not found · voided/scrapped/cancelled · QC cartridge
(`ShippingLot.qaqcReleases.qaqcCartridgeIds` or `usedForTestFill`) · belongs to a research
`experiment` (unless one of the claimer's customers has `customerType: 'internal'`) · already has an
open row · **guessable id** (`CART-000123`-style) without a shipment match. UUID ids never need a
shipment match — the decision that unshipped cartridges are claimable — but the match is recorded
and unmatched claims appear on `/cartridge-admin/ownership`. A cartridge that already ran is
claimable; its results become visible on claim. 30 attempts per account per hour, then 429.

## Consumer API (BIMS, `src/routes/api/consumer/*`)

Auth: `x-consumer-api-key: $CONSUMER_API_KEY` (or `Authorization: Bearer`). Separate from
`AGENT_API_KEY` so it rotates independently. Every call carries the acting `accountId` and the
account's active `customerIds` (the app reads `customer_accounts` directly); BIMS re-checks what it
must (admin role for invites, scope for release/assign).

| Call | Purpose |
| --- | --- |
| `GET /api/consumer/cartridges/:id?accountId=&customerIds=a,b` | Preview: assay, expiry, stage (ready/used/expired/unavailable), `owned` (never by whom), `ownedByYou`, `matchedShipment`, `eligible`, `reason` |
| `POST /api/consumer/claims` `{cartridgeId, accountId, accountLabel, customerIds?, customerId?, subjectId?}` | Create the open row. 201 / 404 / 409 / 403 (guessable) / 429 |
| `POST /api/consumer/claims/release` `{cartridgeId, accountId, accountLabel, customerIds?, note?}` | Close the row (only rows the account can see) |
| `POST /api/consumer/claims/assign` `{cartridgeId, accountId, accountLabel, customerId, subjectId|null, customerIds}` | Move a clinic-owned cartridge between patients |
| `POST /api/consumer/invites/accept` `{token, accountId, email}` | Link the account to the invite's customer; sign-in email must match the invited address |
| `POST /api/consumer/invites` `{customerId, email, role: admin|staff, accountId, accountLabel}` | Clinic admin invites a colleague from the app (returns the token once; the app emails it) |
| `GET /api/consumer/invites?customerId=&accountId=` | Pending invites, admins only |

Every write produces an `audit_log` entry (`tableName` = the collection written).

## What the app reads directly

`cartridge_records` (unchanged), `samples`, `experiments`, `cartridge_ownership`,
`customer_accounts`, `customers` (name only). It writes only `app_users` and `subjects`.
Recommended Atlas user for the app: readWrite on those two, read on the rest.

## Onboarding a clinic

1. BIMS: create the Customer; on its page, **App access → Create invite** with role *Clinic admin*.
   Send the link shown (valid 7 days, shown once).
2. App: the admin signs in with the same email and opens the link → linked. From then on the admin
   invites staff and manages patients inside the app; BIMS is not involved.
3. Shipments to that customer land in the clinic's unassigned bin; staff scan or pick them and
   assign a patient.

A plain consumer needs no invite: they sign in and scan their kit. An invite with role *Member*
links them to a Customer so that future shipments to that customer are theirs automatically.

## BIMS surfaces

- `/customers/[id]` — App access card: linked accounts, pending invites, create/revoke.
- `/cartridge-admin/dhr/[cartridgeId]` — Consumer ownership card with history and operator release.
- `/cartridge-admin/ownership` — report; default filter is claims with no matching shipment.

## Environment

BIMS: `CONSUMER_API_KEY`, `BIOSCALE_APP_URL`. App: `BIMS_BASE_URL`, `BIMS_CONSUMER_API_KEY`,
`RESULTS_SCOPE` (`owned` default; `all` keeps the pre-ownership behaviour for UI testers).

## Account management (BIMS `/app-accounts`, 2026-10-16)

Developers and staff manage consumer accounts from BIMS, never from a special account in the
app. The app has no administrator role and never will; everything an operator needs to do to an
account is a write to a BIMS-owned collection.

- `/app-accounts` — every `app_users` row (read-only mirror), searchable by email, name or id;
  filters for accounts not linked to any customer, clinic roles, and blocked. Permission
  `customer:read`.
- `/app-accounts/[accountId]` — identity (read-only; the app owns the profile), **Access**
  (block / unblock with a reason), **Customers** (link to a customer with a role, revoke),
  cartridges linked to the account and those visible through its clinic roles (release), invites
  sent to its email, claim attempts in the last 24 h. Writes need `customer:write`; every one is
  audit-logged.
- **Blocking**: BIMS writes `app_account_blocks` (`_id` = app_users._id, reason, blockedBy,
  blockedAt). The app's `hooks.server.ts` looks the id up on every request and, if present, drops
  the session and sends the person to `/login?blocked=1`. Nothing is deleted; unblocking deletes
  the row and the account works again.
- Not built: "view the app as this person". If it is ever needed it should be a short-lived
  token minted by BIMS and honoured by the app for a read-only view, never a shared password.
