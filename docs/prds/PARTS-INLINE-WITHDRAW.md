# PRD: Inline Withdraw on Parts Page

**Author:** Alejandro Valdez (via Agent001)
**Date:** 2026-04-03
**Status:** Ready for implementation
**Priority:** P1
**Branch:** `feature/cv-bims-integration`

---

## 1. Problem Statement

To withdraw inventory, users currently have to navigate to a separate `/parts/withdraw` page. The user wants to click a part number directly on the parts page, enter a quantity and reason, and withdraw — all without leaving the page.

## 2. Goal

Add an inline withdraw modal to the parts page. Clicking a part number opens a popup where you enter quantity + reason, then submit to deduct inventory.

## 3. UI Flow

```
Parts Page (any tab — SPU BOM, Cartridge, Scanned Inventory)
  │
  ▼ User clicks part number (e.g., "PT-CT-108")
  │
  ▼ Modal opens:
  ┌──────────────────────────────────────────┐
  │  Withdraw Inventory                       │
  │                                           │
  │  PT-CT-108 — Nonadecane (100g)           │
  │  Current Stock: 12                        │
  │                                           │
  │  Quantity: [_________]                    │
  │  Reason:   [_________________________]   │
  │                                           │
  │  [Cancel]              [Withdraw]         │
  └──────────────────────────────────────────┘
  │
  ▼ On submit: POST to form action
  │
  ▼ Success toast: "Withdrew 5 of PT-CT-108. New stock: 7"
  ▼ Page data refreshes (updated stock visible)
```

## 4. Implementation

### 4.1 Backend: `src/routes/parts/+page.server.ts`

Add a `withdraw` form action (reuse logic from `/parts/withdraw/+page.server.ts`):

```typescript
withdraw: async ({ request, locals }) => {
    requirePermission(locals.user, 'inventory:write');
    await connectDB();

    const form = await request.formData();
    const partId = form.get('partId')?.toString().trim();
    const qtyStr = form.get('quantity')?.toString().trim();
    const reason = form.get('reason')?.toString().trim();

    if (!partId) return fail(400, { withdrawError: 'Select a part' });
    if (!qtyStr || isNaN(Number(qtyStr)) || Number(qtyStr) <= 0) {
        return fail(400, { withdrawError: 'Enter a valid quantity greater than 0' });
    }
    if (!reason) return fail(400, { withdrawError: 'Provide a reason' });

    const quantity = Number(qtyStr);
    const part = await PartDefinition.findById(partId).lean() as any;
    if (!part) return fail(404, { withdrawError: 'Part not found' });

    // Get current balance from transactions
    const balanceAgg = await InventoryTransaction.aggregate([
        { $match: { partDefinitionId: partId } },
        { $group: { _id: null, total: { $sum: '$quantity' } } }
    ]);
    const previousQuantity = balanceAgg[0]?.total ?? 0;
    const newQuantity = previousQuantity - quantity;

    await InventoryTransaction.create({
        _id: generateId(),
        partDefinitionId: partId,
        partNumber: part.partNumber,
        transactionType: 'consumption',
        quantity: -quantity,
        previousQuantity,
        newQuantity,
        reason: `Withdraw: ${reason}`,
        performedBy: locals.user!._id,
        performedAt: new Date(),
        operatorId: locals.user!._id,
        operatorUsername: locals.user!.username,
        notes: reason
    });

    // Update inventoryCount on part definition
    await PartDefinition.updateOne(
        { _id: partId },
        { $inc: { inventoryCount: -quantity } }
    );

    await AuditLog.create({
        _id: generateId(),
        tableName: 'inventory_transactions',
        recordId: partId,
        action: 'INSERT',
        newData: { partNumber: part.partNumber, quantity: -quantity, reason },
        changedAt: new Date(),
        changedBy: locals.user!.username
    });

    return {
        withdrawSuccess: true,
        withdrawMessage: `Withdrew ${quantity} of ${part.partNumber} — ${part.name}. New stock: ${newQuantity}`
    };
}
```

### 4.2 Frontend: `src/routes/parts/+page.svelte`

Add these elements:

#### A. Modal State Variables
```typescript
let withdrawModal = $state<{ id: string; partNumber: string; name: string; stock: number } | null>(null);
let withdrawQty = $state<number | null>(null);
let withdrawReason = $state('');
let withdrawing = $state(false);
```

#### B. Open Modal Function
```typescript
function openWithdraw(part: { id: string; partNumber: string; name: string; inventoryCount: number }) {
    withdrawModal = { id: part.id, partNumber: part.partNumber, name: part.name, stock: part.inventoryCount };
    withdrawQty = null;
    withdrawReason = '';
}
```

