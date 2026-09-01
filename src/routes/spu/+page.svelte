<script lang="ts">
	import { goto } from '$app/navigation';
	import { TronCard } from '$lib/components/ui';
	import SpuStatusBadge from '$lib/components/spu/SpuStatusBadge.svelte';

	let { data } = $props();

	let search = $state('');

	type Row = (typeof data.spus)[number];
	type SortKey =
		| 'udi'
		| 'deviceId'
		| 'barcode'
		| 'status'
		| 'batchNumber'
		| 'owner'
		| 'validation'
		| 'created';

	let sortKey = $state<SortKey>('udi');
	let sortDir = $state<'asc' | 'desc'>('asc');

	function toggleSort(key: SortKey) {
		if (sortKey === key) {
			sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		} else {
			sortKey = key;
			sortDir = 'asc';
		}
	}

	// Status sorts in lifecycle order, not alphabetically.
	const STATUS_ORDER = [
		'draft',
		'assembling',
		'assembled',
		'validating',
		'validated',
		'released-rnd',
		'released-manufacturing',
		'released-field',
		'deployed',
		'servicing',
		'retired',
		'voided'
	];

	function sortValue(s: Row, key: SortKey): string | number | null {
		switch (key) {
			case 'udi':
				return s.udi.toLowerCase();
			case 'deviceId':
				return s.deviceId?.toLowerCase() ?? null;
			case 'barcode':
				return s.barcode?.toLowerCase() ?? null;
			case 'status': {
				const i = STATUS_ORDER.indexOf(s.status);
				return i === -1 ? STATUS_ORDER.length : i;
			}
			case 'batchNumber':
				return s.batchNumber?.toLowerCase() ?? null;
			case 'owner':
				return s.owner?.toLowerCase() ?? null;
			case 'validation':
				return s.validationPassed;
			case 'created':
				return s.createdAt ? new Date(s.createdAt).getTime() : null;
		}
	}

	// Search filters the visible rows live; the active column then orders them.
	// Missing values sort last in both directions.
	let filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		const rows = !q
			? [...data.spus]
			: data.spus.filter(
					(s) =>
						s.udi.toLowerCase().includes(q) ||
						(s.deviceId && s.deviceId.toLowerCase().includes(q)) ||
						(s.barcode && s.barcode.toLowerCase().includes(q)) ||
						(s.owner && s.owner.toLowerCase().includes(q)) ||
						(s.batchNumber && s.batchNumber.toLowerCase().includes(q))
				);
		const dir = sortDir === 'asc' ? 1 : -1;
		return rows.sort((a, b) => {
			const av = sortValue(a, sortKey);
			const bv = sortValue(b, sortKey);
			if (av === null && bv === null) return 0;
			if (av === null) return 1;
			if (bv === null) return -1;
			if (av < bv) return -dir;
			if (av > bv) return dir;
			return 0;
		});
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

	const COLUMNS: { key: SortKey; label: string }[] = [
		{ key: 'udi', label: 'UDI' },
		{ key: 'deviceId', label: 'Device ID' },
		{ key: 'barcode', label: 'Barcode' },
		{ key: 'status', label: 'Status' },
		{ key: 'batchNumber', label: 'Batch' },
		{ key: 'owner', label: 'Owner' },
		{ key: 'validation', label: 'Validation' },
		{ key: 'created', label: 'Created' }
	];
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
							{#each COLUMNS as col (col.key)}
								{@const active = sortKey === col.key}
								<th
									class="py-0 {col.key === 'created' ? '' : 'pr-4'}"
									aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
								>
									<button
										type="button"
										class="flex items-center gap-1 py-2 text-xs uppercase transition-colors hover:text-[var(--color-tron-cyan)] {active
											? 'text-[var(--color-tron-cyan)]'
											: 'text-[var(--color-tron-text-secondary)]'}"
										onclick={() => toggleSort(col.key)}
									>
										{col.label}
										{#if active}
											<span aria-hidden="true">{sortDir === 'asc' ? '▲' : '▼'}</span>
										{/if}
									</button>
								</th>
							{/each}
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
