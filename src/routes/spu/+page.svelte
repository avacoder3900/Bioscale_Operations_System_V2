<script lang="ts">
	import { goto } from '$app/navigation';
	import { TronCard } from '$lib/components/ui';
	import SpuStatusBadge from '$lib/components/spu/SpuStatusBadge.svelte';

	let { data } = $props();

	let search = $state('');

	// Search filters the visible rows live.
	let filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return data.spus;
		return data.spus.filter(
			(s) =>
				s.udi.toLowerCase().includes(q) ||
				(s.deviceId && s.deviceId.toLowerCase().includes(q)) ||
				(s.barcode && s.barcode.toLowerCase().includes(q)) ||
				(s.owner && s.owner.toLowerCase().includes(q)) ||
				(s.batchNumber && s.batchNumber.toLowerCase().includes(q))
		);
	});

	// Enter jumps straight to an exact UDI / device-id / barcode match.
	function onEnter() {
		const q = search.trim().toLowerCase();
		if (!q) return;
		const exact = data.spus.find(
			(s) =>
				s.udi.toLowerCase() === q ||
				(s.deviceId && s.deviceId.toLowerCase() === q) ||
				(s.barcode && s.barcode.toLowerCase() === q)
		);
		if (exact) goto(`/spu/${exact.id}`);
	}

	function fmtDate(d: string | Date | null | undefined): string {
		if (!d) return '—';
		return new Date(d).toLocaleDateString();
	}
</script>

<div class="space-y-5">
	<div class="flex items-center justify-between gap-4">
		<h1 class="text-xl font-bold text-[var(--color-tron-cyan)]">SPU Inventory</h1>
		<span class="tron-text-muted text-sm">
			{filtered.length === data.spus.length
				? `${data.spus.length} units`
				: `${filtered.length} of ${data.spus.length} units`}
		</span>
	</div>

	<input
		type="text"
		class="tron-input w-full"
		placeholder="Search SPUs by UDI, device ID, barcode, owner, or batch..."
		bind:value={search}
		onkeydown={(e) => {
			if (e.key === 'Enter') onEnter();
		}}
		style="min-height: 48px;"
	/>

	{#if filtered.length === 0}
		<TronCard>
			<p class="tron-text-muted py-10 text-center">
				No SPUs{search.trim() ? ` match “${search}”` : ' yet'}.
			</p>
		</TronCard>
	{:else}
		<TronCard>
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] text-left">
							<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">UDI</th>
							<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]"
								>Device ID</th
							>
							<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]"
								>Barcode</th
							>
							<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]"
								>Status</th
							>
							<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]"
								>Batch</th
							>
							<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]"
								>Owner</th
							>
							<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]"
								>Validation</th
							>
							<th class="py-2 text-xs uppercase text-[var(--color-tron-text-secondary)]"
								>Created</th
							>
						</tr>
					</thead>
					<tbody>
						{#each filtered as s (s.id)}
							{@const valComplete = s.validationPassed >= s.validationTotal}
							<tr
								class="cursor-pointer border-b border-[var(--color-tron-border)] transition-colors last:border-0 hover:bg-[var(--color-tron-bg-secondary)]"
								onclick={() => goto(`/spu/${s.id}`)}
							>
								<td class="py-2.5 pr-4">
									<a
										href="/spu/{s.id}"
										class="font-mono font-bold text-[var(--color-tron-cyan)]"
										onclick={(e) => e.stopPropagation()}
									>
										{s.udi}
									</a>
								</td>
								<td class="py-2.5 pr-4 font-mono text-xs">{s.deviceId ?? '—'}</td>
								<td class="max-w-48 truncate py-2.5 pr-4 font-mono text-xs" title={s.barcode ?? ''}>
									{s.barcode ?? '—'}
								</td>
								<td class="py-2.5 pr-4"><SpuStatusBadge status={s.status} /></td>
								<td class="py-2.5 pr-4">{s.batchNumber ?? '—'}</td>
								<td class="py-2.5 pr-4">{s.owner ?? '—'}</td>
								<td class="py-2.5 pr-4">
									<span
										class="inline-block rounded-full px-2 py-0.5 text-xs font-bold whitespace-nowrap"
										style="color: {valComplete ? 'var(--color-tron-green)' : 'var(--color-tron-red)'}; background: {valComplete ? 'rgba(0,255,100,0.15)' : 'rgba(255,0,0,0.15)'};"
									>
										{s.validationPassed}/{s.validationTotal}
									</span>
								</td>
								<td class="py-2.5 whitespace-nowrap text-xs">{fmtDate(s.createdAt)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</TronCard>
	{/if}
</div>
