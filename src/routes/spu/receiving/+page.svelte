<script lang="ts">
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Receiving | Bioscale</title>
</svelte:head>

<div class="mx-auto max-w-7xl p-6">
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
						<th class="tron-text-muted px-4 py-3 font-medium">Docs</th>
					</tr>
				</thead>
				<tbody>
					{#each data.lots as lot}
						<tr class="tron-border-b hover:bg-white/5 border-b cursor-pointer" onclick={() => window.location.href = `/spu/receiving/${lot._id}`}>
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
							<td class="px-4 py-3" onclick={(e) => e.stopPropagation()}>
								{#if lot.cocDocumentUrl}
									<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
									<a href={lot.cocDocumentUrl} target="_blank" rel="noopener noreferrer"
										class="inline-flex items-center gap-1 rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/5 px-2 py-1 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10"
										title="View Certificate of Conformity">
										<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
											<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
										</svg>
										COC
									</a>
								{:else if lot.photos && lot.photos.length > 0}
									<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
									<a href={lot.photos[0]} target="_blank" rel="noopener noreferrer"
										class="inline-flex items-center gap-1 rounded border border-purple-500/30 bg-purple-500/5 px-2 py-1 text-xs text-purple-300 hover:bg-purple-500/10"
										title="View Photo">
										<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
											<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
										</svg>
										Photo
									</a>
								{:else}
									<span class="tron-text-muted text-xs">—</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
