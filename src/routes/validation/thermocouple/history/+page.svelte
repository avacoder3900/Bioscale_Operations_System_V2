<script lang="ts">
	/**
	 * Thermocouple Test History Page (THERM-010)
	 *
	 * Lists all thermocouple validation tests with filtering by date and result
	 */

	interface Props {
		data: {
			sessions: Array<{
				id: string;
				status: string;
				passed: boolean | null;
				startedAt: string | null;
				completedAt: string | null;
				createdAt: string;
				barcode: string | null;
				username: string | null;
				minTemp: number | null;
				maxTemp: number | null;
				avgTemp: number | null;
			}>;
			stats: {
				total: number;
				passed: number;
				failed: number;
			};
			filters: {
				status: string | null;
				from: string | null;
				to: string | null;
			};
		};
	}

	let { data }: Props = $props();

	function formatDateTime(dateStr: string | null): string {
		if (!dateStr) return 'N/A';
		return new Date(dateStr).toLocaleString();
	}

	function formatTemp(temp: number | null): string {
		if (temp === null) return '—';
		return temp.toFixed(1) + '°C';
	}

	function getResultBadge(passed: boolean | null, status: string) {
		if (passed === true || status === 'completed') {
			return { class: 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]', label: 'Passed' };
		}
		if (passed === false || status === 'failed') {
			return { class: 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]', label: 'Failed' };
		}
		if (status === 'in_progress') {
			return { class: 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]', label: 'In Progress' };
		}
		return { class: 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)]', label: 'Pending' };
	}

	function exportToCsv() {
		const headers = ['Barcode', 'Date', 'User', 'Status', 'Min Temp (°C)', 'Max Temp (°C)', 'Avg Temp (°C)', 'Result'];
		const rows = data.sessions.map((s) => [
			s.barcode ?? '',
			formatDateTime(s.completedAt ?? s.createdAt),
			s.username ?? '',
			s.status,
			s.minTemp?.toFixed(2) ?? '',
			s.maxTemp?.toFixed(2) ?? '',
			s.avgTemp?.toFixed(2) ?? '',
			s.passed === true ? 'Passed' : s.passed === false ? 'Failed' : 'Pending'
		]);

		const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
		const blob = new Blob([csv], { type: 'text/csv' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `thermocouple-history-${new Date().toISOString().split('T')[0]}.csv`;
		a.click();
		URL.revokeObjectURL(url);
	}
</script>

<svelte:head>
	<title>Thermocouple Test History | Bioscale</title>
</svelte:head>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<div class="flex items-center gap-3">
				<a
					href="/validation/thermocouple"
					class="tron-text-muted hover:text-[var(--color-tron-cyan)]"
					aria-label="Back to thermocouple test"
				>
					<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
					</svg>
				</a>
				<h1 class="tron-heading text-2xl font-bold">Thermocouple Test History</h1>
			</div>
			<p class="tron-text-muted mt-1">
				{data.stats.total} tests · {data.stats.passed} passed · {data.stats.failed} failed
			</p>
		</div>

		<button onclick={exportToCsv} class="tron-btn-secondary flex items-center gap-2">
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
			</svg>
			Export CSV
		</button>
	</div>

	<!-- Filters -->
	<form method="GET" class="tron-card flex flex-wrap items-end gap-4 p-4">
		<div>
			<label for="status" class="tron-text-muted mb-1 block text-xs uppercase">Result</label>
			<select
				id="status"
				name="status"
				class="tron-input min-w-32"
				value={data.filters.status ?? ''}
			>
				<option value="">All</option>
				<option value="passed">Passed</option>
				<option value="failed">Failed</option>
			</select>
		</div>

		<div>
			<label for="from" class="tron-text-muted mb-1 block text-xs uppercase">From Date</label>
			<input
				type="date"
				id="from"
				name="from"
				class="tron-input"
				value={data.filters.from ?? ''}
			/>
		</div>

		<div>
			<label for="to" class="tron-text-muted mb-1 block text-xs uppercase">To Date</label>
			<input
				type="date"
				id="to"
				name="to"
				class="tron-input"
				value={data.filters.to ?? ''}
			/>
		</div>

		<button type="submit" class="tron-btn-primary">Apply Filters</button>

		{#if data.filters.status || data.filters.from || data.filters.to}
			<a href="/validation/thermocouple/history" class="tron-text-muted text-sm hover:text-[var(--color-tron-cyan)]">
				Clear filters
			</a>
		{/if}
	</form>

	<!-- Results Table -->
	<div class="tron-card overflow-hidden">
		{#if data.sessions.length === 0}
			<div class="p-8 text-center">
				<svg class="mx-auto h-12 w-12 text-[var(--color-tron-text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
				</svg>
				<p class="tron-text-muted mt-4">No thermocouple tests found</p>
				<a href="/validation/thermocouple" class="mt-4 inline-block text-[var(--color-tron-cyan)] hover:underline">
					Run a test →
				</a>
			</div>
		{:else}
			<table class="w-full">
				<thead class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)]">
					<tr>
						<th class="tron-text-muted px-4 py-3 text-left text-xs font-medium uppercase">Barcode</th>
						<th class="tron-text-muted px-4 py-3 text-left text-xs font-medium uppercase">Date</th>
						<th class="tron-text-muted px-4 py-3 text-left text-xs font-medium uppercase">User</th>
						<th class="tron-text-muted px-4 py-3 text-left text-xs font-medium uppercase">Min Temp</th>
						<th class="tron-text-muted px-4 py-3 text-left text-xs font-medium uppercase">Max Temp</th>
						<th class="tron-text-muted px-4 py-3 text-left text-xs font-medium uppercase">Result</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-[var(--color-tron-border)]">
					{#each data.sessions as session (session.id)}
						{@const badge = getResultBadge(session.passed, session.status)}
						<tr class="transition-colors hover:bg-[var(--color-tron-bg-tertiary)]">
							<td class="px-4 py-3">
								<a
									href="/validation/thermocouple/{session.id}"
									class="tron-heading font-mono font-medium hover:text-[var(--color-tron-cyan)]"
								>
									{session.barcode ?? session.id.slice(0, 8)}
								</a>
							</td>
							<td class="tron-text-secondary px-4 py-3 text-sm">
								{formatDateTime(session.completedAt ?? session.createdAt)}
							</td>
							<td class="tron-text-secondary px-4 py-3 text-sm">
								{session.username ?? 'N/A'}
							</td>
							<td class="px-4 py-3">
								<span class="tron-heading font-mono">{formatTemp(session.minTemp)}</span>
							</td>
							<td class="px-4 py-3">
								<span class="tron-heading font-mono">{formatTemp(session.maxTemp)}</span>
							</td>
							<td class="px-4 py-3">
								<span class="rounded-full px-2 py-1 text-xs font-medium {badge.class}">
									{badge.label}
								</span>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
</div>
