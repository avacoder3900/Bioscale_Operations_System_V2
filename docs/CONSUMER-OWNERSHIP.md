# Consumer cartridge ownership — BIMS ↔ bioscale-app contract

**Status:** built 2026-10-15 on `feat/consumer-ownership` (BIMS) and `feat/cartridge-ownership` (bioscale-app);
scan-in removed and operator assignment added 2026-10-16 (`feat/assigned-cartridges` in both repos).
**Decisions:** clinic customers see their patients' results in the app and never use BIMS (2026-10-15).
**People never scan cartridges in the app (2026-10-16):** a cartridge is assigned to its owner in BIMS —
by staff on the App Accounts or DHR pages, or automatically when it is shipped to a customer with a
linked account — and the person receives a cartridge that is already theirs. The app-side claim flow and
its BIMS endpoints are gone; rows with `source: 'claim'` are history from before that date.

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
| Account type / clinic enrollment | `app_account_settings` | BIMS | `_id` = app_users._id; `accountType` ∈ individual, clinic, dev; `clinicAccountId` (individuals only). No row = individual, not enrolled |

Read-only mirror models in BIMS: `AppUser` (`app_users`), `AppSubject` (`subjects`) — `strict: false`,
never written — with one temporary exception: **dev accounts** (`dev:<slug>` rows in `app_users`) are
created and deleted by BIMS; see "View as and dev accounts" below.

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
`accountId ∈ the individuals enrolled under me` (clinic type), or `customerId ∈ my active customer
links`. A dev-type account sees every result. Clinic roles additionally filter by `subjectId`.
See "Account types" below.

## How a row gets created

