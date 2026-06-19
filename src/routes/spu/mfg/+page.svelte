<script lang="ts">
	import { goto } from '$app/navigation';
	import { TronCard } from '$lib/components/ui';
	import SpuStatusBadge from '$lib/components/spu/SpuStatusBadge.svelte';

	let { data } = $props();

	let search = $state('');

	// Search filters the visible widgets live.
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
</script>

<div class="space-y-5">
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
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each filtered as s (s.id)}
				{@const valComplete = s.validationPassed >= s.validationTotal}
				<a href="/spu/{s.id}" class="block">
					<TronCard interactive>
						<div class="flex items-start justify-between gap-2">
							<div class="min-w-0">
								<div class="truncate font-mono text-sm font-bold text-[var(--color-tron-cyan)]" title={s.udi}>
									{s.udi}
								</div>
								<div class="tron-text-muted mt-0.5 truncate font-mono text-xs" title={s.deviceId ?? ''}>
									Device ID: {s.deviceId ?? '—'}
								</div>
							</div>
							<SpuStatusBadge status={s.status} />
						</div>

						<div class="mt-3">
							<span
								class="inline-block rounded-full px-2 py-0.5 text-xs font-bold"
								style="color: {valComplete ? 'var(--color-tron-green)' : 'var(--color-tron-red)'}; background: {valComplete ? 'rgba(0,255,100,0.15)' : 'rgba(255,0,0,0.15)'};"
							>
								Validation {s.validationPassed}/{s.validationTotal}
							</span>
						</div>
					</TronCard>
				</a>
			{/each}
		</div>
	{/if}
</div>
