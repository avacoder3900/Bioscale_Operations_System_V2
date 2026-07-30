<script lang="ts">
	interface Props {
		data: {
			sessions: Array<{
				id: string;
				status: string;
				passed: boolean | null;
				startedAt: string | null;
				completedAt: string | null;
				createdAt: string;
				/** When the test actually ran on the device. Null = genuinely unknown. */
				testRanAt: string | null;
				pullDelaySeconds: number | null;
				spuUdi: string | null;
				barcode: string | null;
				username: string | null;
				avgMagnitude: number | null;
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

	function formatDate(dateStr: string): string {
		return new Date(dateStr).toLocaleDateString();
	}

	function formatDateTime(dateStr: string | null): string {
		if (!dateStr) return 'N/A';
		return new Date(dateStr).toLocaleString();
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
		const headers = [
			'Barcode',
			'SPU',
			'Test run',
			'Recorded',
			'User',
			'Status',
			'Avg Magnitude (µT)',
			'Result'
		];
		const rows = data.sessions.map((s) => [
			s.barcode ?? '',
			s.spuUdi ?? '',
			// The time the test ran, not the time it was recorded. Blank rather than
			// substituted when the payload carried no timestamp.
			s.testRanAt ? formatDateTime(s.testRanAt) : '',
			formatDateTime(s.completedAt ?? s.createdAt),
			s.username ?? '',
			s.status,
			s.avgMagnitude?.toFixed(2) ?? '',
			s.passed === true ? 'Passed' : s.passed === false ? 'Failed' : 'Pending'
		]);

		const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
		const blob = new Blob([csv], { type: 'text/csv' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `magnetometer-history-${new Date().toISOString().split('T')[0]}.csv`;
		a.click();
		URL.revokeObjectURL(url);
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Magnetometer Test History</h1>
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
			<a href="/validation/magnetometer/history" class="tron-text-muted text-sm hover:text-[var(--color-tron-cyan)]">
				Clear filters
			</a>
		{/if}
	</form>

	<!-- Results Table -->
	<div class="tron-card overflow-hidden">
		{#if data.sessions.length === 0}
			<div class="p-8 text-center">
				<svg class="mx-auto h-12 w-12 text-[var(--color-tron-text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
				</svg>
				<p class="tron-text-muted mt-4">No magnetometer tests found</p>
				<a href="/validation/magnetometer" class="mt-4 inline-block text-[var(--color-tron-cyan)] hover:underline">
					Run a test →
				</a>
			</div>
		{:else}
			<table class="w-full">
				<thead class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)]">
					<tr>
						<th class="tron-text-muted px-4 py-3 text-left text-xs font-medium uppercase">Barcode</th>
						<th class="tron-text-muted px-4 py-3 text-left text-xs font-medium uppercase">Test run</th>
						<th class="tron-text-muted px-4 py-3 text-left text-xs font-medium uppercase">Recorded</th>
						<th class="tron-text-muted px-4 py-3 text-left text-xs font-medium uppercase">User</th>
						<th class="tron-text-muted px-4 py-3 text-left text-xs font-medium uppercase">Field Strength</th>
						<th class="tron-text-muted px-4 py-3 text-left text-xs font-medium uppercase">Result</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-[var(--color-tron-border)]">
					{#each data.sessions as session (session.id)}
						{@const badge = getResultBadge(session.passed, session.status)}
						<tr class="transition-colors hover:bg-[var(--color-tron-bg-tertiary)]">
							<td class="px-4 py-3">
								<a
									href="/validation/magnetometer/{session.id}"
									class="tron-heading font-mono font-medium hover:text-[var(--color-tron-cyan)]"
								>
									{session.barcode ?? session.id.slice(0, 8)}
								</a>
							</td>
							<td class="tron-text-secondary px-4 py-3 text-sm">
								{#if session.testRanAt}
									{formatDateTime(session.testRanAt)}
									{#if session.pullDelaySeconds != null && session.pullDelaySeconds > 3600}
										<span
											class="ml-1"
											style="color: var(--color-tron-orange);"
											title="The device was still holding this result when it was read {formatDateTime(
												session.completedAt ?? session.createdAt
											)} — it was already stale."
										>⚠</span>
									{/if}
								{:else}
									<span
										class="tron-text-muted"
										title="This payload carries no timestamp (legacy format), so the run time is genuinely unknown. It is deliberately not filled in with the time the data was recorded."
									>unknown</span>
								{/if}
							</td>
							<td class="tron-text-muted px-4 py-3 text-sm">
								{formatDateTime(session.completedAt ?? session.createdAt)}
							</td>
							<td class="tron-text-secondary px-4 py-3 text-sm">
								{session.username ?? 'N/A'}
							</td>
							<td class="px-4 py-3">
								{#if session.avgMagnitude !== null}
									<span class="tron-heading font-mono">{session.avgMagnitude.toFixed(2)} µT</span>
								{:else}
									<span class="tron-text-muted">—</span>
								{/if}
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
