<script lang="ts">
	let { data } = $props();

	let searchInput = $state(data.search || '');

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString('en-US', {
			month: 'short', day: 'numeric', year: 'numeric'
		});
	}

	function stageColor(status: string): string {
		const colors: Record<string, string> = {
			backing: 'bg-gray-500',
			wax_filling: 'bg-blue-600',
			wax_filled: 'bg-blue-500',
			wax_qc: 'bg-blue-400',
			wax_stored: 'bg-indigo-500',
			reagent_filled: 'bg-purple-500',
			inspected: 'bg-violet-500',
			sealed: 'bg-fuchsia-500',
			cured: 'bg-pink-500',
			stored: 'bg-amber-500',
			released: 'bg-[var(--color-tron-green)]',
			shipped: 'bg-[var(--color-tron-cyan)]',
			completed: 'bg-[var(--color-tron-green)]',
			cancelled: 'bg-[var(--color-tron-red)]',
			scrapped: 'bg-[var(--color-tron-red)]',
			voided: 'bg-gray-600'
		};
		return colors[status] || 'bg-gray-500';
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<a href="/cartridge-admin" class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">
			&larr; Back to Cartridge Admin
		</a>
		<h1 class="mt-2 text-2xl font-bold text-[var(--color-tron-text)]">
			Device History Record (DHR)
		</h1>
		<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
			Scan a QR code or search by cartridge ID to view the full manufacturing history with photos.
		</p>
	</div>

	<!-- Search bar -->
	<form method="GET" class="flex gap-3">
		<div class="relative flex-1">
			<svg class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-tron-text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
			</svg>
			<input
				type="text"
				name="q"
				bind:value={searchInput}
				placeholder="Enter cartridge ID or scan QR code (e.g. CART-000123)"
				class="w-full min-h-[44px] rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] pl-10 pr-4 text-sm text-[var(--color-tron-text)] placeholder:text-[var(--color-tron-text-secondary)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
			/>
		</div>
		<button
			type="submit"
			class="min-h-[44px] rounded-lg bg-[var(--color-tron-cyan)] px-6 text-sm font-semibold text-black transition-colors hover:bg-[var(--color-tron-cyan)]/80"
		>
			Search
		</button>
	</form>

	<!-- Results -->
	{#if data.search && data.results.length === 0}
		<div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-tron-border)] py-16">
			<svg class="mb-3 h-12 w-12 text-[var(--color-tron-text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
				<path stroke-linecap="round" stroke-linejoin="round" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
			</svg>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">No cartridges found for "{data.search}"</p>
			<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">Try searching by full cartridge ID or lot QR code</p>
		</div>
	{:else if data.results.length > 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] overflow-hidden">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
						<th class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]">Cartridge ID</th>
						<th class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]">Status</th>
						<th class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]">Assay Type</th>
						<th class="px-4 py-3 text-center font-medium text-[var(--color-tron-text-secondary)]">Photos</th>
						<th class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]">Created</th>
						<th class="px-4 py-3 text-center font-medium text-[var(--color-tron-text-secondary)]"></th>
					</tr>
				</thead>
				<tbody>
					{#each data.results as row}
						<tr class="border-b border-[var(--color-tron-border)] transition-colors hover:bg-[var(--color-tron-bg-secondary)]">
							<td class="px-4 py-3">
								<span class="font-mono text-[var(--color-tron-text)]">{row.cartridgeId}</span>
							</td>
							<td class="px-4 py-3">
								<span class="inline-block rounded px-2 py-0.5 text-xs font-medium text-white {stageColor(row.status)}">
									{row.status.replace(/_/g, ' ')}
								</span>
							</td>
							<td class="px-4 py-3 text-[var(--color-tron-text-secondary)]">
								{row.assayType ?? '---'}
							</td>
							<td class="px-4 py-3 text-center">
								{#if row.photoCount > 0}
									<span class="inline-flex items-center gap-1 rounded bg-[var(--color-tron-cyan)]/10 px-2 py-0.5 text-xs text-[var(--color-tron-cyan)]">
										<svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
											<path stroke-linecap="round" stroke-linejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
										</svg>
										{row.photoCount}
									</span>
								{:else}
									<span class="text-xs text-[var(--color-tron-text-secondary)]">---</span>
								{/if}
							</td>
							<td class="px-4 py-3 text-xs text-[var(--color-tron-text-secondary)]">
								{formatDate(row.createdAt)}
							</td>
							<td class="px-4 py-3 text-center">
								<a
									href="/cartridge-admin/dhr/{row.cartridgeId}"
									class="inline-flex items-center gap-1 rounded-lg bg-[var(--color-tron-cyan)] px-3 py-1.5 text-xs font-semibold text-black transition-colors hover:bg-[var(--color-tron-cyan)]/80"
								>
									View DHR
									<svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
										<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
									</svg>
								</a>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<!-- Landing state -->
		<div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-tron-border)] py-20">
			<svg class="mb-4 h-16 w-16 text-[var(--color-tron-text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
				<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
			</svg>
			<p class="text-sm font-medium text-[var(--color-tron-text)]">Scan a QR code to get started</p>
			<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
				Search by cartridge ID, lot QR code, or lot number
			</p>
		</div>
	{/if}
</div>
