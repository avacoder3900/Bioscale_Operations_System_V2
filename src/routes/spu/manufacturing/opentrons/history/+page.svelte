<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';

	interface RunRow {
		runId: string;
		processType: 'wax' | 'reagent';
		robotId: string;
		operatorId: string;
		operatorName: string | null;
		assayTypeId: string | null;
		assayTypeName: string | null;
		status: string;
		totalCartridges: number;
		acceptedCartridges: number;
		rejectedCartridges: number;
		startTime: string | null;
		endTime: string | null;
		createdAt: string;
		abortReason: string | null;
	}

	interface RunDetailCartridge {
		cartridgeId: string;
		deckPosition: number | null;
		qcStatus: string;
		rejectionReason: string | null;
		storageLocation: string | null;
	}

	interface RunDetail {
		cartridges: RunDetailCartridge[];
		tubes: { wellPosition: number; reagentName: string; sourceLotId: string; transferTubeId: string }[];
		topSealBatches: { batchId: string; topSealLotId: string; operatorId: string; completionTime: string | null }[];
		abortReason: string | null;
		abortPhotoUrl: string | null;
		createdAt: string | null;
		startTime: string | null;
		endTime: string | null;
	}

	interface Props {
		data: {
			runs: RunRow[];
			total: number;
			summary: {
				totalRuns: number;
				completedRuns: number;
				abortedRuns: number;
				successRate: number;
				avgDurationMinutes: number;
				totalCartridges: number;
			};
			pageNum: number;
			pageSize: number;
			robots: { robotId: string; name: string }[];
			operators: { id: string; name: string }[];
			assayTypes: { id: string; name: string }[];
			filters: {
				processType?: 'wax' | 'reagent';
				robotId?: string;
				operatorId?: string;
				status?: string;
				assayTypeId?: string;
				search?: string;
				sortBy: string;
				sortDir: 'asc' | 'desc';
			};
		};
	}

	let { data }: Props = $props();

	let searchInput = $derived(data.filters.search ?? '');
	let expandedId = $state<string | null>(null);
	let expandedDetail = $state<RunDetail | null>(null);
	let detailLoading = $state(false);

	const totalPages = $derived(Math.ceil(data.total / data.pageSize));

	// ---- Filter / sort helpers ----

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

	function setPage(p: number) {
		const url = new URL($page.url);
		url.searchParams.set('page', String(p));
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

	// ---- Expand detail ----

	async function toggleExpand(run: RunRow) {
		if (expandedId === run.runId) {
			expandedId = null;
			expandedDetail = null;
			return;
		}
		expandedId = run.runId;
		expandedDetail = null;
		detailLoading = true;
		try {
			const res = await fetch(`/api/opentrons/history/${run.runId}?type=${run.processType}`);
			if (res.ok) {
				expandedDetail = await res.json();
			}
		} catch {
			// silently fail — empty detail section shown
		} finally {
			detailLoading = false;
		}
	}

	// ---- Badge helpers ----

	function statusBadgeClass(status: string): string {
		switch (status) {
			case 'Completed':
				return 'bg-emerald-900/50 text-emerald-300 border border-emerald-500/30';
			case 'Aborted':
				return 'bg-red-900/50 text-red-300 border border-red-500/30';
			case 'In Progress':
			case 'Running':
				return 'bg-green-900/50 text-green-300 border border-green-500/30';
			case 'Setup':
				return 'bg-blue-900/50 text-blue-300 border border-blue-500/30';
			default:
				return 'bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)] border border-[var(--color-tron-border)]';
		}
	}

	function typeBadgeClass(type: 'wax' | 'reagent'): string {
		return type === 'wax'
			? 'bg-amber-900/50 text-amber-300 border border-amber-500/30'
			: 'bg-blue-900/50 text-blue-300 border border-blue-500/30';
	}

	function qcBadgeClass(status: string): string {
		switch (status) {
			case 'Accepted':
				return 'text-emerald-300';
			case 'Rejected':
				return 'text-red-300';
			default:
				return 'text-[var(--color-tron-text-secondary)]';
		}
	}

	function successPct(run: RunRow): string {
		if (run.totalCartridges === 0) return '—';
		return Math.round((run.acceptedCartridges / run.totalCartridges) * 100) + '%';
	}

	function durationStr(startTime: string | null, endTime: string | null): string {
		if (!startTime || !endTime) return '—';
		const ms = new Date(endTime).getTime() - new Date(startTime).getTime();
		const mins = Math.round(ms / 60000);
		if (mins < 60) return `${mins}m`;
		return `${Math.floor(mins / 60)}h ${mins % 60}m`;
	}

	function formatDate(iso: string | null): string {
		if (!iso) return '—';
		return new Date(iso).toLocaleString();
	}

	// ---- Column definitions ----

	const columns = [
		{ key: 'runId', label: 'Run ID' },
		{ key: 'processType', label: 'Type' },
		{ key: 'robotId', label: 'Robot' },
		{ key: 'operatorName', label: 'Operator' },
		{ key: 'assayTypeName', label: 'Assay Type' },
		{ key: 'status', label: 'Status' },
		{ key: 'totalCartridges', label: 'Cartridges' },
		{ key: 'successRate', label: 'Success %' },
		{ key: 'startTime', label: 'Start Time' },
		{ key: 'duration', label: 'Duration' }
	];
</script>

<div class="space-y-4">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-3">
			<button
				type="button"
				onclick={() => history.back()}
				class="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
				</svg>
			</button>
			<div>
				<h2 class="text-xl font-semibold text-[var(--color-tron-text)]">Run History</h2>
				<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
					Combined wax and reagent filling run history across all robots.
				</p>
			</div>
		</div>
	</div>

	<!-- Summary Stat Cards -->
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
		<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 text-center">
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Total Runs</p>
			<p class="text-lg font-bold text-[var(--color-tron-text)]">{data.summary.totalRuns}</p>
		</div>
		<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 text-center">
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Completed</p>
			<p class="text-lg font-bold text-emerald-300">{data.summary.completedRuns}</p>
		</div>
		<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 text-center">
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Aborted</p>
			<p class="text-lg font-bold text-red-300">{data.summary.abortedRuns}</p>
		</div>
		<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 text-center">
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Success Rate</p>
			<p class="text-lg font-bold text-[var(--color-tron-cyan)]">{Math.round(data.summary.successRate * 100)}%</p>
		</div>
		<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 text-center">
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Avg Duration</p>
			<p class="text-lg font-bold text-[var(--color-tron-text)]">{data.summary.avgDurationMinutes}m</p>
		</div>
		<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 text-center">
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Total Cartridges</p>
			<p class="text-lg font-bold text-[var(--color-tron-text)]">{data.summary.totalCartridges}</p>
		</div>
	</div>

	<!-- Filters -->
	<div class="flex flex-wrap items-end gap-2">
		<!-- Process Type Chips -->
		<div class="flex gap-1">
			{#each [
				{ value: undefined, label: 'All' },
				{ value: 'wax', label: 'Wax' },
				{ value: 'reagent', label: 'Reagent' }
			] as opt (opt.label)}
				<button
					type="button"
					onclick={() => updateFilters({ processType: opt.value })}
					class="rounded px-3 py-1.5 text-xs font-medium transition-colors {data.filters.processType === opt.value
						? 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)] border border-[var(--color-tron-cyan)]/50'
						: 'bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)] border border-[var(--color-tron-border)]'}"
				>
					{opt.label}
				</button>
			{/each}
		</div>

		<!-- Robot -->
		<select
			onchange={(e) => updateFilters({ robotId: e.currentTarget.value || undefined })}
			class="min-h-[36px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-2 py-1 text-xs text-[var(--color-tron-text)]"
		>
			<option value="">All Robots</option>
			{#each data.robots as r (r.robotId)}
				<option value={r.robotId} selected={data.filters.robotId === r.robotId}>{r.name}</option>
			{/each}
		</select>

		<!-- Operator -->
		<select
			onchange={(e) => updateFilters({ operatorId: e.currentTarget.value || undefined })}
			class="min-h-[36px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-2 py-1 text-xs text-[var(--color-tron-text)]"
		>
			<option value="">All Operators</option>
			{#each data.operators as op (op.id)}
				<option value={op.id} selected={data.filters.operatorId === op.id}>{op.name}</option>
			{/each}
		</select>

		<!-- Status -->
		<select
			onchange={(e) => updateFilters({ status: e.currentTarget.value || undefined })}
			class="min-h-[36px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-2 py-1 text-xs text-[var(--color-tron-text)]"
		>
			<option value="">All Statuses</option>
			{#each ['Completed', 'Aborted', 'In Progress', 'Setup', 'Running'] as s (s)}
				<option value={s} selected={data.filters.status === s}>{s}</option>
			{/each}
		</select>

		<!-- Assay Type (visible for All or Reagent) -->
		{#if data.filters.processType !== 'wax'}
			<select
				onchange={(e) => updateFilters({ assayTypeId: e.currentTarget.value || undefined })}
				class="min-h-[36px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-2 py-1 text-xs text-[var(--color-tron-text)]"
			>
				<option value="">All Assay Types</option>
				{#each data.assayTypes as at (at.id)}
					<option value={at.id} selected={data.filters.assayTypeId === at.id}>{at.name}</option>
				{/each}
			</select>
		{/if}

		<!-- Search -->
		<div class="flex gap-1">
			<input
				bind:value={searchInput}
				onkeydown={(e) => { if (e.key === 'Enter') doSearch(); }}
				placeholder="Search Run ID..."
				class="min-h-[36px] w-40 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-2 py-1 text-xs text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
			/>
			<button type="button" onclick={doSearch}
				class="min-h-[36px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-3 py-1 text-xs font-medium text-[var(--color-tron-cyan)]"
			>
				Search
			</button>
		</div>
	</div>

	<p class="text-xs text-[var(--color-tron-text-secondary)]">
		Showing {data.runs.length} of {data.total} runs
	</p>

	<!-- Table -->
	<div class="overflow-x-auto rounded border border-[var(--color-tron-border)]">
		<table class="w-full text-sm">
			<thead>
				<tr class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
					{#each columns as col (col.key)}
						<th class="px-3 py-2 text-left font-medium text-[var(--color-tron-text-secondary)]">
							<button type="button" onclick={() => toggleSort(col.key)} class="hover:text-[var(--color-tron-cyan)]">
								{col.label}
								{#if data.filters.sortBy === col.key}
									<span class="text-[var(--color-tron-cyan)]">{data.filters.sortDir === 'asc' ? '\u2191' : '\u2193'}</span>
								{/if}
							</button>
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each data.runs as run (run.runId)}
					<tr
						class="cursor-pointer border-b border-[var(--color-tron-border)]/50 hover:bg-[var(--color-tron-surface)]/50"
						onclick={() => toggleExpand(run)}
					>
						<td class="px-3 py-2 font-mono text-xs text-[var(--color-tron-text)]">{run.runId}</td>
						<td class="px-3 py-2">
							<span class="rounded px-1.5 py-0.5 text-xs font-medium {typeBadgeClass(run.processType)}">
								{run.processType === 'wax' ? 'Wax' : 'Reagent'}
							</span>
						</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text)]">{run.robotId}</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{run.operatorName ?? '—'}</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{run.assayTypeName ?? '—'}</td>
						<td class="px-3 py-2">
							<span class="rounded px-1.5 py-0.5 text-xs font-medium {statusBadgeClass(run.status)}">
								{run.status}
							</span>
						</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text)]">{run.totalCartridges}</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text)]">{successPct(run)}</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{formatDate(run.startTime)}</td>
						<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{durationStr(run.startTime, run.endTime)}</td>
					</tr>
					<!-- Expanded detail row -->
					{#if expandedId === run.runId}
						<tr class="border-b border-[var(--color-tron-border)]/50">
							<td colspan="10" class="bg-[var(--color-tron-bg-secondary)] px-4 py-4">
								{#if detailLoading}
									<p class="text-xs text-[var(--color-tron-text-secondary)]">Loading detail...</p>
								{:else if expandedDetail}
									<div class="space-y-3">
										<!-- Timestamps -->
										<div class="flex flex-wrap gap-4 text-xs text-[var(--color-tron-text-secondary)]">
											<span>Created: {formatDate(expandedDetail.createdAt)}</span>
											<span>Started: {formatDate(expandedDetail.startTime)}</span>
											<span>Ended: {formatDate(expandedDetail.endTime)}</span>
										</div>

										<!-- Abort reason -->
										{#if expandedDetail.abortReason}
											<div class="rounded border border-red-500/30 bg-red-900/20 px-3 py-2 text-xs text-red-300">
												Abort reason: {expandedDetail.abortReason}
											</div>
										{/if}

										<!-- Cartridges -->
										{#if expandedDetail.cartridges.length > 0}
											<div>
												<h4 class="mb-1 text-xs font-semibold text-[var(--color-tron-text)]">
													Cartridges ({expandedDetail.cartridges.length})
												</h4>
												<div class="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
													{#each expandedDetail.cartridges as cart (cart.cartridgeId)}
														<div class="flex items-center gap-2 rounded border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-surface)]/50 px-2 py-1 text-xs">
															<span class="font-mono text-[var(--color-tron-text)]">{cart.cartridgeId}</span>
															{#if cart.deckPosition != null}
																<span class="text-[var(--color-tron-text-secondary)]">Pos {cart.deckPosition}</span>
															{/if}
															<span class={qcBadgeClass(cart.qcStatus)}>{cart.qcStatus}</span>
															{#if cart.storageLocation}
																<span class="text-[var(--color-tron-text-secondary)]">{cart.storageLocation}</span>
															{/if}
															{#if cart.rejectionReason}
																<span class="text-red-400">({cart.rejectionReason})</span>
															{/if}
														</div>
													{/each}
												</div>
											</div>
										{/if}

										<!-- Tubes (reagent only) -->
										{#if expandedDetail.tubes.length > 0}
											<div>
												<h4 class="mb-1 text-xs font-semibold text-[var(--color-tron-text)]">
													Reagent Tubes ({expandedDetail.tubes.length})
												</h4>
												<div class="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
													{#each expandedDetail.tubes as tube (tube.wellPosition)}
														<div class="flex items-center gap-2 rounded border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-surface)]/50 px-2 py-1 text-xs">
															<span class="text-[var(--color-tron-text-secondary)]">Well {tube.wellPosition}:</span>
															<span class="text-[var(--color-tron-text)]">{tube.reagentName}</span>
															<span class="font-mono text-[var(--color-tron-text-secondary)]">{tube.sourceLotId}</span>
														</div>
													{/each}
												</div>
											</div>
										{/if}

										<!-- Top Seal Batches (reagent only) -->
										{#if expandedDetail.topSealBatches.length > 0}
											<div>
												<h4 class="mb-1 text-xs font-semibold text-[var(--color-tron-text)]">
													Top Seal Batches ({expandedDetail.topSealBatches.length})
												</h4>
												<div class="flex flex-wrap gap-2">
													{#each expandedDetail.topSealBatches as batch (batch.batchId)}
														<div class="rounded border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-surface)]/50 px-2 py-1 text-xs">
															<span class="font-mono text-[var(--color-tron-text)]">{batch.batchId}</span>
															<span class="text-[var(--color-tron-text-secondary)]">— Lot: {batch.topSealLotId}</span>
															{#if batch.completionTime}
																<span class="text-[var(--color-tron-text-secondary)]">({formatDate(batch.completionTime)})</span>
															{/if}
														</div>
													{/each}
												</div>
											</div>
										{/if}
									</div>
								{:else}
									<p class="text-xs text-[var(--color-tron-text-secondary)]">No detail available</p>
								{/if}
							</td>
						</tr>
					{/if}
				{/each}
				{#if data.runs.length === 0}
					<tr>
						<td colspan="10" class="px-4 py-8 text-center text-sm text-[var(--color-tron-text-secondary)]">
							No runs found matching your filters.
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
					<button type="button" onclick={() => setPage(data.pageNum - 1)}
						class="min-h-[36px] rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)]"
					>
						Previous
					</button>
				{/if}
				{#if data.pageNum < totalPages}
					<button type="button" onclick={() => setPage(data.pageNum + 1)}
						class="min-h-[36px] rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)]"
					>
						Next
					</button>
				{/if}
			</div>
		</div>
	{/if}
</div>
