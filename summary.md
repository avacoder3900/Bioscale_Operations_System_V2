# Cartridge/Backing-Lot Refactor — Summary

## The original problem

You noticed your dashboard was lying to you. Three specific ways:

1. **Oven 1 showed "0 cartridges"** even though it physically had 83 in it.
2. **The "backing cartridges" count** was stuck way higher than reality — cartridges that had already been wax-filled were still showing as "in the oven."
3. **The Wax QC pass-rate** was stuck at 0%, like nothing ever passed QC.

Turns out all three had the same root cause: the system was basically living a double life.

## The double-life problem

Here's the weird thing the old code was doing. When WI-01 ran (making backing cartridges), the system would create 24 or 54 or however-many **placeholder records** with made-up IDs nobody ever prints on a physical label. These just sat in the database forever.

Then later, when someone scanned actual cartridges onto a wax deck, the system created **brand new, different records** using the scanned UUID — because the scanned barcodes don't match the made-up placeholder IDs.

So every physical cartridge had two database entries: a ghost placeholder from WI-01, and the real one from the wax scan. **They never talked to each other.** The ghost count kept piling up, the bucket's cartridge count never went down when wax filling pulled from it, and no one noticed operators pulling 66 cartridges out of a bucket labeled "54."

Also, for wax QC: the code only wrote "Rejected" to the database. If a cartridge *passed*, nothing got written. So the dashboard saw a bunch of Rejects and zero Accepts and told you the yield was 0%.

## What the fix does

**One cartridge = one record, born when you first scan it.** WI-01 now only records the bucket-level stuff (which raw-material lots went in, how many are in the oven). A real `CartridgeRecord` only exists once someone scans a physical barcode onto a wax deck — and at that moment it inherits the full material lineage (which cartridge blank lot, which thermoseal lot, which barcode-label lot, oven entry time, etc.) from the bucket it came out of.

**Buckets can't be over-pulled anymore.** When wax filling pulls cartridges from a bucket, it now uses an atomic check: if the bucket says "15 left" and you scanned 20, the whole load fails with a clear error message *before* any records are written. No more silent over-pull.

**Accept gets written on wax QC pass.** Yield numbers will now reflect reality.

**Abort/cancel puts cartridges back.** If an operator aborts a wax run, the cartridges get deleted (they never actually got wax-filled) and the bucket's count goes back up so you can use them in the next run.

## What we cleaned up in the data

- **9,641 historical cartridges** got `waxQc.status='Accepted'` backfilled so the yield KPI actually reflects what really happened (with a compliance audit-log entry documenting who authorized the backfill and why).
- **288 cartridges** got material lineage (parent lot, input material lots, QR ref) retroactively attached.
- **176 cartridges** that had `backing.lotId` pointing at the wrong thing (the LotRecord ID instead of the bucket barcode) got remapped.
- **55 CART-\* test-seed cartridges** from April 13 got voided — they were never real production.
- **70 placeholder ghost records** from a WI-01 run you did at 23:13 UTC got deleted (pre-deploy, those were still being created).
- **2 missing BackingLots** (whose cartridges existed but bucket records had been lost) got restored.
- **1 duplicate LotRecord** got marked Superseded.
- **1 bucket with a 12-cartridge over-pull** got a formal correction logged. 66 cartridges came out of a bucket that WI-01 recorded as holding 54. The extras exist and are traceable to the bucket, but their origin is unverified — **QA should review those 12 before any of those 66 ship**.

## What the dashboard shows now

- **Oven 1:** 97 cartridges (27 in one bucket + 70 in the new bucket from tonight's WI-01 run)
- **Oven 2:** 0
- **Fridge counts:** correct and consistent across every page
- **Wax QC yield:** finally counts Accepts

## Deployed

Refactor is live on `main` as of commit `8d5c221`. Next WI-01 run you do will follow the new flow automatically — no more ghost records.

## One thing to actually look at with human eyes

**Lot `V1BSHFzMXsNAxYiP59o6b` / bucket `2941bb67`.** 66 cartridges pulled from a 54-cart bucket across 4 runs today. Either more cartridges were physically in the bucket than WI-01 recorded, or 12 have an unexplained origin. It's documented in the database as a formal `RECONCILE` audit entry, but before any of those 66 cartridges ship to a customer, someone should take a look and figure out what happened.

The 4 runs involved were:
- `kcLzRTjSHP7cj6Eb94QGj` (20 cartridges)
- `6o29m5Jre1aqGTXJ-fZdL` (24 cartridges)
- `LVWw0lsgOOyDuZuP6tKrW` (5 cartridges)
- `4Z6AldZWCJ8EC_QG0pe2N` (17 cartridges)

That's it. Dashboard will tell the truth now.
