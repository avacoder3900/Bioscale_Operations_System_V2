# Bug Fix: Equipment 500 Errors + Navigation Links

## Scope
Quick fixes — no PRD/Ralph loop needed.

## Tasks

### 1. Fix Equipment Sub-Page 500 Errors
- Fridges & Ovens → 500
- Decks & Trays → 500
- Temperature Probes → 500
- Debug each `+page.server.ts`, likely missing collections or unhandled null data
- Wrap in try/catch, seed empty collections if needed

### 2. Add Equipment Link to Cartridge Manufacturing Sidebar
- Add a "Cartridge Filling Equipment" link in the Cartridge Manufacturing nav
- Links to existing `/spu/equipment` page (no duplication)

### 3. Consumables Page Repurpose
- Current page shows decks/cooling trays (wrong place — these live at Equipment)
- Options: repurpose as actual consumables view (pipette tips, thermoseal, wax, etc. filtered from `part_definitions` where items are consumed in manufacturing), or remove entirely
- Decision: repurpose as "Manufacturing Consumables" — shows cartridge BOM parts with current inventory, consumption rate, reorder alerts

## Estimated Effort
- 2-3 hours
