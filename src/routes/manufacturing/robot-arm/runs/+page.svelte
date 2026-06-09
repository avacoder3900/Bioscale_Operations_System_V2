<script lang="ts">
	let { data } = $props();

	function statusColor(status: string): string {
		if (status === 'running' || status === 'pending') return 'text-yellow-400';
		if (status === 'completed') return 'text-green-400';
		if (status === 'failed') return 'text-red-400';
		if (status === 'cancelled') return 'text-gray-400';
		return 'text-[var(--color-tron-text-secondary)]';
	}

	function formatTime(iso: string | null | undefined): string {
		if (!iso) return '—';
		const d = new Date(iso);
		const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
		const time = d
			.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
			.replace(' ', '')
			.toLowerCase();
		return `${date}, ${time}`;
	}

	function pageHref(p: number): string {
		const params = new URLSearchParams();
		if (data.filters.type) params.set('type', data.filters.type);
		if (data.filters.status) params.set('status', data.filters.status);
		params.set('page', String(p));
		return `?${params.toString()}`;
	}

	function filterHref(key: 'type' | 'status', value: string | null): string {
		const params = new URLSearchParams();
		if (key !== 'type' && data.filters.type) params.set('type', data.filters.type);
		if (key !== 'status' && data.filters.status) params.set('status', data.filters.status);
		if (value) params.set(key, value);
		return `?${params.toString()}`;
	}

	let totalPages = $derived(Math.max(1, Math.ceil(data.total / data.pageSize)));
</script>

<div class="mx-auto max-w-7xl space-y-4 p-4">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Robot Arm — Run Log</h1>
		<a
			href="/manufacturing/robot-arm"
			class="text-xs transition-colors hover:text-[var(--color-tron-cyan)]"
			style="color: var(--color-tron-text-secondary)"
		>
			← back
		</a>
	</div>

	<!-- Filters -->
	<div class="flex flex-wrap gap-2 text-xs">
		<span style="color: var(--color-tron-text-secondary)" class="self-center pr-1">Type:</span>
		{#each ['teleop', 'record', 'replay', 'calibrate'] as t (t)}
			<a
				href={filterHref('type', data.filters.type === t ? null : t)}
				class="rounded border px-2 py-1 transition-colors {data.filters.type === t
					? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
					: 'border-[var(--color-tron-border)]'}"
				style={data.filters.type === t ? '' : 'color: var(--color-tron-text-secondary)'}
			>
				{t}
			</a>
		{/each}
		<span style="color: var(--color-tron-text-secondary)" class="self-center pl-3 pr-1"
			>Status:</span
		>
		{#each ['running', 'completed', 'failed', 'cancelled'] as s (s)}
			<a
				href={filterHref('status', data.filters.status === s ? null : s)}
				class="rounded border px-2 py-1 transition-colors {data.filters.status === s
					? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
					: 'border-[var(--color-tron-border)]'}"
				style={data.filters.status === s ? '' : 'color: var(--color-tron-text-secondary)'}
			>
				{s}
			</a>
		{/each}
	</div>

	<!-- Table -->
	{#if data.runs.length === 0}
		<p class="py-8 text-center text-sm" style="color: var(--color-tron-text-secondary)">
			No runs match the current filters.
		</p>
	{:else}
		<div class="overflow-hidden rounded-lg border border-[var(--color-tron-border)]">
			<table class="w-full text-sm">
				<thead
					class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-left text-xs uppercase tracking-wider"
					style="color: var(--color-tron-text-secondary)"
				>
					<tr>
						<th class="px-3 py-2">Type</th>
						<th class="px-3 py-2">Status</th>
						<th class="px-3 py-2">Triggered by</th>
						<th class="px-3 py-2">Lot</th>
						<th class="px-3 py-2">Started</th>
						<th class="px-3 py-2">Ended</th>
						<th class="px-3 py-2">Run ID</th>
					</tr>
				</thead>
				<tbody style="color: var(--color-tron-text)">
					{#each data.runs as run (run._id)}
						<tr class="border-b border-[var(--color-tron-border)]/50 last:border-b-0">
							<td class="px-3 py-2">
								<a
									href="/manufacturing/robot-arm/runs/{run._id}"
									class="hover:underline"
									style="color: var(--color-tron-cyan)">{run.type}</a
								>
							</td>
							<td class="px-3 py-2 {statusColor(run.status)}">{run.status}</td>
							<td class="px-3 py-2">{run.triggeredBy?.username ?? '—'}</td>
							<td class="px-3 py-2 text-xs" style="color: var(--color-tron-text-secondary)"
								>{run.lotId ?? '—'}</td
							>
							<td class="px-3 py-2 text-xs" style="color: var(--color-tron-text-secondary)"
								>{formatTime(run.startedAt)}</td
							>
							<td class="px-3 py-2 text-xs" style="color: var(--color-tron-text-secondary)"
								>{formatTime(run.endedAt)}</td
							>
							<td
								class="truncate px-3 py-2 font-mono text-xs"
								style="color: var(--color-tron-text-secondary)"
								title={run.runId}>{run.runId}</td
							>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<!-- Pagination -->
		{#if totalPages > 1}
			<div class="flex items-center justify-between text-xs">
				<span style="color: var(--color-tron-text-secondary)">
					Page {data.page} of {totalPages} · {data.total} total
				</span>
				<div class="flex gap-2">
					{#if data.page > 1}
						<a
							href={pageHref(data.page - 1)}
							class="rounded border border-[var(--color-tron-border)] px-2 py-1 transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
							style="color: var(--color-tron-text)">← prev</a
						>
					{/if}
					{#if data.page < totalPages}
						<a
							href={pageHref(data.page + 1)}
							class="rounded border border-[var(--color-tron-border)] px-2 py-1 transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
							style="color: var(--color-tron-text)">next →</a
						>
					{/if}
				</div>
			</div>
		{/if}
	{/if}
</div>
