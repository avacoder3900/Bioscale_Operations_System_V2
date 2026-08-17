# Zebra ZT230 — Cartridge Barcode Printing

Page: `/manufacturing/print-barcodes/zebra` · Branch: `jq/barcode-scanning`

## What it does

Mints cartridge barcodes (UUID v4 — the same payload the Avery sheet page mints
and every scanner already resolves as `CartridgeRecord._id`), builds a ZPL job
for 2-across ¾" × ¾" roll labels, and pushes it to a Zebra ZT230 through the
**Zebra Browser Print** agent running on the operator's PC. Confirmed prints go
through the same `BarcodeSheetBatch` reserve → confirm → expiry lifecycle, the
same PT-CT-106 label accounting, and the same audit log as Avery prints.

## Why Browser Print (and not the server)

BIMS runs on Vercel and cannot reach the lab LAN — the same reason the OT-2
bridge exists. Browser Print is Zebra's free local agent: it sees printers
attached to the PC over **USB** or reachable on the **LAN/WiFi**, and exposes
them to web pages on `localhost:9100/9101`. The page talks to it directly
(`src/lib/zebra/browser-print.ts`); no Zebra JS bundle is shipped.

If unattended / agent-driven printing is ever needed, the ZPL generator
(`src/lib/zebra/cartridge-label-zpl.ts`) is isomorphic and the batch lifecycle
(`src/lib/server/services/barcode-print-batch.ts`) is medium-agnostic, so a
Mongo print-job queue + lab-side daemon (ot2-bridge pattern) can be added
without touching either.

## One-time setup per printing PC

1. Install **Zebra Browser Print** (Windows/macOS) from zebra.com and make sure
   it is running (tray icon).
2. Connect the printer:
   - **USB**: plug in; Browser Print lists it automatically.
   - **WiFi / Ethernet**: give the ZT230 a static IP (or DHCP reservation) on
     the lab network, then in Browser Print → Settings → *Add printer* enter
     the IP. The PC must be on the same LAN/VLAN — a laptop on guest WiFi
     won't see it.
3. Open the BIMS page. The agent pops a native dialog asking to allow the BIMS
   origin (`https://…vercel.app` / your domain) — click **Accept**, then
   **Refresh** on the page. Until accepted every request is rejected.
4. Pick the printer in the dropdown; it's remembered per browser.

Fallback if the agent is unavailable: **Download .zpl** and send the file with
Zebra Setup Utilities. The batch still has to be confirmed on the page within
the 5-minute window.

## Printer media setup (once per roll type)

- Media: 2-across die-cut labels, ¾" × ¾", gap/web sensing.
- Run the printer's own media calibration (front panel → Calibrate, or hold
  PAUSE+CANCEL / FEED per ZT230 manual) so top-of-form is detected on the gap.
- Print mode: tear-off (or peel if fitted). Darkness/speed can be left on the
  printer or overridden per job from the page.

## Calibrating position (repeatability)

Every element is placed at absolute dot coordinates from `computeGeometry()`,
so once dialled in, the design lands identically on every label. On the page:

1. Open **Label layout & printer calibration**.
2. Set **Printer dpi** (203 vs 300 — printed on the ZT230 model label).
3. Set **Gap between columns** to the actual die-cut gap (default 0.125").
4. Click **Print alignment row** — mints nothing. Each label gets a 1-dot
   border, a centre cross and `ALIGN n`. Nudge **X/Y offset** (dots; 8 dots ≈
   1 mm at 203 dpi) until the border sits on the die-cut edge of *both*
   labels, and repeat.
5. Settings persist per browser and are recorded in the audit row of every
   confirmed batch (`calibration` JSON).

If the QR is too large for the label at your dpi, drop **QR module size**
(3 → 2); the page drops the human-readable text automatically if it wouldn't
fit rather than printing over the edge.

## Operator flow

1. Enter the label count (even numbers avoid a blank last position) →
   **Generate & reserve**. UUIDs are minted, checked against
   `cartridge_records` and prior batches, and stored as a `reserved` batch
   with a 5-minute window.
2. **Send N labels to <printer>**. The page builds the ZPL locally and POSTs
   it to the agent. "Sent" only means the printer accepted the data.
3. When the labels are out: **Yes, add to inventory** — records `creation` of
   N labels on PT-CT-106 (no sheet consumption for roll media) and audits the
   batch. Or **No, discard** — the UUIDs stay burned, nothing else changes.
4. **Send again** re-sends the same UUIDs; only for "nothing came out". Any
   duplicate physical labels must be destroyed.

## Files

| File | Role |
|---|---|
| `src/lib/zebra/cartridge-label-zpl.ts` (+ `.test.ts`) | Pure ZPL builder + geometry; alignment label |
| `src/lib/zebra/browser-print.ts` | Browser Print agent client (detect / list / write / ~HS status) |
| `src/lib/server/services/barcode-print-batch.ts` | Shared reserve/confirm lifecycle (Avery + Zebra) |
| `src/routes/manufacturing/print-barcodes/zebra/` | Page + actions |
| `src/routes/manufacturing/print-barcodes/+page.server.ts` | Avery page, now on the shared service |