#### C. Make Part Numbers Clickable
In ALL tabs (SPU BOM, Cartridge, Scanned Inventory), change the part number cell from plain text to a clickable button:

```svelte
<!-- Before -->
<td>{item.partNumber}</td>

<!-- After -->
<td>
    <button
        type="button"
        class="font-mono text-[var(--color-tron-cyan)] hover:underline cursor-pointer"
        onclick={() => openWithdraw(item)}
    >
        {item.partNumber}
    </button>
</td>
```

#### D. Withdraw Modal (add at bottom of component, before closing `</div>`)

```svelte
{#if withdrawModal}
    <!-- Backdrop -->
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div class="w-full max-w-md rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-6 shadow-xl">
            <h2 class="text-lg font-bold text-[var(--color-tron-cyan)]">Withdraw Inventory</h2>

            <div class="mt-3">
                <p class="text-sm text-[var(--color-tron-text)]">
                    <span class="font-mono text-[var(--color-tron-cyan)]">{withdrawModal.partNumber}</span>
                    — {withdrawModal.name}
                </p>
                <p class="text-sm text-[var(--color-tron-text-secondary)]">
                    Current Stock: {withdrawModal.stock}
                </p>
            </div>

            <form
                method="POST"
                action="?/withdraw"
                use:enhance={() => {
                    withdrawing = true;
                    return async ({ result, update }) => {
                        withdrawing = false;
                        if (result.type === 'success') {
                            withdrawModal = null;
                            await update();
                        }
                    };
                }}
            >
                <input type="hidden" name="partId" value={withdrawModal.id} />

                <div class="mt-4">
                    <label class="block text-sm text-[var(--color-tron-text)]">
                        Quantity
                        <input
                            type="number"
                            name="quantity"
                            min="1"
                            step="1"
                            bind:value={withdrawQty}
                            class="mt-1 block w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
                            placeholder="Enter quantity to withdraw"
                            required
                        />
                    </label>
                </div>

                <div class="mt-3">
                    <label class="block text-sm text-[var(--color-tron-text)]">
                        Reason
                        <input
                            type="text"
                            name="reason"
                            bind:value={withdrawReason}
                            class="mt-1 block w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
                            placeholder="e.g., Used in assembly, damaged, expired"
                            required
                        />
                    </label>
                </div>

                <div class="mt-5 flex justify-end gap-3">
                    <button
                        type="button"
                        onclick={() => (withdrawModal = null)}
                        class="rounded px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={withdrawing || !withdrawQty || withdrawQty <= 0 || !withdrawReason.trim()}
                        class="rounded bg-[var(--color-tron-red)] px-4 py-2 text-sm font-semibold text-white transition-opacity disabled:opacity-30"
                    >
                        {withdrawing ? 'Withdrawing...' : 'Withdraw'}
                    </button>
                </div>
            </form>
        </div>
    </div>
{/if}

{#if form?.withdrawSuccess}
    <div class="fixed bottom-4 right-4 z-50 rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-400 shadow-lg">
        {form.withdrawMessage}
    </div>
{/if}
```

## 5. Files to Modify

| File | Change |
|------|--------|
| `src/routes/parts/+page.server.ts` | Add `withdraw` form action (add `InventoryTransaction` import if not present) |
| `src/routes/parts/+page.svelte` | Add modal state, make part numbers clickable, add modal + toast |

### Files NOT to Touch
- Do NOT modify `/parts/withdraw/` (keep as backup)
- Do NOT modify model files
- Surgical edits only — do NOT rewrite from scratch

## 6. Acceptance Criteria

1. Clicking any part number on any tab opens the withdraw modal
2. Modal shows part number, name, and current stock
3. User enters quantity + reason, clicks Withdraw
4. Inventory transaction is created (negative quantity)
5. Part definition `inventoryCount` is decremented
6. Audit log entry is created
7. Page refreshes showing updated stock
8. Success toast appears
9. Works on all 3 tabs (SPU BOM, Cartridge, Scanned Inventory)

## 7. Notes for AI Agent

- **Stack:** SvelteKit 2 + Svelte 5
- **`use:enhance`** for form submission without full page reload
- **Import `InventoryTransaction`** if not already imported in `+page.server.ts`
- **The `stock` value** for the modal: use `inventoryCount` from the part data (already loaded)
- For the Scanned Inventory tab, stock is `item.stock` (from transaction aggregation); for other tabs it's `item.inventoryCount`
- **Only edit** the two files listed
- **Surgical edits only**
