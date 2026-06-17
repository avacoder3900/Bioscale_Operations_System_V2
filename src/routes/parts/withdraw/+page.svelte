<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard, TronButton } from '$lib/components/ui';

	let { data, form } = $props();

	let searchQuery = $state('');
	let selectedPartId = $state('');
	let quantity = $state('');
	let reason = $state('');
	let submitting = $state(false);

	const quickReasons = [
		'Lab use',
		'Testing / QC',
		'R&D prototype',
		'Damaged / defective',
		'Expired',
		'Customer sample',
		'Other'
	];

	let filteredParts = $derived.by(() => {
		if (!searchQuery) return data.parts ?? [];
		const q = searchQuery.toLowerCase();
		return (data.parts ?? []).filter(
			(p: any) =>
				p.partNumber?.toLowerCase().includes(q) ||
				p.name?.toLowerCase().includes(q) ||
				p.barcode?.toLowerCase().includes(q)
		);
	});

	let selectedPart = $derived(
		(data.parts ?? []).find((p: any) => p._id === selectedPartId) as any
	);

	function selectPart(part: any) {
		selectedPartId = part._id;
		searchQuery = `${part.partNumber} — ${part.name}`;
	}

	function clearSelection() {
		selectedPartId = '';
		searchQuery = '';
		quantity = '';
		reason = '';
	}

	function selectReason(r: string) {
		reason = r;
	}
</script>

<div class="max-w-2xl mx-auto py-6 px-4 space-y-4">
	<div class="flex items-center gap-3 mb-2">
		<a href="/parts?tab=scanned" class="text-[var(--color-tron-cyan)] hover:underline text-sm">&larr; Back to Parts</a>
		<h1 class="text-lg font-bold text-[var(--color-tron-text)]">Withdraw Inventory</h1>
	</div>

	{#if form?.success}
		<div class="bg-green-900/30 border border-green-500/40 rounded px-4 py-3 text-sm text-green-300">
			{form.message}
			<button class="ml-3 underline text-xs" onclick={() => clearSelection()}>Withdraw another</button>
		</div>
	{/if}

	{#if form?.error}
		<div class="bg-red-900/30 border border-red-500/40 rounded px-4 py-3 text-sm text-red-300">
			{form.error}
		</div>
	{/if}

	<TronCard>
		<form method="POST" action="?/withdraw" use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				submitting = false;
				await update();
			};
		}}>
			<input type="hidden" name="partId" value={selectedPartId} />

			<!-- Part Lookup -->
			<div class="mb-4">
				<label class="block text-xs font-semibold text-[var(--color-tron-text-secondary)] mb-1">Part Lookup</label>
				{#if selectedPart}
					<div class="flex items-center gap-3 bg-[var(--color-tron-cyan)]/10 border border-[var(--color-tron-cyan)]/30 rounded px-3 py-2">
						<div class="flex-1">
							<span class="font-mono text-[var(--color-tron-cyan)] text-sm">{selectedPart.partNumber}</span>
							<span class="text-[var(--color-tron-text)] text-sm ml-2">{selectedPart.name}</span>
							<span class="text-[var(--color-tron-text-secondary)] text-xs ml-2">Stock: <span class="font-mono">{selectedPart.inventoryCount ?? 0}</span></span>
						</div>
						<button type="button" class="text-xs text-red-400 hover:text-red-300" onclick={() => clearSelection()}>Clear</button>
					</div>
				{:else}
					<input
						type="text"
						placeholder="Search by part #, name, or barcode..."
						class="tron-input w-full text-sm"
						bind:value={searchQuery}
					/>
					{#if searchQuery.length >= 1}
						<div class="mt-1 max-h-48 overflow-y-auto border border-[var(--color-tron-border)] rounded bg-[var(--color-tron-bg-secondary)]">
							{#each filteredParts.slice(0, 20) as part (part._id)}
								<button
									type="button"
									class="w-full text-left px-3 py-2 hover:bg-white/5 text-sm flex justify-between items-center border-b border-[var(--color-tron-border)]/30 last:border-b-0"
									onclick={() => selectPart(part)}
								>
									<div>
										<span class="font-mono text-[var(--color-tron-cyan)]">{part.partNumber}</span>
										<span class="text-[var(--color-tron-text)] ml-2">{part.name}</span>
									</div>
									<span class="text-xs text-[var(--color-tron-text-secondary)] font-mono">{part.inventoryCount ?? 0} in stock</span>
								</button>
							{:else}
								<div class="px-3 py-2 text-sm text-[var(--color-tron-text-secondary)]">No parts found</div>
							{/each}
						</div>
					{/if}
				{/if}
			</div>

			<!-- Quantity -->
			<div class="mb-4">
				<label class="block text-xs font-semibold text-[var(--color-tron-text-secondary)] mb-1" for="qty">Quantity</label>
				<input
					id="qty"
					type="number"
					name="quantity"
					min="1"
					step="1"
					placeholder="Enter qty to withdraw"
					class="tron-input w-full max-w-xs text-sm"
					bind:value={quantity}
				/>
				{#if selectedPart && quantity && Number(quantity) > (selectedPart.inventoryCount ?? 0)}
					<p class="text-yellow-400 text-xs mt-1">Warning: withdrawing more than current stock ({selectedPart.inventoryCount ?? 0})</p>
				{/if}
			</div>

			<!-- Reason -->
			<div class="mb-5">
				<label class="block text-xs font-semibold text-[var(--color-tron-text-secondary)] mb-1">Reason</label>
				<div class="flex flex-wrap gap-2 mb-2">
					{#each quickReasons as r}
						<button
							type="button"
							class="px-3 py-1 text-xs rounded border transition-colors {reason === r
								? 'bg-[var(--color-tron-cyan)]/20 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
								: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)]/50'}"
							onclick={() => selectReason(r)}
						>
							{r}
						</button>
					{/each}
				</div>
				<input
					type="text"
					name="reason"
					placeholder="Or type a custom reason..."
					class="tron-input w-full text-sm"
					bind:value={reason}
				/>
			</div>

			<!-- Submit -->
			<div class="flex items-center gap-3">
				<TronButton type="submit" variant="default" disabled={submitting || !selectedPartId || !quantity || !reason}>
					{submitting ? 'Withdrawing...' : 'Withdraw'}
				</TronButton>
				<span class="text-xs text-[var(--color-tron-text-secondary)]">This will record a consumption transaction.</span>
			</div>
		</form>
	</TronCard>
</div>
