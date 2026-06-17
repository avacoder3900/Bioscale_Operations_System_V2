# Chemical Inventory

CSV chemical lists used by the Ask BIMS `lookup_chemical` tool. Vite bundles
every `*.csv` here at build time so the tool works on Vercel serverless
without runtime FS access.

## Source files

| Bundled | Source on Lab Mac |
|---|---|
| `brevitest.csv` | `C:\Users\nicho\Downloads\Brevitest and Fannin Chemical Inventory Final (1).xlsx`, "Chemical Inventory" sheet, BREVITEST section (rows 2-150) |
| `fannin.csv` | Same xlsx, FANNIN section (rows 154-208) |

Tag conventions:
- Brevitest — `C-001 .. C-149`
- Fannin — `D-001 .. D-055`

## Update workflow

When the source xlsx changes:

```
npx tsx scripts/convert-chemical-inventory.ts
```

This rewrites both CSVs from the canonical xlsx. Commit the diff and push;
Vercel rebuilds with the new content.

## Schema

Both CSVs share the same column shape:

```
Inventory Code, Item, Current On Hand, CAS #, IFC Hazard Class,
Physical State, HMIS Qty, HMIS Units, NFPA (H/F/R/Spec),
Primary Chemical Name, Storage Code, Classification Notes,
Inventory Link
```

Hazard classes use the IFC codes from the Houston HMIS schema — HTX (highly
toxic), TOX, OX/OX1/OX2 (oxidizers), COR (corrosive), F1A/F1B/F1C (flammable
class 1), F2/F3 (flammable), C3A/C3B (combustible), WR2/WR3 (water-reactive),
NR (not regulated). See the "Color Legend" sheet in the source xlsx for the
full mapping.

## Dual-stocked chemicals

About a dozen chemicals (DMSO, IPA, ethanol, PBS, NaOH, BSA, glycerol,
agarose, DTT, TCEP, NaCl, sucrose) are maintained by BOTH orgs — each keeps
its own bottle with its own lot number / opening date / location. The
`lookup_chemical` tool surfaces this in `dataIntegrityNotes` so operators
know to confirm which bottle they want.
