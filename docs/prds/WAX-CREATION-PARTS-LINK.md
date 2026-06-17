# PRD: Link Wax Creation to Inventory Parts

**Author:** Alejandro Valdez (via Agent001)
**Date:** 2026-04-03
**Status:** Ready for implementation
**Priority:** P1
**Branch:** `feature/cv-bims-integration`

---

## 1. Problem Statement

The wax creation work instruction page (`/manufacturing/wax-creation`) has hardcoded raw material references. It does not:
- Pull part data from the database
- Show part numbers
- Record inventory consumption when a batch is completed

The parts now exist in the database (PT-CT-108, PT-CT-109, PT-CT-110) but aren't connected to the wax creation workflow.

## 2. Goal

Link the wax creation page to the actual inventory parts so that:
1. Raw materials panel shows real part numbers, names, and costs from the database
2. Completing a batch automatically records inventory consumption transactions
3. Materials used are summarized in the completion screen

## 3. Parts Reference

| Part # | Name | Unit | Cost | Consumption Calculation |
|--------|------|------|------|------------------------|
| PT-CT-108 | Nonadecane (100g) | bottle (100g) | $113.00 | `nanodecaneWeight / 100` bottles consumed |
| PT-CT-109 | Soft Microcrystalline Wax (1lb) | bag (453.6g) | $17.17 | `actualWaxWeight / 453.6` bags consumed |
| PT-CT-110 | 15mL Centrifuge Tube, Red Cap (500pk) | tube | $198.97/500 = $0.398/tube | `fullTubeCount + (partialTubeMl > 0 ? 1 : 0)` tubes consumed |

## 4. Changes Required

### 4.1 Backend: `src/routes/manufacturing/wax-creation/+page.server.ts`

#### Load Function — Add Part Lookup

```typescript
// Add to imports:
import { PartDefinition, InventoryTransaction } from '$lib/server/db';

// Add to load function, after lotNumber generation:
const waxPartNumbers = ['PT-CT-108', 'PT-CT-109', 'PT-CT-110'];
const waxPartDocs = await PartDefinition.find({ partNumber: { $in: waxPartNumbers } }).lean();
const waxParts = waxPartDocs.map((p: any) => ({
    id: p._id,
    partNumber: p.partNumber,
    name: p.name,
    description: p.description ?? '',
    supplier: p.supplier ?? '',
    unitCost: parseFloat(p.unitCost) || 0,
    unitOfMeasure: p.unitOfMeasure ?? 'ea'
}));

// Return alongside lotNumber:
return { lotNumber, waxParts };
```

#### Save Action — Add Inventory Consumption

After the existing `AuditLog.create()` call, add:

```typescript
// Look up part IDs
const partDocs = await PartDefinition.find({
    partNumber: { $in: ['PT-CT-108', 'PT-CT-109', 'PT-CT-110'] }
}).lean();
const partMap = new Map(partDocs.map((p: any) => [p.partNumber, p]));

const consumptions = [
    {
        partNumber: 'PT-CT-108',
        quantity: -(nanodecaneWeight / 100),  // 100g per bottle
        reason: `Wax batch ${lotNumber} — ${nanodecaneWeight}g nonadecane consumed`
    },
    {
        partNumber: 'PT-CT-109',
        quantity: -(actualWaxWeight / 453.6),  // 1lb = 453.6g per bag
        reason: `Wax batch ${lotNumber} — ${actualWaxWeight}g microcrystalline wax consumed`
    },
    {
        partNumber: 'PT-CT-110',
        quantity: -(fullTubeCount + (partialTubeMl > 0 ? 1 : 0)),  // tubes used
        reason: `Wax batch ${lotNumber} — ${fullTubeCount} full tubes + ${partialTubeMl > 0 ? '1 partial' : '0 partial'}`
    }
];

for (const c of consumptions) {
    const part = partMap.get(c.partNumber);
    if (!part) continue;

    // Get current balance
    const balanceAgg = await InventoryTransaction.aggregate([
        { $match: { partDefinitionId: (part as any)._id.toString() } },
        { $group: { _id: null, total: { $sum: '$quantity' } } }
    ]);
    const previousQuantity = balanceAgg[0]?.total ?? 0;
    const newQuantity = previousQuantity + c.quantity;

    await InventoryTransaction.create({
        _id: generateId(),
        partDefinitionId: (part as any)._id.toString(),
        partNumber: c.partNumber,
        transactionType: 'consumption',
        quantity: c.quantity,
        previousQuantity,
        newQuantity,
        reason: c.reason,
        performedBy: locals.user!._id,
        performedAt: new Date(),
        manufacturingRunId: batchId,
        manufacturingStep: 'wax-creation',
        notes: `Lot: ${lotNumber}`
    });
}

// Update inventoryCount on each part definition
for (const c of consumptions) {
    const part = partMap.get(c.partNumber);
    if (!part) continue;
    await PartDefinition.updateOne(
        { _id: (part as any)._id },
        { $inc: { inventoryCount: c.quantity } }
    );
}
```

