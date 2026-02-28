<script lang="ts">
	import { goto } from '$app/navigation';

	interface Props {
		data: {
			sessions: Array<{
				id: string;
				status: string;
				startedAt: string | null;
				completedAt: string | null;
				createdAt: string;
				barcode: string | null;
				username: string | null;
				passed: boolean | null;
				peakWavelength: number | null;
				peakAbsorbance: number | null;
			}>;
			stats: {
				total: number;
				passed: number;
				failed: number;
			};
			filters: {
				status: string | null;
				startDate: string | null;
				endDate: string | null;
			};
		};
	}

	let { data }: Props = $props();

	// Filter state
	let statusFilter = $state(data.filters.status ?? '');
	let startDate = $state(data.filters.startDate ?? '');
	let endDate = $state(data.filters.endDate ?? '');

	function applyFilters() {
		const params = new URLSearchParams();
		if (statusFilter) params.set('status', statusFilter);
		if (startDate) params.set('startDate', startDate);
		if (endDate) params.set('endDate', endDate);

		goto(`?${params.toString()}`);
	}

	function clearFilters() {
		statusFilter = '';
		startDate = '';
		endDate = '';
		goto('?');
	}

	function formatDate(dateStr: string): string {
		return new Date(dateStr).toLocaleString();
	}

	function formatShortDate(dateStr: string): string {
		return new Date(dateStr).toLocaleDateString();
	}

	function exportToCsv() {
		const headers = [
			'Barcode',
			'Date',
			'Status',
			'Result',
			'Peak Wavelength',
			'Peak Absorbance',
			'User'
		];
		const rows = data.sessions.map((s) => [
			s.barcode ?? s.id,
			s.createdAt,
			s.status,
			s.passed === true ? 'PASS' : s.passed === false ? 'FAIL' : 'N/A',
			s.peakWavelength?.toFixed(1) ?? '',
			s.peakAbsorbance?.toFixed(3) ?? '',
			s.username ?? ''
		]);

		const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
		const blob = new Blob([csv], { type: 'text/csv' });
		const url = URL.createObjectURL(blob);

		const a = document.createElement('a');
		a.href = url;
		a.download = `spectrophotometer-history-${new Date().toISOString().split('T')[0]}.csv`;
		a.click();

		URL.revokeObjectURL(url);
	}

	function getStatusBadge(status: string, passed: boolean | null) {
		if (status === 'completed' && passed === true) {
			return {
				class: 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]',
				label: 'Passed'
			};
		} else if (status === 'failed' || passed === false) {
			return {
				class: 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]',
				label: 'Failed'
			};
		} else if (status === 'in_progress') {
			return {
				class: 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]',
				label: 'In Progress'
			};
		}
		return {
			class: 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)]',
			label: 'Pending'
		};
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Spectrophotometer History</h1>
			<p class="tron-text-muted mt-1">View past spectrophotometer validation tests</p>
		</div>
		<a
			href="/spu/validation/spectrophotometer"
			class="tron-btn-primary flex items-center gap-2 px-4 py-2"
		>
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
			</svg>
			New Test
		</a>
	</div>

	<!-- Stats -->
	<div class="grid gap-4 md:grid-cols-3">
		<div class="tron-card p-4 text-center">
			<div class="tron-text-muted text-xs uppercase">Total Tests</div>
			<div class="tron-heading mt-1 text-3xl font-bold">{data.stats.total}</div>
		</div>
		<div class="tron-card p-4 text-center">
			<div class="tron-text-muted text-xs uppercase">Passed</div>
			<div class="mt-1 text-3xl font-bold text-[var(--color-tron-green)]">{data.stats.passed}</div>
		</div>
		<div class="tron-card p-4 text-center">
			<div class="tron-text-muted text-xs uppercase">Failed</div>
			<div class="mt-1 text-3xl font-bold text-[var(--color-tron-red)]">{data.stats.failed}</div>
		</div>
	</div>

	<!-- Filters -->
	<div class="tron-card p-4">
		<div class="flex flex-wrap items-end gap-4">
			<div>
				<label class="tron-text-muted mb-1 block text-xs">Status</label>
				<select bind:value={statusFilter} class="tron-input min-w-[140px] px-3 py-2 text-sm">
					<option value="">All</option>
					<option value="completed">Passed</option>
					<option value="failed">Failed</option>
					<option value="in_progress">In Progress</option>
				</select>
			</div>
			<div>
				<label class="tron-text-muted mb-1 block text-xs">Start Date</label>
				<input type="date" bind:value={startDate} class="tron-input px-3 py-2 text-sm" />
			</div>
			<div>
				<label class="tron-text-muted mb-1 block text-xs">End Date</label>
				<input type="date" bind:value={endDate} class="tron-input px-3 py-2 text-sm" />
			</div>
			<button onclick={applyFilters} class="tron-btn-primary px-4 py-2 text-sm">
				Apply Filters
			</button>
			<button onclick={clearFilters} class="tron-btn-secondary px-4 py-2 text-sm"> Clear </button>
			<div class="flex-1"></div>
			<button
				onclick={exportToCsv}
				class="tron-btn-secondary flex items-center gap-2 px-4 py-2 text-sm"
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
					/>
				</svg>
				Export CSV
			</button>
		</div>
	</div>

	<!-- Results Table -->
	<div class="tron-card">
		<div class="overflow-x-auto">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-[var(--color-tron-border)]">
						<th class="tron-text-muted p-4 text-left font-medium">Barcode</th>
						<th class="tron-text-muted p-4 text-left font-medium">Date</th>
						<th class="tron-text-muted p-4 text-left font-medium">Result</th>
						<th class="tron-text-muted p-4 text-left font-medium">Peak (nm)</th>
						<th class="tron-text-muted p-4 text-left font-medium">Absorbance</th>
						<th class="tron-text-muted p-4 text-left font-medium">User</th>
						<th class="tron-text-muted p-4 text-left font-medium"></th>
					</tr>
				</thead>
				<tbody>
					{#each data.sessions as session (session.id)}
						{@const badge = getStatusBadge(session.status, session.passed)}
						<tr
							class="border-b border-[var(--color-tron-border)] transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
						>
							<td class="p-4">
								<span class="tron-heading font-medium"
									>{session.barcode ?? session.id.slice(0, 8)}</span
								>
							</td>
							<td class="p-4">
								<span class="tron-text-muted">{formatShortDate(session.createdAt)}</span>
							</td>
							<td class="p-4">
								<span class="rounded-full px-2 py-1 text-xs font-medium {badge.class}">
									{badge.label}
								</span>
							</td>
							<td class="p-4">
								{#if session.peakWavelength}
									<span class="tron-heading">{session.peakWavelength.toFixed(1)}</span>
								{:else}
									<span class="tron-text-muted">-</span>
								{/if}
							</td>
							<td class="p-4">
								{#if session.peakAbsorbance}
									<span class="tron-heading">{session.peakAbsorbance.toFixed(3)}</span>
								{:else}
									<span class="tron-text-muted">-</span>
								{/if}
							</td>
							<td class="p-4">
								<span class="tron-text-muted">{session.username ?? '-'}</span>
							</td>
							<td class="p-4">
								<a
									href="/spu/validation/spectrophotometer/{session.id}"
									class="text-[var(--color-tron-cyan)] hover:underline"
								>
									View
								</a>
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="7" class="p-8 text-center">
								<svg
									class="mx-auto h-12 w-12 text-[var(--color-tron-text-secondary)]"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
									/>
								</svg>
								<p class="tron-text-muted mt-4">No tests found</p>
								<p class="tron-text-muted mt-1 text-sm">
									Try adjusting your filters or start a new test
								</p>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#if data.sessions.length > 0}
			<div
				class="tron-text-muted border-t border-[var(--color-tron-border)] p-4 text-center text-xs"
			>
				Showing {data.sessions.length} test{data.sessions.length !== 1 ? 's' : ''}
			</div>
		{/if}
	</div>
</div>
