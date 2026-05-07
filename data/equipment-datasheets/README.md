# Equipment Datasheets

CSV equipment lists used by the Ask BIMS `lookup_equipment_datasheet` tool.
Vite bundles every `*.csv` here at build time so the tool works on Vercel
serverless without runtime FS access.

## Source files

| Bundled | Source on Lab Mac |
|---|---|
| `BT.csv` | `C:\Users\nicho\Desktop\Equipment Lists & Datasheets\Equipment Lists - BT - Final With Table Locations.csv` |
| `Fannin.csv` | `C:\Users\nicho\Desktop\Equipment Lists & Datasheets\Fannin Lab Equipment List_filled_v5.csv` |

Tag-prefix conventions (per project memory `project_equipment_pdfs_folder`):
- BT — `B-XX` = floor, `E-XX` = bench
- Fannin — `B-XX` = floor, `F-XX` = bench

## Update workflow

When the source files change on the Lab Mac:

1. Copy the latest canonical CSVs from the Desktop folder into this directory,
   keeping the bundled names (`BT.csv`, `Fannin.csv`).
2. Commit the change to the active feature branch.
3. Push — Vercel rebuilds with the new content; the tool picks them up
   automatically.

There is no automated sync — manual copy is the workflow until/unless someone
builds a script.

## Schema notes

Both CSVs share roughly the same column shape:

```
Tag #, Equipment, Bench/Floor, Bench Location, QTY, W, D, H,
Power (V), Watts, Amps, Generator, Notes, Location, Total Linch,
Datasheet URL, [Status, Confidence %, Claude Comments — Fannin only]
```

The BT file has a banner row at the top (`BREVITEST,...`) and a sub-header
row below the main headers; the parser detects the real header row by
looking for `Tag #` as the first cell.

## PDF datasheets

Per-equipment manufacturer PDFs are NOT bundled in this folder (out of scope
for the current Phase D; PDF parsing is deferred). When operators need a
datasheet, the `Datasheet URL` column on each equipment row links to the
manufacturer's hosted spec sheet. The Box folder linked at the top of `BT.csv`
holds additional reference PDFs.
