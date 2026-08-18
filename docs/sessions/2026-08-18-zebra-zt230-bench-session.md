# Session notes — Zebra ZT230 cartridge-label printing, bench-verified (2026-08-17/18)

**People:** Jacob (at the printer), Claude (driving BIMS + the agent from Jacob's PC)
**Branch:** `jq/barcode-scanning` (worktree `..\Bioscale_Operations_System_V2-jq-barcode-scanning`), merged to `master` repeatedly during the session
**Related:** `docs/ZEBRA-ZT230-BARCODE-PRINTING.md` (runbook), `docs/prds/OT2-TAILNET-0-PLAN.md` (side thread), `progress.txt` 2026-08-17/18 entries

---

## 1. What was built (day 1, 2026-08-17)

Goal: print the same cartridge UUID barcodes the Avery 94102 sheet page mints,
on a Zebra ZT230 loaded with 2-across ¾" roll labels, positionally repeatable.

- **Delivery = Zebra Browser Print** (local agent on the operator PC; printer on
  USB or LAN). Chosen because Vercel cannot reach the lab LAN (same constraint
  the OT-2 bridge exists for) and Browser Print needs no daemon deployed.
- `src/lib/server/services/barcode-print-batch.ts` — the reserve → atomic-claim
  → confirm lifecycle extracted from the Avery page and shared;
  `medium: 'avery-sheet' | 'zebra-roll'`.
- `src/lib/zebra/cartridge-label-zpl.ts` — pure ZPL builder + one geometry
  function; `buildAlignmentZpl`, later `buildFeedZpl`, `buildRulerZpl`.
- `src/lib/zebra/browser-print.ts` — minimal client for the agent's REST API.
- `/manufacturing/print-barcodes/zebra` page + nav link; Avery page moved onto
  the shared service; runbook.
- Side thread: PRDs for direct OT-2 control over Tailscale
  (`OT2-TAILNET-0/1/2`, `LAB-GATEWAY-1-DEFERRED`).

## 2. Setup discoveries (day 2, 2026-08-18)

| Symptom | Cause | Resolution |
|---|---|---|
| "Browser Print won't open" | It has **no window**; tray-only (right-click the Z icon under the `^` chevron). Desktop shortcut just relaunches the running instance. | Documented. Agent API on `localhost:9100/9101` was up the whole time. |
| Printer shows IP `000.000.000.000` on Ethernet | Wall port gave no DHCP; printer not on the WiFi /24 either | Parked Ethernet; **USB** worked with zero setup (`52j150301773 (usb)`). |
| `/write` → "Failed to write to device: null" | POST without a `Content-Type` header | Client + CLI send `text/plain`. |
| Agent died after USB re-plug | Browser Print 1.3.2 crashes on hot-replug | Relaunch from shortcut. |
| Nothing prints, `~HS` shows head-open + paused | Printhead not latched / paused | Latch, unpause. A job buffered while the head is open may be discarded — resend. |
| Blank rows interleaved, then PAPER OUT on a full roll | Media (gap) sensor sitting over the centre liner web between the two columns → hunts, feeds blanks, declares paper out. Also left column faint. | Jacob moved sensor / pressure; later found the **ribbon** wasn't covering the left edge. |
| Left border line wouldn't move further left | The **ribbon edge**, then confirmed dot 0 vs die-cut with a printed ruler | Ribbon moved; ruler measured. |
| Empty `^XA^XZ` doesn't feed | Printer discards empty formats | Feed = print a 1-dot mark (`buildFeedZpl`, page **Feed 2 rows** button). |

Printer facts: **ZT230-200dpi** (203 dpi), firmware V72.20.22Z, thermal
transfer with ribbon, serial 52J150301773.

## 3. Calibration — final values (baked into `ZT230_2X_075_DEFAULTS`)

Measured with `buildRulerZpl` (dot ruler across the web) + Jacob's calliper:

| Parameter | Value | How |
|---|---|---|
| Label width across web | **150 dots = 0.74"** | ruler: right label 188 → 338; left label 0 → 150 |
| Label length along feed | **160 dots = 0.787"** | printer sensed 161 |
| Column pitch | **188 dots** → gap 31 dots after x-offset | ruler |
| offsetX | **+7 dots** | QR left margin 1.88 mm (L) vs 2.71 mm (R) → 0.83 mm |
| offsetY | **0** (`^LT-8` clipped the top row) | letters cut off at top |
| A/B/C row | 15-dot font, **2 mm** from top (was 1 mm — clipped by feed drift over 100 labels) | |
| QR | `^BQN,2,3`, ECC M, 33 modules → 99 dots, top at 32 | |
| UUID text | `^A0` **10 dots**, two lines, **left-aligned at the QR's left edge** (proportional font centred gave visibly different left edges per UUID; fixed-pitch font B was rejected as too big), bottom at 155/160 | |

Learned about ZPL: `^FO` clamps at 0 (can't print left of dot 0); negative Y
must be `^LT` (−120..120) and negative X `^LS`, and both are still bounded by
the physical head/ribbon; `~JA` cancels the buffer; `~HS` line 1 field 3 =
paused, field 5 = formats buffered; line 2 field 3 = head open, field 4 = ribbon
out.

## 4. Live runs (all through `scripts/zebra-bulk-print.mts`)

Uses the same `reserveBatch()` / `confirmBatch()` / `mintCartridgeBarcodes()` as
the page; per batch: mint (checks `cartridge_records._id`, every prior
`barcode_sheet_batches.barcodeIds`, within-batch dupes; extra guard on
`optical_test_cartridges.barcode`), send ZPL, poll `~HS` until drained with no
paper/ribbon-out flags, confirm (atomic claim, PT-CT-106 `creation`, AuditLog),
then a whole-run audit (unique, none on cartridges, each in exactly one batch).

| Batch | Labels | Result |
|---|---|---|
| `CwPbrMKTEWd0LEvnKn0un` | 4 | pilot — confirmed |
| `04iO0uB6vOMgF-LgCjRmI` | 200 | printer paper-out mid-batch (sensor issue); ~130 physically printed; job cancelled with `~JA`; **confirmed as 200 per Jacob** (keep the printed ones, remaining ~70 UUIDs burned/never printed). Audit note on the row. −N inventory adjustment pending Jacob's count. |
| `GOQVfGWjucaP8SNPaZhtD` | 100 | live run after re-calibration — clean, no blank rows, all checks OK |

Random-UUID **test** labels were also printed via `zebra-send.ts labels` (not
minted; Jacob told to discard).

PT-CT-106 ledger stayed consistent throughout (Alejandro consumed 16 + 8 at
WI-01 during the 100-run; 716 → 816 for our +100).

## 5. Tools added

- `scripts/zebra-send.ts` — `align | ruler | labels <uuid…> | raw "<zpl>" | status | list`; `--w --h --gap --x --y --mag --dark --dry`.
- `scripts/zebra-bulk-print.mts` — `--as=<user> --total=N --batch=200 [--dry]`; requires `--tsconfig scripts/tsconfig.json` (shim for `$env/dynamic/private` in `scripts/shims/`). Writes the UUID list to `%LOCALAPPDATA%\BIMS\zebra-runs\`.
- Page: **Feed 2 rows** button, label width/length fields, calibration key `zebraLabelCalib.v3`.

## 6. Open items

- Run the remaining **1900** labels (Jacob approved a big batch once alignment held over 100).
- Post the −N adjustment on PT-CT-106 for the ~70 unprinted UUIDs of batch `04iO0uB6vOMgF-LgCjRmI` once counted.
- Ethernet for the printer (needs a DHCP-serving port / static IP + Browser Print "Add printer").
- Push final calibration + tools to master (in progress at time of writing).