### 4.2 Frontend: `src/routes/manufacturing/wax-creation/+page.svelte`

#### Update Props Interface

```typescript
interface Props {
    data: {
        lotNumber: string;
        waxParts: Array<{
            id: string;
            partNumber: string;
            name: string;
            description: string;
            supplier: string;
            unitCost: number;
            unitOfMeasure: string;
        }>;
    };
}
```

#### Replace Hardcoded Raw Materials Panel

Replace the existing static `Raw Materials` div with:

```svelte
<div class="mb-4 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
    <h3 class="text-xs font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
        Raw Materials (from Inventory)
    </h3>
    <div class="mt-2 space-y-2 text-sm">
        {#each data.waxParts as part}
            <div class="flex items-center justify-between">
                <div>
                    <span class="font-mono text-xs text-[var(--color-tron-cyan)]">{part.partNumber}</span>
                    <span class="ml-2 text-[var(--color-tron-text)]">{part.name}</span>
                </div>
                <div class="text-right">
                    <span class="text-xs text-[var(--color-tron-text-secondary)]">
                        {part.supplier} — ${part.unitCost.toFixed(2)}/{part.unitOfMeasure}
                    </span>
                </div>
            </div>
        {/each}
    </div>
</div>
```

#### Add Materials Used to Completion Summary

After the existing grid in the completion `{:else}` block, add:

```svelte
<!-- Materials Consumed -->
<div class="mt-4 border-t border-[var(--color-tron-border)] pt-4">
    <h3 class="text-xs font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
        Materials Consumed
    </h3>
    <div class="mt-2 space-y-1 text-sm">
        {#each data.waxParts as part}
            {@const consumed = part.partNumber === 'PT-CT-108'
                ? (nanodecaneWeight! / 100).toFixed(2) + ' bottles'
                : part.partNumber === 'PT-CT-109'
                    ? (actualWaxWeight! / 453.6).toFixed(4) + ' bags'
                    : (fullTubeCount! + (partialTubeMl && partialTubeMl > 0 ? 1 : 0)) + ' tubes'}
            <div class="flex justify-between">
                <span class="text-[var(--color-tron-text-secondary)]">
                    <span class="font-mono text-xs text-[var(--color-tron-cyan)]">{part.partNumber}</span>
                    {part.name}
                </span>
                <span class="text-[var(--color-tron-text)]">-{consumed}</span>
            </div>
        {/each}
    </div>
</div>
```

## 5. Files to Modify

| File | Change |
|------|--------|
| `src/routes/manufacturing/wax-creation/+page.server.ts` | Add PartDefinition/InventoryTransaction imports, load waxParts, record consumption on save |
| `src/routes/manufacturing/wax-creation/+page.svelte` | Update Props, replace hardcoded panel, add Materials Consumed section |

### Files NOT to Touch
- No model changes needed
- No new routes needed
- Do NOT modify any other manufacturing pages
- Make surgical edits only — do NOT rewrite either file from scratch

## 6. Acceptance Criteria

1. Raw Materials panel shows PT-CT-108, PT-CT-109, PT-CT-110 with names/costs from database
2. Completing a batch creates 3 inventory consumption transactions (negative quantities)
3. Transaction `reason` includes the lot number for traceability
4. Transaction `manufacturingRunId` links back to the batch
5. Completion summary shows "Materials Consumed" section with quantities
6. `inventoryCount` on each part definition is decremented
7. Transactions appear in the Scanned Inventory tab and transaction history

## 7. Notes for AI Agent

- **Stack:** SvelteKit 2 + Svelte 5 (`$props()`, `$state()`, `$derived()`)
- **ORM:** Mongoose — `InventoryTransaction.create()` and `PartDefinition.find()`
- **Import `generateId`** from `$lib/server/db` (already imported in the file)
- **Import `PartDefinition` and `InventoryTransaction`** from `$lib/server/db`
- **Only edit** the two files listed above
- **Surgical edits only** — do NOT rewrite from scratch
