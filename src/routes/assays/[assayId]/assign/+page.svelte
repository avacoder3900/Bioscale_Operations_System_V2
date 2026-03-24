<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let selected = $state(new Set<string>());
	let assigning = $state(false);
	let searchFilter = $state('');

	const filteredCartridges = $derived(
		data.cartridges.filter(
			(c) =>
				c.barcode.toLowerCase().includes(searchFilter.toLowerCase()) ||
				c.lotNumber.toLowerCase().includes(searchFilter.toLowerCase())
		)
	);

	function toggleCartridge(barcode: string) {
		const next = new Set(selected);
		if (next.has(barcode)) {
			next.delete(barcode);
		} else {
			next.add(barcode);
		}
		selected = next;
	}

	function selectAll() {
		if (selected.size === filteredCartridges.length && filteredCartridges.length > 0) {
			selected = new Set();
		} else {
			selected = new Set(filteredCartridges.map((c) => c.barcode));
		}
	}

	function getStatusColor(status: string) {
		const colors: Record<string, string> = {
			available: 'var(--color-tron-green, #39ff14)',
			in_use: 'var(--color-tron-cyan, #00ffff)',
			depleted: '#6b7280',
			expired: '#ef4444',
			quarantine: '#f97316',
			disposed: '#6b7280'
		};
		return colors[status] ?? '#6b7280';
	}
</script>

<div class="mx-auto max-w-4xl space-y-6 p-4">
	<div>
		<a
			href="/assays/{data.assay.assayId}"
			class="text-sm"
			style="color: var(--color-tron-text-secondary, #9ca3af)"
		>
			&larr; Back to Assay
		</a>
		<h1 class="mt-1 text-2xl font-bold" style="color: var(--color-tron-cyan, #00ffff)">
			Assign Assay: {data.assay.name}
		</h1>
		<p class="mt-1 text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">
			Select cartridges or scan barcodes to assign this assay to.
		</p>
	</div>

	<!-- Result -->
	{#if form?.success}
		<div class="tron-card p-4" style="border-left: 3px solid var(--color-tron-green, #39ff14)">
			<div class="font-medium" style="color: var(--color-tron-green, #39ff14)">
				Assigned to {form.assigned} cartridge{form.assigned !== 1 ? 's' : ''}
			</div>
			{#if form.errors?.length}
				<div class="mt-2 space-y-1">
					{#each form.errors as err}
						<div class="text-xs" style="color: #ef4444">{err}</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	{#if form?.error}
		<div class="tron-card p-4" style="border-left: 3px solid #ef4444">
			<div class="text-sm" style="color: #ef4444">{form.error}</div>
		</div>
	{/if}

	<form
		method="POST"
		action="?/assign"
		use:enhance={() => {
			assigning = true;
			return async ({ update }) => {
				assigning = false;
				selected = new Set();
				await update();
			};
		}}
	>
		<!-- Barcode Scanner Input -->
		<div class="tron-card mb-4 p-4">
			<h2 class="mb-2 text-sm font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
				Scan Barcodes
			</h2>
			<textarea
				name="barcodes"
				class="tron-input w-full"
				style="min-height: 66px"
				placeholder="Enter barcodes (one per line or comma-separated)..."
			></textarea>
		</div>

		<!-- Cartridge Selection -->
		<div class="tron-card p-4">
			<div class="mb-3 flex items-center justify-between">
				<h2 class="text-sm font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
					Or Select from List ({selected.size} selected)
				</h2>
				<div class="flex gap-2">
					<button
						type="button"
						class="tron-button text-xs"
						style="min-height: 36px; border-color: #f97316; color: #f97316"
						onclick={selectAll}
					>
						{selected.size === filteredCartridges.length && filteredCartridges.length > 0 ? '&#9881; Deselect All' : '&#9881; Select All'}
					</button>
					<input
						type="text"
						class="tron-input"
						style="min-height: 36px; max-width: 200px"
						placeholder="Filter..."
						bind:value={searchFilter}
					/>
				</div>
			</div>

			<div class="max-h-80 overflow-y-auto">
				{#if filteredCartridges.length === 0}
					<p
						class="py-4 text-center text-sm"
						style="color: var(--color-tron-text-secondary, #9ca3af)"
					>
						No cartridges found.
					</p>
				{:else}
					<table class="tron-table w-full">
						<thead>
							<tr>
								<th style="width: 40px"></th>
								<th>Barcode</th>
								<th>Lot</th>
								<th>Type</th>
								<th>Status</th>
							</tr>
						</thead>
						<tbody>
							{#each filteredCartridges as cart (cart.id)}
								<tr class="cursor-pointer" onclick={() => toggleCartridge(cart.barcode)}>
									<td>
										<input
											type="checkbox"
											name="selected"
											value={cart.barcode}
											checked={selected.has(cart.barcode)}
											onchange={() => toggleCartridge(cart.barcode)}
											style="min-width: 20px; min-height: 20px; accent-color: var(--color-tron-cyan, #00ffff)"
										/>
									</td>
									<td class="font-mono text-xs" style="color: var(--color-tron-cyan, #00ffff)">
										{cart.barcode}
									</td>
									<td class="text-xs">{cart.lotNumber}</td>
									<td class="text-xs capitalize">{cart.cartridgeType}</td>
									<td>
										<span
											class="rounded px-1.5 py-0.5 text-xs"
											style="color: {getStatusColor(
												cart.status
											)}; border: 1px solid {getStatusColor(cart.status)}"
										>
											{cart.status}
										</span>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</div>
		</div>

		<button
			type="submit"
			disabled={assigning}
			class="tron-button mt-4 w-full"
			style="min-height: 44px; background: var(--color-tron-green, #39ff14); color: #000; font-weight: 600"
		>
			{assigning ? 'Assigning...' : 'Assign Assay'}
		</button>
	</form>
</div>
