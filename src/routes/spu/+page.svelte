<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { TronCard } from '$lib/components/ui';
	import SpuStatusBadge from '$lib/components/spu/SpuStatusBadge.svelte';

	let { data } = $props();

	let search = $state('');
	// Retired units are noise for day-to-day work — hidden unless toggled on.
	let showRetired = $state(false);
	const retiredCount = $derived(data.spus.filter((s) => s.status === 'retired').length);

	// Live Particle connectivity, fetched after mount so the table never waits on
	// the Particle API (SPU-INV-04). Keyed by particleDeviceId.
	type FleetEntry = {
		online: boolean;
		lastHeard: string | null;
		firmwareVersion: string | null;
		systemVersion: string | null;
	};
	let fleet = $state<Record<string, FleetEntry> | null>(null);
	let fleetLoading = $state(true);
	let fleetError = $state(false);

	onMount(async () => {
		try {
			const res = await fetch('/api/particle/status');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = await res.json();
			fleet = body.devices ?? {};
		} catch {
			fleetError = true;
		} finally {
			fleetLoading = false;
		}
	});

	function dev(s: { deviceId: string | null }): FleetEntry | null {
		if (!s.deviceId || !fleet) return null;
		return fleet[s.deviceId] ?? null;
	}

	type Row = (typeof data.spus)[number];
	type SortKey =
		| 'udi'
		| 'deviceId'
		| 'barcode'
		| 'status'
		| 'connected'
		| 'firmware'
		| 'deviceOs'
		| 'lastHeard'
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

	// Status sorts in lifecycle order, not alphabetically (SPU-INV-07 vocabulary).
	const STATUS_ORDER = ['draft', 'assembling', 'validating', 'released', 'servicing', 'retired'];

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
			case 'connected': {
				const d = dev(s);
				// Online first when ascending; unlinked/unknown devices sort last.
				return d ? (d.online ? 0 : 1) : null;
			}
			case 'firmware':
				return dev(s)?.firmwareVersion?.toLowerCase() ?? null;
			case 'deviceOs':
				return dev(s)?.systemVersion?.toLowerCase() ?? null;
			case 'lastHeard': {
				const lh = dev(s)?.lastHeard;
				return lh ? new Date(lh).getTime() : null;
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
		const visible = showRetired ? data.spus : data.spus.filter((s) => s.status !== 'retired');
		const rows = !q
			? [...visible]
			: visible.filter(
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
		{ key: 'connected', label: 'Connected' },
		{ key: 'firmware', label: 'FW' },
		{ key: 'deviceOs', label: 'OS' },
		{ key: 'lastHeard', label: 'Last Heard' },
		{ key: 'batchNumber', label: 'Batch' },
		{ key: 'owner', label: 'Owner' },
		{ key: 'validation', label: 'Validation' },
		{ key: 'created', label: 'Created' }
	];

	function fmtDateTime(d: string | null | undefined): string {
		if (!d) return '—';
		return new Date(d).toLocaleString(undefined, {
			month: 'numeric',
			day: 'numeric',
			year: '2-digit',
			hour: 'numeric',
			minute: '2-digit'
		});
	}
</script>

<div class="space-y-5">
	<div class="flex items-center justify-between gap-4">
		<h1 class="text-xl font-bold text-[var(--color-tron-cyan)]">SPU Inventory</h1>
		<span class="flex items-center gap-4 text-sm">
			{#if fleetError}
				<span class="text-[var(--color-tron-red)]">Particle unavailable</span>
			{/if}
			{#if retiredCount > 0}
				<button
					type="button"
					class="flex items-center gap-2 transition-colors {showRetired ? 'text-[var(--color-tron-cyan)]' : 'tron-text-muted hover:text-[var(--color-tron-cyan)]'}"
					onclick={() => (showRetired = !showRetired)}
					role="switch"
					aria-checked={showRetired}
				>
					<span
						class="relative inline-block h-4 w-8 rounded-full transition-colors"
						style="background: {showRetired ? 'var(--color-tron-cyan)' : 'var(--color-tron-border)'};"
					>
						<span
							class="absolute top-0.5 h-3 w-3 rounded-full bg-[var(--color-tron-bg,#0a0e14)] transition-all"
							style="left: {showRetired ? '18px' : '2px'};"
						></span>
					</span>
					Show retired ({retiredCount})
				</button>
			{/if}
			<span class="tron-text-muted">
				{filtered.length === data.spus.length
					? `${data.spus.length} units`
					: `${filtered.length} of ${data.spus.length} units`}
			</span>
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
							{@const d = dev(s)}
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
								<td class="py-2.5 pr-4 whitespace-nowrap">
									{#if fleetLoading && s.deviceId}
										<span class="tron-text-muted">…</span>
									{:else if d}
										<span class="inline-flex items-center gap-1.5">
											<span
												class="inline-block h-2 w-2 rounded-full"
												style="background: {d.online ? 'var(--color-tron-green)' : 'var(--color-tron-text-secondary)'}; {d.online ? 'box-shadow: 0 0 6px var(--color-tron-green);' : ''}"
											></span>
											<span class={d.online ? 'text-[var(--color-tron-green)]' : 'tron-text-muted'}>
												{d.online ? 'Online' : 'Offline'}
											</span>
										</span>
									{:else}
										<span class="tron-text-muted">—</span>
									{/if}
								</td>
								<td class="py-2.5 pr-4 font-mono text-xs">{d?.firmwareVersion ?? '—'}</td>
								<td class="py-2.5 pr-4 font-mono text-xs">{d?.systemVersion ?? '—'}</td>
								<td class="py-2.5 pr-4 text-xs whitespace-nowrap">{fmtDateTime(d?.lastHeard)}</td>
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
