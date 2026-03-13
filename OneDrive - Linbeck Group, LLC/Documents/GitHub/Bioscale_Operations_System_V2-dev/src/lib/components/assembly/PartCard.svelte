<script lang="ts">
	import { TronCard, TronBadge } from '$lib/components/ui';

	interface BomData {
		supplier: string | null;
		unitCost: string | null;
		expirationDate: Date | null;
		hazardClass: string | null;
	}

	interface InventoryChange {
		previousQuantity: number;
		newQuantity: number;
	}

	interface Props {
		partNumber: string;
		name: string;
		category?: string;
		isCurrent?: boolean;
		isScanned?: boolean;
		lotNumber?: string;
		instruction?: string;
		bomData?: BomData | null;
		inventoryCount?: number | null;
		hasInventoryTracking?: boolean;
		quantityToDeduct?: number;
		inventoryChange?: InventoryChange | null;
	}

	let {
		partNumber,
		name,
		category,
		isCurrent = false,
		isScanned = false,
		lotNumber,
		instruction = 'Scan part barcode',
		bomData = null,
		inventoryCount = null,
		hasInventoryTracking = false,
		quantityToDeduct = 1,
		inventoryChange = null
	}: Props = $props();

	// PRD-INVWI: Inventory status helpers
	const LOW_INVENTORY_THRESHOLD = 10;
	let isLowInventory = $derived(
		hasInventoryTracking && inventoryCount !== null && inventoryCount < LOW_INVENTORY_THRESHOLD
	);
	let isInsufficientInventory = $derived(
		hasInventoryTracking && inventoryCount !== null && inventoryCount < quantityToDeduct
	);

	function formatCurrency(value: string | null): string {
		if (!value) return '';
		const num = parseFloat(value);
		if (isNaN(num)) return '';
		return new Intl.NumberFormat('en-US', {
			style: 'currency',
			currency: 'USD'
		}).format(num);
	}
</script>

<TronCard
	class="{isCurrent
		? 'border-[var(--color-tron-cyan)] shadow-[var(--shadow-tron-glow)]'
		: ''} {isScanned ? 'opacity-60' : ''}"
>
	<div class="flex items-start gap-4">
		{#if isCurrent}
			<div
				class="animate-tron-pulse flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-tron-cyan)]"
			>
				<svg
					class="h-4 w-4 text-[var(--color-tron-bg-primary)]"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M13 7l5 5m0 0l-5 5m5-5H6"
					/>
				</svg>
			</div>
		{:else if isScanned}
			<div
				class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-tron-green)]"
			>
				<svg
					class="h-4 w-4 text-[var(--color-tron-bg-primary)]"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="3"
						d="M5 13l4 4L19 7"
					/>
				</svg>
			</div>
		{:else}
			<div
				class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)]"
			>
				<div class="h-2 w-2 rounded-full bg-[var(--color-tron-text-secondary)]"></div>
			</div>
		{/if}

		<div class="min-w-0 flex-1">
			<div class="mb-1 flex items-center gap-2">
				<span class="tron-text-muted font-mono text-sm">{partNumber}</span>
				{#if category}
					<TronBadge variant="neutral">{category}</TronBadge>
				{/if}
			</div>
			<h4 class="tron-text-primary truncate font-medium">{name}</h4>

			{#if isScanned && lotNumber}
				<p class="mt-2 text-sm">
					<span class="tron-text-muted">Lot:</span>
					<span class="tron-text-primary font-mono">{lotNumber}</span>
				</p>
			{:else if isCurrent}
				<p class="mt-2 text-sm text-[var(--color-tron-cyan)]">{instruction}</p>
			{/if}

			<!-- BOM Data Display -->
			{#if bomData}
				<div class="mt-2 flex flex-wrap gap-3 text-xs">
					{#if bomData.supplier}
						<span class="tron-text-muted">
							Supplier: <span class="tron-text-primary">{bomData.supplier}</span>
						</span>
					{/if}
					{#if bomData.unitCost}
						<span class="tron-text-muted">
							Cost: <span class="text-[var(--color-tron-cyan)]"
								>{formatCurrency(bomData.unitCost)}</span
							>
						</span>
					{/if}
					{#if bomData.hazardClass}
						<TronBadge variant="warning">{bomData.hazardClass}</TronBadge>
					{/if}
				</div>
			{:else if isCurrent}
				<p class="tron-text-muted mt-2 text-xs">No BOM data linked</p>
			{/if}

			<!-- PRD-INVWI: Inventory Status Display -->
			{#if hasInventoryTracking}
				<div class="mt-2 flex flex-wrap items-center gap-2">
					{#if inventoryChange}
						<!-- Show inventory change after scan -->
						<span class="flex items-center gap-1 text-xs">
							<span class="tron-text-muted">Inventory:</span>
							<span class="text-[var(--color-tron-text-secondary)] line-through"
								>{inventoryChange.previousQuantity}</span
							>
							<svg
								class="h-3 w-3 text-[var(--color-tron-cyan)]"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M13 7l5 5m0 0l-5 5m5-5H6"
								/>
							</svg>
							<span class="font-medium text-[var(--color-tron-green)]"
								>{inventoryChange.newQuantity}</span
							>
							<span class="text-[var(--color-tron-green)]"
								>(-{inventoryChange.previousQuantity - inventoryChange.newQuantity})</span
							>
						</span>
					{:else if inventoryCount !== null}
						<!-- Show current inventory -->
						<span class="text-xs">
							<span class="tron-text-muted">Inventory:</span>
							<span
								class={isInsufficientInventory
									? 'font-bold text-[var(--color-tron-red)]'
									: isLowInventory
										? 'text-[var(--color-tron-orange)]'
										: 'tron-text-primary'}>{inventoryCount}</span
							>
						</span>
						{#if isCurrent && quantityToDeduct > 0}
							<span class="text-xs text-[var(--color-tron-text-secondary)]">
								(−{quantityToDeduct} on scan)
							</span>
						{/if}
						{#if isInsufficientInventory}
							<TronBadge variant="error">Insufficient</TronBadge>
						{:else if isLowInventory}
							<TronBadge variant="warning">Low Stock</TronBadge>
						{/if}
					{/if}
				</div>
			{/if}
		</div>
	</div>
</TronCard>