1. **Shipment** (BIMS, `shipping` page `addCartridgeToPackage`): the package's customer has
   exactly one active account → personal row for that account; several accounts (a clinic) →
   customer-scoped row with no account/patient (the app's *unassigned* bin); none → no row.
2. **Operator** (BIMS, `assignOwnership` in `src/lib/server/consumer/ownership.ts`): staff type a
   cartridge id on `/app-accounts/[accountId]` (personal row for that account) or an account's email
   on the cartridge's DHR page. Refused when the cartridge does not exist, is voided/scrapped, or is a
   QC cartridge (`ShippingLot.qaqcReleases.qaqcCartridgeIds` / `usedForTestFill`); research
   cartridges are allowed. An existing open row is refused unless *replace* is ticked, which closes it
   with `releaseReason: 'reassigned'` first. `matchedShipment` is recorded (shipment customer ∈ the
   account's customers) for the report, never enforced. Audit action `ASSIGN_OWNERSHIP`.
3. **Device** (reserved): brevitest-cloud stamping a paired reader's account at upload. Not built.
4. ~~**Claim**~~ (removed 2026-10-16): the app's scan/claim flow and the `POST /api/consumer/claims`
   + `GET /api/consumer/cartridges/:id` endpoints are deleted, along with the `consumer_claim_attempts`
   collection. `claimEligibility` stays in the service only for its unit tests and as the record of the
   old rules; nothing calls it.

## Consumer API (BIMS, `src/routes/api/consumer/*`)

Auth: `x-consumer-api-key: $CONSUMER_API_KEY` (or `Authorization: Bearer`). Separate from
`AGENT_API_KEY` so it rotates independently. Every call carries the acting `accountId` and the
account's active `customerIds` (the app reads `customer_accounts` directly); BIMS re-checks what it
must (admin role for invites, scope for release/assign).

| Call | Purpose |
| --- | --- |
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
3. Shipments to that customer land in the clinic's unassigned bin; staff pick them on the Patients
   page and assign a patient.

A plain consumer signs in and sees the cartridges that were assigned to them — by a shipment to
their linked Customer, or by staff on App Accounts / DHR. They never scan anything. An invite with
role *Member* links them to a Customer so that future shipments to that customer are theirs
automatically.

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
- **Results email** (2026-10-19): the Identity card has *Change results email*. It sets
  `app_users.bioscaleEmail` with `bioscaleEmailVerifiedAt` = now (staff vouch for it), clears any
  `pending` verification link and records `bioscaleEmailSetBy`; empty clears it, so the app falls
  back to the sign-in email (`dataEmail()`). The sign-in email is not editable: the app rewrites it
  from the identity provider on every sign-in, and the account is keyed by `provider:sub`, not
  email. If the person later changes the address in the app, the app's own verification rules apply.
- **Bulk assign** (2026-10-19): the account page's assign box is a textarea — scan cartridges one
  after another (each scan lands on its own line; spaces, commas or semicolons also separate), up to
  200 at a time. A token carrying a UUID (a QR URL) is reduced to it; duplicates are dropped. Each id
  goes through `assignOwnership` on its own and the page lists the outcome per cartridge, so one bad
  id never stops the rest.
- **Assigning cartridges** (2026-10-16): the account page has an *Assign a cartridge* form (cartridge
  id, optional note, *replace current owner*); the DHR page has the mirror form (account email or id).
  Both call `assignOwnership` — see "How a row gets created".

## View as and dev accounts (temporary developer door, 2026-10-16)

Built so staff can see the app from a user's point of view without a shared password. Everything
below is marked for removal in both codebases; nothing else depends on it.

- **View as** — on `/app-accounts/[accountId]`, *Open the Bioscale app as this person* (needs
  `customer:write`, `CONSUMER_API_KEY` and `BIOSCALE_APP_URL`). BIMS mints a 2-minute HS256 JWT
  signed with `CONSUMER_API_KEY` (`iss: bims`, `aud: bioscale-app`, `purpose: view-as`, `sub:
  accountId`, `actor: username`; `src/lib/server/consumer/view-as.ts`) and redirects a new tab to the
  app's `/auth/impersonate?token=`. The app verifies it (`src/lib/server/impersonation.ts`) and, for a
  real person's account, issues a **read-only 30-minute session** (`impersonatedBy` in the session;
  `requireWritableUser()` refuses every write; amber banner with *End view*). The sign-in is written to
  the BIMS audit log by the action and announced by the banner.
- **Dev accounts** — `/app-accounts` → *Create a dev account* writes an `app_users` row
  `dev:<slug>` (`provider: dev`, sign-in email `<slug>@dev.bioscale.app`, `devAccount: {createdBy,
  createdAt}`); this is the one place BIMS writes that collection. Nobody can sign in to it from the
  app's login page; it is opened only through *view as*, which for a `dev:` account issues a **normal,
  writable session** (there is no real person behind it) so profile edits, patients and results can
  be tried end to end. Assign cartridges to it like any account. *Remove dev account* on its page
  releases its cartridges, revokes its links, drops any block and deletes the row
  (`deleteDevAccount`, refuses non-`dev:` ids).
- **To remove the door:** BIMS — `view-as.ts`, the `viewAs` action/card, the dev-account section of
  `consumer/accounts.ts` and its forms. App — `impersonation.ts`, `routes/auth/impersonate`, the banner
  in `+layout.svelte`, `impersonatedBy` on the session and `requireWritableUser()`.

## Account types (2026-10-16)

Every app account has one of three types, set in BIMS on `/app-accounts/[accountId]` (dropdown,
`customer:write`). BIMS writes `app_account_settings`; the app reads it on every request
(`accessFor` in `src/lib/server/access.ts`) and never writes it. **No row means Individual**, so
every new account starts as Individual without either side doing anything at sign-up.

| Type | Sees in the app |
| --- | --- |
| **Individual** (default) | The cartridges assigned to it. |
| **Clinic** | Its own cartridges, plus those of every Individual account enrolled under it. The home-page picker lists each enrolled person (`?view=account:<accountId>`). |
| **Dev** | Every result in the app (the list is unscoped, like `RESULTS_SCOPE=all`, but only for this account). Granting or removing Dev needs a BIMS admin (`isAdmin`), because it exposes every user's results. |

Enrollment: on an Individual account's page, **Enroll under a clinic** picks any Clinic-type account
(moving it if already enrolled); **Remove from clinic** clears it. A Clinic account's page lists its
enrolled accounts, each with *Remove from clinic*. Enrollment is optional. Rules (all in
`src/lib/server/consumer/accounts.ts`): only Individuals can be enrolled; a Clinic that still has
enrolled accounts cannot change type until they are removed; an Individual that becomes Clinic or
Dev leaves its clinic. Every change writes an `audit_log` entry with `tableName:
'app_account_settings'` (`SET_ACCOUNT_TYPE`, `ENROLL_IN_CLINIC`, `REMOVE_FROM_CLINIC`).

Clinic and Dev visibility is read-only: the BIMS release/assign endpoints still check the original
rule (own row or customer scope), so a clinic cannot release or move an enrolled person's cartridge.

This sits beside the Customer-based clinic model above (customer links with admin/staff roles,
patients as subjects), which is unchanged. The temporary `dev:<slug>` test logins are a different
thing from the Dev *type*: they start as Individual like any account, and their list filter is
labelled "Test logins (dev:)".
