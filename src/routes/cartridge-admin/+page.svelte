<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import PartsNav from '$lib/components/PartsNav.svelte';
	import type { LifecycleStage } from '$lib/server/services/cartridge-admin/queries';

	let { data } = $props();

	let searchInput = $state(data.filters.search ?? '');
	let expandedId = $state<string | null>(null);

	type DhrPhoto = { imageId: string; phase: string | null; capturedAt: string | null; url: string | null; thumbnailUrl: string | null; label?: string | null; inspectionResult?: string | null; confidenceScore?: number | null };
	type DhrTimeline = { step: string; timestamp: string | null; operator: string | null; details: Record<string, any>; lotIds: string[]; photos: DhrPhoto[] };
	type DhrDetails = {
		cartridge: { cartridgeId: string; status: string; voidedAt?: string | null; voidReason?: string | null; createdAt?: string; updatedAt?: string };
		timeline: DhrTimeline[];
		photos: DhrPhoto[];
		inspections: Array<{ inspectionId: string; phase: string; result: string; confidenceScore?: number; defects?: string[]; completedAt?: string }>;
		transactions: any[];
		linkedLots: Array<{ _id: string; lotId?: string; lotNumber?: string; part?: any; status?: string }>;
	};

	const detailCache = $state<Record<string, DhrDetails | 'loading' | 'error'>>({});
	let lightboxUrl = $state<string | null>(null);

	async function expandRow(cartridgeId: string) {
		expandedId = expandedId === cartridgeId ? null : cartridgeId;
		if (expandedId !== cartridgeId) return;
		if (detailCache[cartridgeId]) return;
		detailCache[cartridgeId] = 'loading';
		try {
			const res = await fetch(`/api/cartridge-admin/dhr/${encodeURIComponent(cartridgeId)}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = await res.json();
			detailCache[cartridgeId] = body as DhrDetails;
		} catch {
			detailCache[cartridgeId] = 'error';
		}
	}

	function fmtDate(value: string | null | undefined): string {
		if (!value) return '—';
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
	}

	const STAGES: LifecycleStage[] = ['backing', 'wax_filled', 'wax_qc', 'wax_stored', 'reagent_filled', 'inspected', 'sealed', 'cured', 'stored', 'released', 'shipped', 'assay_loaded', 'testing', 'completed', 'voided'];

	function stageLabel(stage: string): string {
		return stage.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
	}

	const stageColors: Record<string, string> = {
		backing: 'bg-gray-900/50 text-gray-300 border-gray-500/30',
		wax_filled: 'bg-blue-900/50 text-blue-300 border-blue-500/30',
		wax_qc: 'bg-cyan-900/50 text-cyan-300 border-cyan-500/30',
		wax_stored: 'bg-violet-900/50 text-violet-300 border-violet-500/30',
		reagent_filled: 'bg-green-900/50 text-green-300 border-green-500/30',
		inspected: 'bg-yellow-900/50 text-yellow-300 border-yellow-500/30',
		sealed: 'bg-purple-900/50 text-purple-300 border-purple-500/30',
		cured: 'bg-teal-900/50 text-teal-300 border-teal-500/30',
		stored: 'bg-emerald-900/50 text-emerald-300 border-emerald-500/30',
		released: 'bg-lime-900/50 text-lime-300 border-lime-500/30',
		shipped: 'bg-sky-900/50 text-sky-300 border-sky-500/30',
		assay_loaded: 'bg-amber-900/50 text-amber-300 border-amber-500/30',
		testing: 'bg-orange-900/50 text-orange-300 border-orange-500/30',
		completed: 'bg-green-900/50 text-green-300 border-green-500/30',
		voided: 'bg-red-950/50 text-red-400 border-red-700/30'
	};

	function updateFilters(params: Record<string, string | undefined>) {
		const url = new URL($page.url);
		for (const [key, val] of Object.entries(params)) {
			if (val) url.searchParams.set(key, val);
			else url.searchParams.delete(key);
		}
		url.searchParams.set('page', '1');
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- URL built from current page
		goto(url.toString(), { invalidateAll: true });
	}

	function doSearch() {
		updateFilters({ search: searchInput || undefined });
	}

	function toggleSort(col: string) {
		const newDir = data.filters.sortBy === col && data.filters.sortDir === 'asc' ? 'desc' : 'asc';
		updateFilters({ sortBy: col, sortDir: newDir });
	}

	const totalPages = $derived(Math.ceil(data.total / data.pageSize));
</script>

<div class="space-y-4">
	<PartsNav />
	<!-- Search + Filters -->
	<div class="flex flex-wrap gap-2">
		<div class="flex flex-1 gap-2">
			<input
				bind:value={searchInput}
				onkeydown={(e) => { if (e.key === 'Enter') doSearch(); }}
				placeholder="Search cartridge ID or lot..."
				class="min-h-[44px] min-w-[200px] flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
			/>
			<button type="button" onclick={doSearch}
				class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)]"
			>
				Search
			</button>
		</div>

		<select onchange={(e) => updateFilters({ assayType: e.currentTarget.value || undefined })}
			class="min-h-[44px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
		>
			<option value="">All Assay Types</option>
			{#each data.assayTypes as at (at.id)}
				<option value={at.id} selected={data.filters.assayTypeId === at.id}>{at.name}</option>
			{/each}
		</select>

		<select onchange={(e) => updateFilters({ stage: e.currentTarget.value || undefined })}
			class="min-h-[44px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
		>
			<option value="">All Stages</option>
			{#each STAGES as stage (stage)}
				<option value={stage} selected={data.filters.lifecycleStage === stage}>{stageLabel(stage)}</option>
			{/each}
		</select>

		<select onchange={(e) => updateFilters({ operator: e.currentTarget.value || undefined })}
			class="min-h-[44px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
		>
			<option value="">All Operators</option>
			{#each data.operators as op (op.id)}
				<option value={op.id} selected={data.filters.operatorId === op.id}>{op.name}</option>
			{/each}
		</select>
	</div>

	<p class="text-xs text-[var(--color-tron-text-secondary)]">
		Showing {data.cartridges.length} of {data.total} cartridges
	</p>

	<!-- Table -->
	<div class="overflow-x-auto rounded border border-[var(--color-tron-border)]">
		<table class="w-full text-sm">
			<thead>
				<tr class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
					{#each [
						{ key: 'date_created', label: 'Cartridge ID' },
						{ key: '', label: 'Backed Lot' },
						{ key: 'assay_type', label: 'Assay Type' },
						{ key: '', label: 'Wax Run' },
						{ key: '', label: 'Reagent Run' },
						{ key: 'current_status', label: 'Stage' },
						{ key: 'operator', label: 'Operator' },
						{ key: 'date_created', label: 'Created' },
						{ key: '', label: 'Expiration' },
						{ key: '', label: 'Storage' }
					] as col (col.label)}
						<th class="px-3 py-2 text-left font-medium text-[var(--color-tron-text-secondary)]">
							{#if col.key}
								<button type="button" onclick={() => toggleSort(col.key)} class="hover:text-[var(--color-tron-cyan)]">
									{col.label}
									{#if data.filters.sortBy === col.key}
										<span class="text-[var(--color-tron-cyan)]">{data.filters.sortDir === 'asc' ? '\u2191' : '\u2193'}</span>
									{/if}
								</button>
							{:else}
								{col.label}
							{/if}
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each data.cartridges as c (c.cartridgeId)}
					<tr
						class="cursor-pointer border-b border-[var(--color-tron-border)]/50 hover:bg-[var(--color-tron-surface)]/50"
						onclick={() => expandRow(c.cartridgeId)}
					>
						<td class="px-3 py-2 font-mono text-xs text-[var(--color-tron-text)]">{c.cartridgeId}</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{c.backedLotId}</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text)]">{c.assayTypeName ?? '—'}</td>
						<td class="px-3 py-2 font-mono text-xs text-[var(--color-tron-text-secondary)]">{c.waxRunId ?? '—'}</td>
						<td class="px-3 py-2 font-mono text-xs text-[var(--color-tron-text-secondary)]">{c.reagentRunId ?? '—'}</td>
						<td class="px-3 py-2">
							<span class="rounded border px-1.5 py-0.5 text-xs font-medium {stageColors[c.currentLifecycleStage] ?? ''}">
								{c.currentLifecycleStage}
							</span>
						</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{c.operatorName ?? '—'}</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{new Date(c.createdAt).toLocaleDateString()}</td>
						<td class="px-3 py-2 text-xs">
							{#if c.expirationDate}
								{@const expDate = new Date(c.expirationDate)}
								{@const daysRemaining = Math.ceil((expDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))}
								<span class="{daysRemaining <= 0 ? 'font-bold text-[var(--color-tron-error)]' : daysRemaining <= 7 ? 'text-[var(--color-tron-error)]' : daysRemaining <= 14 ? 'text-[var(--color-tron-yellow)]' : 'text-[var(--color-tron-text-secondary)]'}">
									{expDate.toLocaleDateString()}
									{#if daysRemaining <= 14}
										<span class="ml-1 text-[10px]">({daysRemaining}d)</span>
									{/if}
								</span>
							{:else}
								<span class="text-[var(--color-tron-text-secondary)]">—</span>
							{/if}
						</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{c.storageLocation ?? '—'}</td>
					</tr>
					{#if expandedId === c.cartridgeId}
						<tr>
							<td colspan="10" class="bg-[var(--color-tron-surface)]/50 px-4 py-3">
								<!-- Always-available summary metadata (from list query) -->
								<div class="mb-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
									<div><span class="text-[var(--color-tron-text-secondary)]">Wax Status:</span> <span class="ml-1 text-[var(--color-tron-text)]">{c.waxStatus ?? 'N/A'}</span></div>
									<div><span class="text-[var(--color-tron-text-secondary)]">Wax QC:</span> <span class="ml-1 text-[var(--color-tron-text)]">{c.waxQcStatus ?? 'N/A'}</span></div>
									<div><span class="text-[var(--color-tron-text-secondary)]">Inspection:</span> <span class="ml-1 text-[var(--color-tron-text)]">{c.inspectionStatus ?? 'N/A'}</span></div>
									<div><span class="text-[var(--color-tron-text-secondary)]">Top Seal Batch:</span> <span class="ml-1 font-mono text-[var(--color-tron-text)]">{c.topSealBatchId ?? 'N/A'}</span></div>
									<div><span class="text-[var(--color-tron-text-secondary)]">Cooling Tray:</span> <span class="ml-1 text-[var(--color-tron-text)]">{c.coolingTrayId ?? 'N/A'}</span></div>
									<div><span class="text-[var(--color-tron-text-secondary)]">Oven Entry:</span> <span class="ml-1 text-[var(--color-tron-text)]">{c.ovenEntryTime ? new Date(c.ovenEntryTime).toLocaleString() : 'N/A'}</span></div>
									<div><span class="text-[var(--color-tron-text-secondary)]">Photos:</span> <span class="ml-1 text-[var(--color-tron-text)]">{c.photoCount}</span></div>
									<div><a class="text-[var(--color-tron-cyan)] underline" href="/cartridge-admin/dhr/{c.cartridgeId}">Full DHR &rarr;</a></div>
								</div>

								{#if detailCache[c.cartridgeId] === 'loading'}
									<div class="py-4 text-xs text-[var(--color-tron-text-secondary)]">Loading photos and timeline...</div>
								{:else if detailCache[c.cartridgeId] === 'error'}
									<div class="py-4 text-xs text-[var(--color-tron-error)]">Failed to load DHR detail. <a class="underline" href="/cartridge-admin/dhr/{c.cartridgeId}">Open full DHR</a></div>
								{:else if detailCache[c.cartridgeId]}
									{@const det = detailCache[c.cartridgeId] as DhrDetails}

									<!-- Photo strip -->
									{#if det.photos && det.photos.length > 0}
										<div class="mb-4">
											<div class="mb-2 text-xs font-semibold text-[var(--color-tron-text-secondary)]">PHOTOS ({det.photos.length})</div>
											<div class="flex flex-wrap gap-2">
												{#each det.photos as p (p.imageId)}
													{#if p.url}
														<button type="button" onclick={(e) => { e.stopPropagation(); lightboxUrl = p.url; }} class="group relative">
															<img src={p.thumbnailUrl ?? p.url} alt="cartridge photo {p.phase ?? ''}" class="h-20 w-20 rounded border border-[var(--color-tron-border)] object-cover group-hover:border-[var(--color-tron-cyan)]" loading="lazy" />
															<span class="absolute bottom-0 left-0 right-0 truncate bg-black/60 px-1 py-0.5 text-[10px] text-white">{p.phase ?? 'untagged'}</span>
														</button>
													{/if}
												{/each}
											</div>
										</div>
									{/if}

									<!-- Timeline / phase metadata -->
									{#if det.timeline && det.timeline.length > 0}
										<div class="mb-4">
											<div class="mb-2 text-xs font-semibold text-[var(--color-tron-text-secondary)]">TIMELINE</div>
											<div class="space-y-2">
												{#each det.timeline as t}
													<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]/30 p-2">
														<div class="flex items-center justify-between text-xs">
															<span class="font-semibold text-[var(--color-tron-text)]">{t.step.replace(/_/g, ' ')}</span>
															<span class="text-[var(--color-tron-text-secondary)]">{fmtDate(t.timestamp)}</span>
														</div>
														{#if t.operator}
															<div class="text-[11px] text-[var(--color-tron-text-secondary)]">Operator: {t.operator}</div>
														{/if}
														{#if t.details}
															<div class="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] sm:grid-cols-3">
																{#each Object.entries(t.details) as [k, v]}
																	{#if v !== null && v !== undefined && v !== ''}
																		<div>
																			<span class="text-[var(--color-tron-text-secondary)]">{k}:</span>
																			<span class="ml-1 text-[var(--color-tron-text)]">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
																		</div>
																	{/if}
																{/each}
															</div>
														{/if}
														{#if t.photos && t.photos.length > 0}
															<div class="mt-2 flex flex-wrap gap-1">
																{#each t.photos as ph (ph.imageId)}
																	{#if ph.url}
																		<button type="button" onclick={(e) => { e.stopPropagation(); lightboxUrl = ph.url; }}>
																			<img src={ph.thumbnailUrl ?? ph.url} alt="phase photo" class="h-12 w-12 rounded border border-[var(--color-tron-border)] object-cover" loading="lazy" />
																		</button>
																	{/if}
																{/each}
															</div>
														{/if}
													</div>
												{/each}
											</div>
										</div>
									{/if}

									<!-- Inspections + linked lots -->
									{#if det.inspections && det.inspections.length > 0}
										<div class="mb-3">
											<div class="mb-1 text-xs font-semibold text-[var(--color-tron-text-secondary)]">INSPECTIONS</div>
											<ul class="text-[11px]">
												{#each det.inspections as ins}
													<li class="text-[var(--color-tron-text)]">{ins.phase}: {ins.result} {ins.confidenceScore !== undefined ? `(${ins.confidenceScore})` : ''} — {fmtDate(ins.completedAt)}</li>
												{/each}
											</ul>
										</div>
									{/if}
									{#if det.linkedLots && det.linkedLots.length > 0}
										<div class="mb-2">
											<div class="mb-1 text-xs font-semibold text-[var(--color-tron-text-secondary)]">LINKED LOTS</div>
											<ul class="text-[11px]">
												{#each det.linkedLots as lot}
													<li class="text-[var(--color-tron-text)]">{lot.lotNumber ?? lot.lotId ?? lot._id} {lot.status ? `(${lot.status})` : ''}</li>
												{/each}
											</ul>
										</div>
									{/if}

									{#if det.cartridge?.voidedAt}
										<div class="mt-2 rounded border border-red-500/40 bg-red-900/20 p-2 text-xs text-red-300">
											Voided {fmtDate(det.cartridge.voidedAt)} — {det.cartridge.voidReason ?? 'no reason given'}
										</div>
									{/if}
								{/if}
							</td>
						</tr>
					{/if}
				{/each}
				{#if data.cartridges.length === 0}
					<tr>
						<td colspan="10" class="px-4 py-8 text-center text-sm text-[var(--color-tron-text-secondary)]">
							No cartridges found
						</td>
					</tr>
				{/if}
			</tbody>
		</table>
	</div>

	<!-- Pagination -->
	{#if totalPages > 1}
		<div class="flex items-center justify-between">
			<span class="text-xs text-[var(--color-tron-text-secondary)]">Page {data.pageNum} of {totalPages}</span>
			<div class="flex gap-2">
				{#if data.pageNum > 1}
					<button type="button" onclick={() => updateFilters({ page: String(data.pageNum - 1) })}
						class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)]"
					>
						Previous
					</button>
				{/if}
				{#if data.pageNum < totalPages}
					<button type="button" onclick={() => updateFilters({ page: String(data.pageNum + 1) })}
						class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)]"
					>
						Next
					</button>
				{/if}
			</div>
		</div>
	{/if}
</div>

{#if lightboxUrl}
	<button type="button" onclick={() => lightboxUrl = null} class="fixed inset-0 z-50 flex items-center justify-center bg-black/80" aria-label="Close photo">
		<img src={lightboxUrl} alt="cartridge photo" class="max-h-[90vh] max-w-[90vw] rounded shadow-2xl" />
	</button>
{/if}
