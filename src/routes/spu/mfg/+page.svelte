<script lang="ts">
	import { goto } from '$app/navigation';
	import { TronCard } from '$lib/components/ui';
	import SpuStatusBadge from '$lib/components/spu/SpuStatusBadge.svelte';

	let { data } = $props();

	let search = $state('');

	function shortId(udi: string): string {
		const m = udi.match(/\(21\)(.+)/);
		if (!m) return udi.slice(0, 8).toUpperCase();
		return `SPU-${m[1].slice(0, 8).toUpperCase()}`;
	}

	function qcColor(status: string): string {
		if (status === 'pass' || status === 'passed') return 'var(--color-tron-green)';
		if (status === 'fail' || status === 'failed') return 'var(--color-tron-red)';
		return 'var(--color-tron-orange)';
	}

	// Search filters the visible widgets live.
	let filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return data.spus;
		return data.spus.filter(
			(s) =>
				s.udi.toLowerCase().includes(q) ||
				shortId(s.udi).toLowerCase().includes(q) ||
				(s.barcode && s.barcode.toLowerCase().includes(q)) ||
				(s.owner && s.owner.toLowerCase().includes(q)) ||
				(s.batchNumber && s.batchNumber.toLowerCase().includes(q))
		);
	});

	// Enter jumps straight to an exact match.
	function onEnter() {
		const q = search.trim().toLowerCase();
		if (!q) return;
		const exact = data.spus.find(
			(s) =>
				s.udi.toLowerCase() === q ||
				shortId(s.udi).toLowerCase() === q ||
				(s.barcode && s.barcode.toLowerCase() === q)
		);
		if (exact) goto(`/spu/${exact.id}`);
	}
</script>

<div class="space-y-5">
	<input
		type="text"
		class="tron-input w-full"
		placeholder="Search SPUs by UDI, serial, barcode, owner, or batch..."
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
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each filtered as s (s.id)}
				<a href="/spu/{s.id}" class="block">
					<TronCard interactive>
						<div class="flex items-start justify-between gap-2">
							<div class="min-w-0">
								<div class="text-sm font-bold text-[var(--color-tron-cyan)]">{shortId(s.udi)}</div>
								<div class="tron-text-muted truncate font-mono text-xs" title={s.udi}>{s.udi}</div>
							</div>
							<SpuStatusBadge status={s.status} />
						</div>
						<div class="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
							<span
								class="rounded px-1.5 py-0.5 font-medium"
								style="background: color-mix(in srgb, {qcColor(s.qcStatus)} 20%, transparent); color: {qcColor(s.qcStatus)};"
							>
								QC: {s.qcStatus}
							</span>
							{#if s.owner}
								<span class="tron-text-muted">· {s.owner}</span>
							{/if}
							{#if s.batchNumber}
								<span class="tron-text-muted">· Batch {s.batchNumber}</span>
							{/if}
						</div>
					</TronCard>
				</a>
			{/each}
		</div>
	{/if}
</div>
