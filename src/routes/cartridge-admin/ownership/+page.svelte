<script lang="ts">
	import { TronCard, TronBadge } from '$lib/components/ui';

	let { data } = $props();

	const FILTERS = [
		{ key: 'unmatched', label: 'Unmatched claims' },
		{ key: 'claims', label: 'All claims' },
		{ key: 'shipment', label: 'From shipments' },
		{ key: 'all', label: 'All open' }
	];

	const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
	const pages = $derived(Math.max(1, Math.ceil(data.total / data.limit)));
</script>

<svelte:head><title>Consumer ownership · BIMS</title></svelte:head>

<div class="space-y-6">
	<div>
		<a href="/cartridge-admin" class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">
			&larr; Back to Cartridge Admin
		</a>
		<h1 class="mt-2 text-2xl font-bold text-[var(--color-tron-text)]">Consumer ownership</h1>
		<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
			Which app account or clinic each cartridge belongs to. {data.openTotal} open ·
			<span class={data.unmatchedTotal ? 'text-[var(--color-tron-yellow)]' : ''}>{data.unmatchedTotal} claimed without a matching shipment</span>
		</p>
	</div>

	<div class="flex flex-wrap gap-2">
		{#each FILTERS as f (f.key)}
			<a
				href="/cartridge-admin/ownership?filter={f.key}"
				class="rounded border px-3 py-1 text-sm {data.filter === f.key
					? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
					: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
			>
				{f.label}
			</a>
		{/each}
	</div>

	<TronCard>
		{#if data.rows.length === 0}
			<p class="tron-text-muted py-6 text-center text-sm">Nothing to show for this filter.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="tron-table">
					<thead>
						<tr>
							<th>Cartridge</th>
							<th>Assay</th>
							<th>Source</th>
							<th>Shipment</th>
							<th>Account</th>
							<th>Customer</th>
							<th>Patient</th>
							<th>Since</th>
						</tr>
					</thead>
					<tbody>
						{#each data.rows as r (r.id)}
							<tr>
								<td class="font-mono text-xs">
									<a href="/cartridge-admin/dhr/{r.cartridgeId}" class="text-[var(--color-tron-cyan)] hover:underline">{r.cartridgeId}</a>
									{#if r.cartridgeStatus}<span class="tron-text-muted ml-1">({r.cartridgeStatus})</span>{/if}
								</td>
								<td class="text-sm">{r.assayName ?? '—'}</td>
								<td><TronBadge variant={r.source === 'shipment' ? 'info' : 'neutral'}>{r.source}</TronBadge></td>
								<td>
									{#if r.source === 'shipment' || r.matchedShipment}
										<TronBadge variant="success">matched</TronBadge>
									{:else if r.shipmentCustomerName}
										<TronBadge variant="warning">shipped to {r.shipmentCustomerName}</TronBadge>
									{:else}
										<TronBadge variant="warning">never shipped</TronBadge>
									{/if}
								</td>
								<td class="text-sm">
									{r.accountEmail ?? '—'}
									{#if r.accountName}<span class="tron-text-muted block text-xs">{r.accountName}</span>{/if}
								</td>
								<td class="text-sm">{r.customerName ?? '—'}</td>
								<td class="font-mono text-xs">{r.subjectId ?? (r.customerName ? 'unassigned' : 'self')}</td>
								<td class="text-sm whitespace-nowrap">{fmt(r.claimedAt)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if pages > 1}
				<div class="tron-text-muted mt-4 flex items-center justify-between text-sm">
					<span>Page {data.page} of {pages} · {data.total} rows</span>
					<span class="flex gap-2">
						{#if data.page > 1}
							<a class="text-[var(--color-tron-cyan)] hover:underline" href="/cartridge-admin/ownership?filter={data.filter}&page={data.page - 1}">Previous</a>
						{/if}
						{#if data.page < pages}
							<a class="text-[var(--color-tron-cyan)] hover:underline" href="/cartridge-admin/ownership?filter={data.filter}&page={data.page + 1}">Next</a>
						{/if}
					</span>
				</div>
			{/if}
		{/if}
	</TronCard>
</div>
