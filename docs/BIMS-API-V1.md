# BIMS API v1

Endpoints the customer apps (bioscale-app, bioscale-business, later the store) call instead
of holding a database login. The cartridge endpoints were built 2026-11-16 on branch
`feat/bims-api-v1`; the reader endpoints 2026-11-17 on `feat/bims-api-readers` (see [Readers](#readers)).

| Endpoint | Does |
| --- | --- |
| `GET /api/v1/cartridges/{id}` | Check: is the cartridge real, unused, in date, not voided, not QC, not research; which assay and analyte; lot |
| `POST /api/v1/cartridges/{id}/link` | Make the cartridge `linked` for one holder, so a reader will run it |
| `POST /api/v1/cartridges/{id}/unlink` | Undo that link, by the same holder, before a run |
| `GET /api/v1/cartridges/{id}/result` | Run state, start and end times, the result in ng/mL, quality flags, provenance |
| `POST /api/v1/readers/pair` | Pair a reader with a holder, from the code scanned or typed off it |
| `POST /api/v1/readers/{serial}/unpair` | Release a reader this holder holds |
| `GET /api/v1/readers/{serial}` | The held reader: online, firmware, whether it can change Wi-Fi |
| `GET /api/v1/readers/{serial}/wifi` | The held reader's Wi-Fi state and last scan, live |
| `POST /api/v1/readers/{serial}/wifi` | Scan for networks, or switch the reader to one |

Code: `src/lib/server/bims-api/` (auth, rules, reducers, rate limit, database operations) and
`src/routes/api/v1/`. The cartridge code imports nothing from the rest of `$lib/server` except the
database connection and models; the reader code (`readers.ts`) also imports the Particle client and
the operator Wi-Fi functions (`spu-wifi.ts`), so the device contract lives in one place.

## Conventions

- JSON in, JSON out, on every status including errors. Responses carry `Cache-Control: no-store`.
- Timestamps are ISO-8601 UTC strings (`2026-11-10T15:04:05.000Z`).
- `{id}` is the cartridge id: a UUID (the QR payload), a BIMS id such as `CART-000123`, or another
  8–40 character token of letters, digits, `_` and `-`. Anything else is a 400.
- `holderRef` is the opaque name the app gives the account that holds the cartridge. It must match
  `^h_[A-Za-z0-9_-]{16,64}$`. BIMS stores it as `app:<holderRef>` and never learns who it is.
- Nothing in a request, response, log line or audit row carries an email, a name or an account id.
  The link and unlink bodies accept `holderRef` and no other field; a body with any other field is
  a 400.

## Auth

```
Authorization: Bearer <key>
```

| Variable | Calling app (in `via` and audit rows) |
| --- | --- |
| `BIMS_API_KEY_CONSUMER` | `bioscale-app` |
| `BIMS_API_KEY_BUSINESS` | `bioscale-business` |
| `BIMS_API_KEY_STORE` | `bioscale-store` |

- Each variable is optional. An unset key is never accepted. A value shorter than 24 characters is
  treated as unset.
- Only the `Authorization: Bearer` header is read. `x-consumer-api-key`, `x-agent-api-key` and
  query-string keys are ignored.
- These keys work only under `/api/v1/`: no other route reads the variables. The agent, consumer
  and cron keys do not work here; if a v1 variable is set to the same value as `AGENT_API_KEY`,
  `CONSUMER_API_KEY` or `CRON_SECRET`, it is ignored.
- Comparison is timing-safe (SHA-256 digests compared with `timingSafeEqual`).
- A missing or wrong key is `401 { "message": "Invalid or missing API key" }`.

## Rate limits

Per minute, counted per calling app and, when the request names one, per `holderRef`:

| Endpoint | Per holderRef | Per app |
| --- | --- | --- |
| check | 60 | 600 |
| link | 20 | 200 |
| unlink | 20 | 200 |
| result | 120 | 1200 |
| reader pair | 10 | 100 |
| reader unpair | 10 | 100 |
| reader GET | 60 | 600 |
| reader Wi-Fi GET | 60 | 600 |
| reader Wi-Fi scan | 6 | 60 |
| reader Wi-Fi connect | 6 | 60 |

Over either limit: `429 { "message": "Too many requests" }` with `Retry-After: <seconds>` (the time
to the next minute boundary).

How it works and what it does not do:

- Counters live in the `bims_api_rate_limits` collection (`_id` = endpoint, subject and window
  start; `count`; `expiresAt`), one atomic increment per counter, so the limit holds across
  serverless instances.
- Fixed one-minute windows. A caller can spend one window's allowance at the end of a minute and
  the next at the start of the following minute.
- It fails open: if the counter cannot be written, the request proceeds.
- Rows expire through a TTL index on `expiresAt`. BIMS does not create indexes at boot; run
  `npx tsx --tsconfig tsconfig.json scripts/ensure-indexes.ts --apply` once after deploy. Until
  then about one request in a hundred also deletes expired rows, so the collection stays small.
- Check without `holderRef` is limited per app only.

## Errors

| Status | Body | When |
| --- | --- | --- |
| 400 | `{ "message": "Not a cartridge id" }` | `{id}` fails the id pattern |
| 400 | `{ "message": "holderRef is required and must look like h_…" }` | `holderRef` missing or malformed (body of link/unlink, query of result; query of check when present) |
| 400 | `{ "message": "Invalid JSON body" }` | Link/unlink body is not a JSON object, or is over 2 kB |
| 400 | `{ "message": "Only holderRef is accepted in the body" }` | Link/unlink body has another field |
| 401 | `{ "message": "Invalid or missing API key" }` | See Auth |
| 404 | endpoint-specific, `reason: "not_found"` | See each endpoint |
| 409 | `{ "ok": false, "reason": "…" }` | Link or unlink refused |
| 429 | `{ "message": "Too many requests" }` + `Retry-After` | See Rate limits |
| 500 | `{ "message": "Internal error" }` | Unexpected failure. The log line names the endpoint and the error class only |

Refusal reasons (check `reason`, link 409/404 `reason`):

| Reason | Meaning | Check `state` |
| --- | --- | --- |
| `not_found` | No record with this id | (404) |
| `has_results` | The record carries run data (`rawData` or `reading`), or `used` is true | `finished` |
| `in_use` | Status `underway`: a reader is running it. Link also returns this if the record changed twice during the request | `running` |
| `voided` | `voidedAt` is set, or status `voided` or `scrapped` | `unavailable` |
| `unavailable` | Status `completed` or `cancelled` with no run data | `unavailable` |
| `qc_cartridge` | Pulled for QA/QC release testing (`shipping_lots.qaqcReleases.qaqcCartridgeIds`) or `usedForTestFill` | `unavailable` |
| `research` | `experiment` is set | `unavailable` |
| `no_assay` | `assayId` is blank or `"0"` | `unavailable` |
| `expired` | `reagentFilling.expirationDate ?? expirationDate` is in the past | `unavailable` |
| `linked_by_other` | Status `linked` and `checkpoints.linked.who` is not this holder (or the request named no holder) | `linked` |

The rules are evaluated in the order of the table; the first that applies is the answer.

## Check

```
GET /api/v1/cartridges/3f6c1c1e-0a1b-4c2d-8e3f-9a8b7c6d5e4f?holderRef=h_8Kq2mXw0aB3dE5fG7hJ9kL1n
Authorization: Bearer <key>
```

`holderRef` is optional. With it, a cartridge already linked by that holder reads as usable.

```
200
{
  "cartridgeId": "3f6c1c1e-0a1b-4c2d-8e3f-9a8b7c6d5e4f",
  "usable": true,
  "reason": null,
  "state": "ready",
  "assay": { "id": "A56E0F5A", "name": "Cortisol - 6.1" },
  "analyte": "cortisol",
  "expiresOn": "2027-01-31T00:00:00.000Z",
  "lot": { "fillLotId": "…", "fillLotNumber": "…", "reagentLotId": "…", "reagentLotNumber": "…" }
}

200  (not usable)
{ "cartridgeId": "…", "usable": false, "reason": "expired", "state": "unavailable", "assay": {…}, "analyte": "cortisol", "expiresOn": "…", "lot": {…} }

404
{ "cartridgeId": "…", "usable": false, "reason": "not_found" }
```

- `state`: `ready` (can be linked), `linked` (linked; `usable` is true only for the holder named),
  `running`, `finished`, `unavailable`.
- `assay.id`, `assay.name`: the record's `assayId`, `assayName`; null when absent.
- `analyte`: `"cortisol"` when `assayName` starts with "Cortisol", otherwise null. A null analyte
  does not make the cartridge unusable here; the app decides whether it supports the assay.
- `expiresOn`: `reagentFilling.expirationDate ?? expirationDate` as an instant; null when neither
  is set or parseable.
- `lot`: `reagentFilling.fillLotId`, `fillLotNumber`, `reagentLotId`, `reagentLotNumber`; null
  where absent.

Reads: named fields of one `cartridge_records` document (run data as a presence flag only) and one
existence check on `shipping_lots`. Writes: a rate-limit counter. Never returned: manufacturing
status, run data, customer, shipping, sample or experiment fields.

## Link

```
POST /api/v1/cartridges/3f6c1c1e-0a1b-4c2d-8e3f-9a8b7c6d5e4f/link
Authorization: Bearer <key>
Content-Type: application/json

{ "holderRef": "h_8Kq2mXw0aB3dE5fG7hJ9kL1n" }
```

```
201 { "ok": true, "status": "linked", "linkedAt": "2026-11-10T15:04:05.000Z" }
200 { "ok": true, "status": "already" }                    // this holder already holds it; nothing written
404 { "ok": false, "reason": "not_found" }
409 { "ok": false, "reason": "has_results" | "in_use" | "voided" | "unavailable" | "qc_cartridge" | "research" | "no_assay" | "expired" | "linked_by_other" }
```

Same eligibility as check. On success it writes exactly this to the `cartridge_records` document:

```
status:              "linked"
statusUpdatedOn:     <now, ISO string>
priorStatus:         <the status that was read>
checkpoints.linked:  { who: "app:<holderRef>", when: <now>, where: {}, via: "bioscale-app" | "bioscale-business" | "bioscale-store" }
```

The update matches on `_id`, the status that was read, `rawData` and `reading` absent, and
`finalizedAt` unset. If it does not match (the record changed in between) the record is read and
judged again, once; a second miss is `409 in_use`. So a cartridge a reader has started is never
rewound, and two holders cannot both link one cartridge. `updatedAt` is not touched.

One `audit_log` row per link: `tableName: "cartridge_records"`, `recordId: <id>`, `action: "LINK"`,
`changedBy: "api:<app>"`, `oldData: { status }`, `newData: { status: "linked", priorStatus, holderRef }`.
`already` and refusals write no row.

Repeats are safe without an idempotency key: the same holder linking again gets `200 already`. An
`Idempotency-Key` header is accepted and ignored.

Who holds what: BIMS only prevents two different holders linking one cartridge. It keeps no
ownership record for this API; the apps keep their own.

A link the customer apps wrote directly before this API (`checkpoints.linked.who` equal to the
bare `h_…`, without `app:`) counts as the same holder.

## Unlink

```
POST /api/v1/cartridges/3f6c1c1e-0a1b-4c2d-8e3f-9a8b7c6d5e4f/unlink
Authorization: Bearer <key>
Content-Type: application/json

{ "holderRef": "h_8Kq2mXw0aB3dE5fG7hJ9kL1n" }
```

```
200 { "ok": true, "status": "unlinked", "restoredStatus": "shipped" }
200 { "ok": true, "status": "not_linked" }                 // not linked and never run; nothing written
404 { "ok": false, "reason": "not_found" }
409 { "ok": false, "reason": "linked_by_other" }           // linked, by a different holder
409 { "ok": false, "reason": "has_results" }               // run data present, or status underway / completed / cancelled
```

Only the holder that linked it, only while the status is `linked` and there is no run data. It
sets `status` to the stored `priorStatus` and `statusUpdatedOn` to now, and removes `priorStatus`
and `checkpoints.linked`. The update matches on `_id`, status `linked`, the same
`checkpoints.linked.who`, no run data; one retry. The record is never deleted. `restoredStatus` is
null if the record had no status before it was linked (the field is then removed).

One `audit_log` row: `action: "UNLINK"`, `changedBy: "api:<app>"`, `oldData: { status: "linked",
priorStatus }`, `newData: { status, holderRef }`.

## Result

```
GET /api/v1/cartridges/3f6c1c1e-0a1b-4c2d-8e3f-9a8b7c6d5e4f/result?holderRef=h_8Kq2mXw0aB3dE5fG7hJ9kL1n
Authorization: Bearer <key>
```

`holderRef` is required (400 without it). The answer is `404 { "reason": "not_found" }` unless the
record exists and its `checkpoints.linked.who` is `app:<holderRef>` (or the bare `h_…` from before
the API). A missing record and someone else's record look the same, so an app key cannot be used
to read results by guessing ids. Pass the holderRef of the account that linked the cartridge.

All states answer 200.

```
200  (not finished)
{ "cartridgeId": "…", "state": "linked",    "startedAt": null }
{ "cartridgeId": "…", "state": "running",   "startedAt": "2026-11-10T14:31:02.000Z" }
{ "cartridgeId": "…", "state": "running",   "startedAt": "…", "detail": "analysis_pending" }
{ "cartridgeId": "…", "state": "cancelled", "startedAt": "…" }

200  (finished)
{
  "cartridgeId": "3f6c1c1e-0a1b-4c2d-8e3f-9a8b7c6d5e4f",
  "state": "completed",
  "startedAt": "2026-11-10T14:31:02.000Z",
  "completedAt": "2026-11-10T15:01:40.000Z",
  "assay": { "id": "A56E0F5A", "name": "Cortisol - 6.1" },
  "result": {
    "analyte": "cortisol",
    "value": 12.4,
    "unit": "ng/mL",
    "status": "ok",
    "reportedWells": ["A"],
    "wells": [ { "well": "A", "value": 12.4, "status": "ok", "qcPass": true, "flags": [] } ],
    "qualityFlags": []
  },
  "provenance": {
    "fillLotId": "…", "fillLotNumber": "…", "reagentLotId": "…", "reagentLotNumber": "…",
    "curve": { "id": "…", "version": 3, "source": "own" },
    "calculation": {
      "engineVersion": "2.6.0", "profileId": "…", "profileName": "Cortisol 6.1", "profileVersion": 7,
      "computedAt": "2026-11-10T15:01:45.000Z", "quantifiedAt": "2026-11-10T15:01:46.000Z"
    },
    "reader": { "serial": "…", "firmwareVersion": "103", "opticsCalibrationVersion": null }
  }
}

404 { "reason": "not_found" }
```

### State

| Record status | `state` | `detail` |
| --- | --- | --- |
| `linked` | `linked` | — |
| `underway` | `running` | — |
| `completed`, analysed, assay reported | `completed` | — |
| `completed`, no `analysis.schemaVersion: 2` block yet | `running` | `analysis_pending` |
| `completed`, assay not one the API reports | `running` | `assay_unsupported` |
| `cancelled` | `cancelled` | — |
| anything else (voided, scrapped, or moved by a manufacturing page after the link) | `cancelled` | `not_linked` |

A run is `completed` here only when the apps may show it: the same rule as the apps' `VISIBLE`
filter (a v2 analysis block, an assay name the analyte table matches). The apps' third condition, a
start date for the testing dataset (`RESULTS_SINCE`), is not applied: the holderRef match already
limits the endpoint to cartridges an app linked.

`startedAt` is `checkpoints.underway.when` (null if absent). `completedAt` is
`checkpoints.completed.when`, else `statusUpdatedOn`.

### Result

The stored `analysis` block is read; nothing is recomputed. Only the analyte's reported wells
count (cortisol: well A). A well that is not reported contributes no value, status, QC verdict or
flag, whatever it holds.

- `value`: the median of the reported wells whose `quant.status` is `ok` and whose QC passed
  (`qc.pass` absent counts as passed), in ng/mL. Null unless `status` is `ok`.
- `status`, first that applies:
  1. `unit_unsupported`: a reported well carries a number whose unit cannot be turned into ng/mL
  2. `ok`: at least one reported well passed
  3. `below_range`: a reported well's `quant.status` is `below_range`
  4. `above_range`: a reported well's `quant.status` is `above_range`
  5. `qc_fail`: every reported well present failed QC, or one has `quant.status` `no_readout`
  6. `not_calibrated`: anything else (no curve, no lot, engine error, no wells stored)
- `reportedWells`: the analyte's reported wells.
- `wells`: one entry per reported well present on the record. `value` is the well's stored
  `quant.value` in ng/mL (for a well out of range this is the curve's clamp bound when it has one;
  null when there is no number). `status` is the well's own `quant.status` as stored (`ok`,
  `below_range`, `above_range`, `no_curve`, `no_lot`, `no_readout`, `error`). `qcPass` is
  `qc.pass` (true when absent). `flags` are the well's `qc.flags[].key`.
- `qualityFlags`: the `qc.flags[].key` strings of the reported wells, as stored, de-duplicated, in
  well order. The same list the apps' `storedResult().flags` returns.

Units. `quant.unit` is read for every reported well that has a number. `ng/mL` and `µg/L` are
taken as they are; `µg/dL` (×10), `ng/dL` (×0.01), `pg/mL` (×0.001) and `µg/mL` (×1000) are
converted; spelling is case-insensitive and `µ`, `μ` and `u` are the same. Any other unit, a molar
unit, or a missing or empty unit gives `status: "unit_unsupported"` with `value: null` and null
well values. A number is never relabelled. Every active curve carried `ng/mL` on 2026-11-16.

### Provenance

| Field | Source | Null when |
| --- | --- | --- |
| `fillLotId`, `fillLotNumber`, `reagentLotId`, `reagentLotNumber` | `reagentFilling.*` | not stamped at fill |
| `curve.id`, `.version`, `.source` | `quant.curveId`, `curveVersion`, `curveSource` of the first reported well | no curve; `source` on results from engines before it was written |
| `calculation.*` | `analysis.engineVersion`, `profileId`, `profileName`, `profileVersion`, `computedAt`, `quantifiedAt` | absent on the block |
| `reader.serial` | `testExecution.spu.udi`, else the `udi` of the `spus` document whose `particleLink.particleDeviceId` equals the record's `device.id` | no device on the record, or no SPU linked to it |
| `reader.firmwareVersion` | `device.firmware_version`, else `testExecution.spu.firmwareVersion`, as a string | neither stored |
| `reader.opticsCalibrationVersion` | no source exists | always |

Reads: named fields of one `cartridge_records` document (for wells A, B and C: `qc.pass`,
`qc.flags.key` and six `quant` fields; never `rawData`, metrics or expressions) and at most one
`spus` lookup. Writes: a rate-limit counter. Never returned: the Particle device id or name, run
data, customer, shipping, sample or experiment fields.

## Readers

A reader is an SPU in BIMS (`spus`). An app pairs a reader with a holder (an account or a
practice, named only by its `holderRef`), then reads its state and changes its Wi-Fi. Code:
`src/lib/server/bims-api/reader-rules.ts` (pure rules), `src/lib/server/bims-api/readers.ts`
(database and Particle), `src/routes/api/v1/readers/`. The Wi-Fi calls reuse the operator panel's
functions (`src/lib/server/spu-wifi.ts`), so the device contract and its safety checks are the
same: firmware v109+, and a switch only while cellular is connected and the reader is at rest.

### The holder field

```
spus.holder = { kind: "app", ref: "h_…", via: "bioscale-app" | "bioscale-business" | "bioscale-store", since: Date }
```

Absent when no app holds the reader. Separate from the operator `assignment` (customer), which
these endpoints never read or write. The writes use the sacred-document annotation opt-in
(`allowFinalized`, `db/middleware/sacred.ts`) and each adds an `audit_log` row, so a finalized SPU
can still be paired. The SPU page shows "Paired with a Bioscale app since …" while an app holds it.

### What a reader's code is

A reader carries a pre-printed QR label whose payload is a random UUID, bound to the unit on
`/spu/mfg/barcodes` and stored as `spus.barcode`. Its UDI is the reader's serial in this API.
`pair` accepts, after trimming, at most 200 characters, any case:

| Form | Example |
| --- | --- |
| UDI | `BT-M01-0000-0230`, `bt-m01-0000-0230` |
| QR label (`spus.barcode`) | `0c42168a-d868-401a-ac94-1b990f4ad10d` |
| Particle serial number (`particleLink.particleSerial`) | `P2MABA1234ABCD` |
| A URL or text with a UDI or UUID anywhere in it, or a URL whose query value, last path segment or hash is one of the above | `https://bioscale.app/pair?code=0c42168a-d868-401a-ac94-1b990f4ad10d` |

A UDI match wins over a label match, which wins over a Particle serial match. If one kind matches
two readers the code names none (404). The SPU's database id and the Particle device id are not
accepted: neither is printed on the unit.

`{serial}` in the paths is the UDI, any case (`^[A-Za-z0-9-]{3,40}$`, else
`400 { "message": "Not a reader serial" }`).

### Pair

```
POST /api/v1/readers/pair
Authorization: Bearer <key>
Content-Type: application/json

{ "holderRef": "h_8Kq2mXw0aB3dE5fG7hJ9kL1n", "code": "0c42168a-d868-401a-ac94-1b990f4ad10d" }
```

```
201 { "ok": true, "status": "paired",  "reader": ReaderView }
200 { "ok": true, "status": "already", "reader": ReaderView }   // this holderRef already holds it; nothing written
404 { "ok": false, "reason": "not_found" }                      // no reader has this code
409 { "ok": false, "reason": "held_by_other" }                  // another holderRef holds it
409 { "ok": false, "reason": "not_available" }                  // status is not released
400 { "message": "code is required (at most 200 characters)" }
400 { "message": "Only holderRef and code are accepted in the body" }
```

Rules, in order: unknown, `not_found`; held by this holderRef, `already` (whatever its status is
now); held by another, `held_by_other`; status not `released` (draft, assembling, validating,
servicing, retired; legacy values go through `normalizeSpuStatus`, so `deployed` counts as
released), `not_available`; otherwise paired. An operator `assignment.customer` does not block
pairing.

The write matches on `_id`, no holder and the status that was read; a miss is read and judged again
once, and a second miss is `409 held_by_other`, so two holders cannot both pair one reader. It sets
`holder` and pushes one journal entry, `Paired with a Bioscale app (<app>, holder <holderRef>)`
(source `app`). One `audit_log` row: `tableName: "spus"`, `action: "PAIR"`,
`changedBy: "api:<app>"`, `newData: { holder: { kind, ref, via }, journalEntryAdded }`.

To move a reader to a new holder, the old holder unpairs first (READER-01: "the previous holder is
released first"). The API has no forced takeover.

### ReaderView

```
{ "serial": "BT-M01-0000-0230", "online": true, "firmware": 109, "wifiSupported": true, "since": "2026-11-17T15:04:05.000Z" }
```

| Field | Source | Null when |
| --- | --- | --- |
| `serial` | `udi` | never |
| `online` | Particle `GET /devices/{id}` (`online`, else `connected`) | no Particle device linked, or Particle did not answer within 4 s |
| `firmware` | the product firmware version Particle reports, else `wifi_status.fw` | unknown |
| `wifiSupported` | online: whether the `wifi_status` variable exists; offline: `firmware >= 109` | the variable read failed for another reason; offline with unknown firmware |
| `since` | `holder.since` | not in these responses |

At most one device read and one variable read, each bounded to 4 s. Particle being down never
fails the call; the fields are null.

### Unpair

```
POST /api/v1/readers/BT-M01-0000-0230/unpair
{ "holderRef": "h_8Kq2mXw0aB3dE5fG7hJ9kL1n" }
```

```
200 { "ok": true, "status": "unpaired" }
200 { "ok": true, "status": "not_paired" }     // no one holds it; nothing written
404 { "ok": false, "reason": "not_found" }
409 { "ok": false, "reason": "held_by_other" }
```

Removes `holder` (matching `_id` and `holder.ref`), journals `Unpaired from a Bioscale app (<app>,
holder <holderRef>)`, one `audit_log` row with `action: "UNPAIR"`.

### Get a reader

```
GET /api/v1/readers/BT-M01-0000-0230?holderRef=h_8Kq2mXw0aB3dE5fG7hJ9kL1n
```

```
200 ReaderView
404 { "reason": "not_found" }
```

404 unless this holderRef holds the reader. An unknown serial, an unheld reader and a reader held
by someone else look the same.

### Wi-Fi

```
GET /api/v1/readers/BT-M01-0000-0230/wifi?holderRef=h_8Kq2mXw0aB3dE5fG7hJ9kL1n
```

```
200 { "online": true,  "supported": true, "status": WifiStatus, "scan": WifiScan, "error": null }
200 { "online": false, "supported": null, "status": null, "scan": null, "error": null }    // offline
200 { "online": false, "supported": null, "status": null, "scan": null,
      "error": "This reader is not connected to the Bioscale cloud yet." }                // no Particle device linked
404 { "reason": "not_found" }
```

The operator panel's body (`GET /api/spu/{spuId}/wifi`, `readWifi`): `supported: false` is
firmware older than v109. `WifiStatus` is `{ firmware, radioOn, ready, ssid, rssi, cloud, cellular,
switchState, switchSeq, target, scanSeq, saved }`; `WifiScan` is `{ seq, networks: [{ ssid, rssi,
security, securityLabel, channel, supported }], truncated, error }`. Both are read live from the
device and never stored.

```
POST /api/v1/readers/BT-M01-0000-0230/wifi
{ "holderRef": "h_8Kq2mXw0aB3dE5fG7hJ9kL1n", "action": "scan" }
```

```
200 { "seq": 7 }       // poll GET until scan.seq is this
409 { "error": "The reader is busy (running a test or other routine). Try again when it is idle." }
409 { "error": "This reader runs firmware older than v109, which cannot scan for Wi-Fi." }
409 { "error": "The reader has its Wi-Fi radio turned off." }
502 { "error": "Could not reach the reader." }
```

```
POST /api/v1/readers/BT-M01-0000-0230/wifi
{ "holderRef": "h_8Kq2mXw0aB3dE5fG7hJ9kL1n", "action": "connect", "ssid": "Home Net", "password": "…", "security": 3 }
```

```
200 { "seq": 12 }      // poll GET: status.switchSeq and switchState (queued, connecting, joined, joined_other, failed)
200 { "seq": null }    // firmware that saves the network without reporting progress
400 { "error": "WPA passwords are 8–63 characters." }       // validateCredentials, any of its sentences
409 { "error": "Cellular is not connected on this reader, so switching Wi-Fi could leave it unreachable." }
409 { "error": "The reader is busy (running a test or other routine). Try again when it is idle." }
409 { "error": "This reader runs firmware older than v109." }
409 { "error": "⚠ Saved networks were cleared, but Home Net was not saved: …" }
502 { "error": "Could not reach the reader." }
```

`security` is the scanned network's `security` number (0 open, 1 WEP, 2 WPA, 3 WPA2, 6 WPA3;
enterprise 4 and 5 are refused). A switch makes the chosen network the reader's only saved network
(`replaceAndSwitch`). No Particle device linked: `409 { "error": "This reader is not connected to
the Bioscale cloud yet." }`. Not held by this holderRef: `404 { "reason": "not_found" }`, and nothing
is sent to the device. An unknown `action` is `400 { "message": "Unknown action" }`. The body may
carry only `holderRef`, `action`, `ssid`, `password` and `security`.

Messages are the operator panel's with "SPU" rewritten as "reader".

### Privacy

- BIMS receives a `holderRef`, never an email, name or account id.
- The Wi-Fi password is forwarded to Particle and nothing else: it is never stored, logged, audited,
  journaled or returned. A device or Particle message is returned only when it does not contain the
  password (otherwise a generic sentence), and an exception from the device call is a 502 with a
  fixed sentence. The unexpected-failure log line names the endpoint and the error class only.
- A network name can place a home (READER-01), so a Wi-Fi change from an app is journaled and
  audited as `Wi-Fi changed from a Bioscale app (<app>)`, without the network name. The operator
  panel also leaves the network name out of its journal entry while an app holds the reader.
- Scan results are returned live and never stored.
- No location is read or returned.

## What was decided here

- **Research cartridges are refused, with no "internal testers" exception.** The claim API allows
  them when the account's customer is internal; that needs a customer lookup this API cannot make.
- **`linked_by_other`** is the reason for a cartridge linked by a different holder; `in_use` is
  kept for a running cartridge.
- **Result requires `holderRef`** and answers 404 on a mismatch.
- **All result states answer 200** (the draft had 202 for a running cartridge).
- **Sequential ids** (`CART-000123`) are not treated differently. The claim API requires a
  shipment match for them because they can be guessed; this API has no customer to match, and
  relies on the app key and the rate limits.
- **Manufacturing statuses are not filtered.** Any status that is not a run or void status can be
  linked if the cartridge has an assay, as the apps do today. `wax_rejected` and
  `reagent_rejected` cartridges are therefore linkable; say so if they should be refused.
- **Expiry** is `reagentFilling.expirationDate ?? expirationDate`. The reader's cloud checks only
  the top-level `expirationDate`.

## Rollout

1. Merge `feat/bims-api-v1` to `master` through the normal review. The branch adds routes and one
   module; it changes no existing route.
2. In the BIMS Vercel project set `BIMS_API_KEY_CONSUMER`, `BIMS_API_KEY_BUSINESS` and, when the
   store needs it, `BIMS_API_KEY_STORE` (`openssl rand -base64 32` each, all different, different
   from every other key). Redeploy so the functions pick them up.
3. Create the rate-limit TTL index: `npx tsx --tsconfig tsconfig.json scripts/ensure-indexes.ts`
   to see what is missing, then `--apply`.
4. Set the matching key in each app (`BIMS_BASE_URL` and the app's own variable for its v1 key),
   and switch the app to the API behind its flag.
5. Check with one cartridge: check → link → check (state `linked`) → unlink → check (state
   `ready`), and confirm the two `audit_log` rows.

Until step 2 every `/api/v1/` request is a 401.

## Known gaps

- A manufacturing page can still set the status of a linked cartridge (see the branch report).
  The result endpoint then reads `cancelled` / `not_linked`.
- Cartridges the apps linked before `HOLDER_REF_SECRET` was set carry an account id in
  `checkpoints.linked.who`, which no `holderRef` matches: they read as `linked_by_other` and their
  results as 404 until backfilled.
- When a curve is approved after a run, the result changes from `not_calibrated` to `ok` once
  research quantifies the stored run. The API does not notify anyone.

## Tests

`npx vitest run --config tests/vitest.unit.config.ts src/lib/server/bims-api src/routes/api/v1`

- `src/lib/server/bims-api/rules.test.ts`: every refusal reason, link and unlink decisions.
- `src/lib/server/bims-api/result.test.ts`: the reported-wells reduction, units, run state.
- `src/lib/server/bims-api/auth.test.ts`: keys and the rate limiter.
- `src/routes/api/v1/cartridges/[id]/handlers.test.ts`: the four handlers against in-memory models.
- `src/lib/server/bims-api/reader-rules.test.ts`: every accepted reader code form, pairing and
  unpairing rules, operator-to-app wording.
- `src/routes/api/v1/readers/handlers.test.ts`: the reader handlers against an in-memory `spus`, a
  mocked Particle client and the real spu-wifi functions over it; the holder check on every
  endpoint; that the password appears in no response, journal entry, audit row, update or log line.
