<script lang="ts">
	import type { PageData } from './$types';
	import PartsNav from '$lib/components/PartsNav.svelte';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Receiving | Bioscale</title>
</svelte:head>

<div class="mx-auto max-w-7xl p-6">
	<PartsNav />
	<div class="mb-6 flex items-center justify-between">
		<h1 class="tron-text text-2xl font-bold">Receiving of Goods</h1>
		<a href="/spu/receiving/new" class="tron-button px-4 py-2 text-sm font-medium">
			+ New Receiving
		</a>
	</div>

	{#if data.lots.length === 0}
		<div class="tron-card p-8 text-center">
			<p class="tron-text-muted">No receiving lots yet. Start by receiving goods.</p>
		</div>
	{:else}
		<div class="tron-card overflow-hidden">
			<table class="w-full text-left text-sm">
				<thead>
					<tr class="tron-border-b border-b">
						<th class="tron-text-muted px-4 py-3 font-medium">Lot ID</th>
						<th class="tron-text-muted px-4 py-3 font-medium">Part #</th>
						<th class="tron-text-muted px-4 py-3 font-medium">Part Name</th>
						<th class="tron-text-muted px-4 py-3 font-medium">Qty</th>
						<th class="tron-text-muted px-4 py-3 font-medium">Date</th>
						<th class="tron-text-muted px-4 py-3 font-medium">Pathway</th>
						<th class="tron-text-muted px-4 py-3 font-medium">Status</th>
					</tr>
				</thead>
				<tbody>
					{#each data.lots as lot}
						<tr class="tron-border-b hover:bg-white/5 border-b">
							<td class="px-4 py-3">
								<span class="tron-text font-mono text-xs">{lot.lotId}</span>
							</td>
							<td class="tron-text px-4 py-3 font-mono text-xs">{lot.part?.partNumber ?? '—'}</td>
							<td class="tron-text px-4 py-3">{lot.part?.name ?? '—'}</td>
							<td class="tron-text px-4 py-3">{lot.quantity}</td>
							<td class="tron-text-muted px-4 py-3 text-xs">
								{lot.createdAt ? new Date(lot.createdAt).toLocaleDateString() : '—'}
							</td>
							<td class="px-4 py-3">
								<span class="rounded px-2 py-0.5 text-xs font-medium uppercase {lot.inspectionPathway === 'coc' ? 'bg-blue-500/20 text-blue-400' : 'bg-orange-500/20 text-orange-400'}">
									{lot.inspectionPathway}
								</span>
							</td>
							<td class="px-4 py-3">
								<span class="rounded px-2 py-0.5 text-xs font-medium {lot.status === 'accepted' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}">
									{lot.status}
								</span>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
