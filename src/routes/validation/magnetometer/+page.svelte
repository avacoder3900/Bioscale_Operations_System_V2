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
				testRanAt: string | null;
				spuUdi: string | null;
				spuId: string | null;
				username: string | null;
				gaussMin: number | null;
				gaussMax: number | null;
			}>;
			stats: {
				total: number;
				passed: number;
				failed: number;
			};
		};
	}

	let { data }: Props = $props();

	// Newest-first by default; the arrow in the Date header flips it. Sorting is
	// client-side so the toggle costs no round trip.
	let newestFirst = $state(true);

	// Order by when the test RAN, not when it reached BIMS. Runs with no
	// recoverable test time sort to the bottom either way rather than pretending
	// to a date they don't have.
	function runDate(s: { testRanAt: string | null }): number | null {
		return s.testRanAt ? new Date(s.testRanAt).getTime() : null;
	}

	const sessions = $derived(
		[...data.sessions].sort((a, b) => {
			const x = runDate(a);
			const y = runDate(b);
			if (x === null && y === null) return 0;
			if (x === null) return 1;
			if (y === null) return -1;
			return newestFirst ? y - x : x - y;
		})
	);

	function formatDateTime(dateStr: string | null): string {
		if (!dateStr) return 'N/A';
		return new Date(dateStr).toLocaleString();
	}

	function formatGauss(z: number | null): string {
		return z === null ? '—' : String(z);
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
		const headers = ['UDI', 'User', 'Gauss Min', 'Gauss Max', 'Result', 'Date'];
		const rows = sessions.map((s) => [
			s.spuUdi ?? '',
			s.username ?? '',
			s.gaussMin ?? '',
			s.gaussMax ?? '',
			s.passed === true ? 'Passed' : s.passed === false ? 'Failed' : 'Pending',
			s.testRanAt ? formatDateTime(s.testRanAt) : ''
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

<svelte:head>
	<title>Magnetometer Validation | Bioscale</title>
</svelte:head>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Magnetometer Validation</h1>
			<p class="tron-text-muted mt-1">
				{data.stats.total} tests · {data.stats.passed} passed · {data.stats.failed} failed
			</p>
		</div>

		<div class="flex items-center gap-3">
		<a href="/validation/magnetometer/run" class="tron-btn-primary">Run a test</a>
		<button onclick={exportToCsv} class="tron-btn-secondary flex items-center gap-2">
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
			</svg>
			Export CSV
		</button>
		</div>
	</div>

	<!-- Run log -->
	<div class="tron-card overflow-hidden">
		{#if data.sessions.length === 0}
			<div class="p-8 text-center">
				<svg class="mx-auto h-12 w-12 text-[var(--color-tron-text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
				</svg>
				<p class="tron-text-muted mt-4">No magnetometer tests found</p>
				<a href="/validation/magnetometer/run" class="mt-4 inline-block text-[var(--color-tron-cyan)] hover:underline">
					Run a test →
				</a>
			</div>
		{:else}
			<table class="w-full">
				<thead class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)]">
					<tr>
						<th class="tron-text-muted px-4 py-3 text-left text-xs font-medium uppercase">UDI</th>
						<th class="tron-text-muted px-4 py-3 text-left text-xs font-medium uppercase">
								<span class="flex items-center gap-1.5">
									Date
									<button
										type="button"
										onclick={() => (newestFirst = !newestFirst)}
										class="hover:text-[var(--color-tron-cyan)]"
										aria-label={newestFirst ? 'Sort oldest first' : 'Sort newest first'}
										title={newestFirst ? 'Newest first' : 'Oldest first'}
									>
										<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
											{#if newestFirst}
												<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
											{:else}
												<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 10l7-7m0 0l7 7m-7-7v18" />
											{/if}
										</svg>
									</button>
								</span>
							</th>
						<th class="tron-text-muted px-4 py-3 text-left text-xs font-medium uppercase">User</th>
						<th class="tron-text-muted px-4 py-3 text-left text-xs font-medium uppercase">Gauss Min</th>
						<th class="tron-text-muted px-4 py-3 text-left text-xs font-medium uppercase">Gauss Max</th>
						<th class="tron-text-muted px-4 py-3 text-left text-xs font-medium uppercase">Result</th>
						<th class="tron-text-muted px-4 py-3 text-left text-xs font-medium uppercase">Test Results</th>
										</tr>
				</thead>
				<tbody class="divide-y divide-[var(--color-tron-border)]">
					{#each sessions as session (session.id)}
						{@const badge = getResultBadge(session.passed, session.status)}
						<tr class="transition-colors hover:bg-[var(--color-tron-bg-tertiary)]">
							<td class="px-4 py-3">
								{#if session.spuUdi && session.spuId}
									<a
										href="/spu/{session.spuId}"
										class="font-mono font-medium text-[var(--color-tron-cyan)] hover:underline"
										title="Open this unit's Device History Record"
									>{session.spuUdi}</a>
								{:else if session.spuUdi}
									<span class="tron-heading font-mono font-medium">{session.spuUdi}</span>
								{:else}
									<span class="tron-text-muted">—</span>
								{/if}
							</td>
							<td class="tron-text-secondary px-4 py-3 text-sm whitespace-nowrap">
								{#if session.testRanAt}
									{formatDateTime(session.testRanAt)}
								{:else}
									<span class="tron-text-muted" title="No test time recorded in the raw payload">—</span>
								{/if}
							</td>
							<td class="tron-text-secondary px-4 py-3 text-sm">
								{session.username ?? 'N/A'}
							</td>
							<td class="px-4 py-3">
								<span class="tron-heading font-mono">{formatGauss(session.gaussMin)}</span>
							</td>
							<td class="px-4 py-3">
								<span class="tron-heading font-mono">{formatGauss(session.gaussMax)}</span>
							</td>
							<td class="px-4 py-3">
								<span class="rounded-full px-2 py-1 text-xs font-medium {badge.class}">
									{badge.label}
								</span>
							</td>
							<td class="px-4 py-3">
								<a
									href="/validation/magnetometer/{session.id}"
									class="font-medium text-[var(--color-tron-cyan)] hover:underline"
								>
									View
								</a>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
</div>
