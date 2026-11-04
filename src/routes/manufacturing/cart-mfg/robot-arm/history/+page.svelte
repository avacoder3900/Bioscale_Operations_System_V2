<script lang="ts">
	/**
	 * History — wax-fill runs first (what the line did, cart by cart), the raw
	 * arm session log behind a toggle (every play lands there as a "replay").
	 */
	let { data } = $props();

	type SessionRow = {
		_id: string;
		runId: string;
		type: string;
		status: string;
		startedAt: string | null;
		endedAt: string | null;
		triggeredBy?: { username?: string } | null;
		lotId?: string | null;
	};
	const sessions = $derived((data.runs ?? []) as SessionRow[]);

	function statusColor(status: string): string {
		if (status === 'running' || status === 'pending') return 'text-yellow-400';
		if (status === 'completed') return 'text-green-400';
		if (status === 'failed') return 'text-red-400';
		if (status === 'cancelled' || status === 'stopped') return 'text-gray-400';
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

	function duration(start: string | null, end: string | null): string {
		if (!start || !end) return '—';
		const s = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
		if (s < 60) return `${s} s`;
		const m = Math.floor(s / 60);
		return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
	}

	function href(params: Record<string, string | null>): string {
		const p = new URLSearchParams();
		if (data.view === 'sessions') p.set('view', 'sessions');
		if (data.filters.type) p.set('type', data.filters.type);
		if (data.filters.status) p.set('status', data.filters.status);
		for (const [k, v] of Object.entries(params)) {
			if (v === null) p.delete(k);
			else p.set(k, v);
		}
		const q = p.toString();
		return q ? `?${q}` : '?';
	}

	let totalPages = $derived(Math.max(1, Math.ceil(data.total / data.pageSize)));
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h2 class="text-lg font-bold" style="color: var(--color-tron-cyan)">History</h2>
		</div>
		<div class="flex gap-1 text-xs">
			<a href="?" class="rounded-full border px-3 py-1 transition-colors {data.view === 'runs' ? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}">Wax-Fill Runs</a>
			<a href="?view=sessions" class="rounded-full border px-3 py-1 transition-colors {data.view === 'sessions' ? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}" title="Every arm session the Pi reported: each play lands here as a replay">Arm Sessions</a>
		</div>
	</div>

	{#if data.view === 'runs'}
		{#if data.loops.length === 0}
			<p class="py-8 text-center text-sm" style="color: var(--color-tron-text-secondary)">No Wax-Fill Runs</p>
		{:else}
			<div class="overflow-hidden rounded-lg border border-[var(--color-tron-border)]">
				<table class="w-full text-sm">
					<thead class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-left text-xs uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
						<tr>
							<th class="px-3 py-2">Started</th>
							<th class="px-3 py-2">By</th>
							<th class="px-3 py-2">Robot</th>
							<th class="px-3 py-2">Carts</th>
							<th class="px-3 py-2">Status</th>
							<th class="px-3 py-2">Took</th>
							<th class="px-3 py-2">Note</th>
						</tr>
					</thead>
					<tbody style="color: var(--color-tron-text)">
						{#each data.loops as l (l._id)}
							<tr class="border-b border-[var(--color-tron-border)]/50 last:border-b-0 align-top">
								<td class="whitespace-nowrap px-3 py-2 text-xs">{formatTime(l.startedAt)}</td>
								<td class="px-3 py-2 text-xs">{l.startedBy ?? '—'}</td>
								<td class="px-3 py-2 text-xs">{l.robot.name}</td>
								<td class="px-3 py-2 font-mono text-xs" title="filled / asked{l.skippedRuns ? ', skipped by the fail route' : ''}">
									{l.completedRuns} / {l.requestedRuns}{#if l.skippedRuns} <span style="color: #fbbf24">· {l.skippedRuns} skipped</span>{/if}
								</td>
								<td class="px-3 py-2 text-xs {statusColor(l.status)}">{l.status}</td>
								<td class="whitespace-nowrap px-3 py-2 text-xs" style="color: var(--color-tron-text-secondary)">{duration(l.startedAt, l.endedAt)}</td>
								<td class="px-3 py-2 text-[11px]" style="color: var(--color-tron-text-secondary)">
									{l.error ?? ''}
									{#if l.cycles.some((c) => c.barcode)}
										<details class="mt-1">
											<summary class="cursor-pointer">Carts</summary>
											<ul class="mt-1 space-y-0.5 font-mono">
												{#each l.cycles as c (c.index)}
													<li>#{c.index} {c.barcode ?? '—'} · {c.step}{c.error ? ` · ${c.error}` : ''}</li>
												{/each}
											</ul>
										</details>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	{:else}
		<!-- Filters -->
		<div class="flex flex-wrap gap-2 text-xs">
			<span style="color: var(--color-tron-text-secondary)" class="self-center pr-1">Type:</span>
			{#each ['teleop', 'record', 'replay', 'calibrate', 'task'] as t (t)}
				<a
					href={href({ type: data.filters.type === t ? null : t, page: null })}
					class="rounded border px-2 py-1 transition-colors {data.filters.type === t ? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)]'}"
					style={data.filters.type === t ? '' : 'color: var(--color-tron-text-secondary)'}
				>
					{t[0].toUpperCase() + t.slice(1)}
				</a>
			{/each}
			<span style="color: var(--color-tron-text-secondary)" class="self-center pl-3 pr-1">Status:</span>
			{#each ['running', 'completed', 'failed', 'cancelled'] as s (s)}
				<a
					href={href({ status: data.filters.status === s ? null : s, page: null })}
					class="rounded border px-2 py-1 transition-colors {data.filters.status === s ? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)]'}"
					style={data.filters.status === s ? '' : 'color: var(--color-tron-text-secondary)'}
				>
					{s[0].toUpperCase() + s.slice(1)}
				</a>
			{/each}
		</div>

		{#if sessions.length === 0}
			<p class="py-8 text-center text-sm" style="color: var(--color-tron-text-secondary)">No Matching Sessions</p>
		{:else}
			<div class="overflow-hidden rounded-lg border border-[var(--color-tron-border)]">
				<table class="w-full text-sm">
					<thead class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-left text-xs uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
						<tr>
							<th class="px-3 py-2">Type</th>
							<th class="px-3 py-2">Status</th>
							<th class="px-3 py-2">Triggered By</th>
							<th class="px-3 py-2">Lot</th>
							<th class="px-3 py-2">Started</th>
							<th class="px-3 py-2">Ended</th>
							<th class="px-3 py-2">Run ID</th>
						</tr>
					</thead>
					<tbody style="color: var(--color-tron-text)">
						{#each sessions as run (run._id)}
							<tr class="border-b border-[var(--color-tron-border)]/50 last:border-b-0">
								<td class="px-3 py-2">
									<a href="/manufacturing/cart-mfg/robot-arm/history/{run._id}" class="hover:underline" style="color: var(--color-tron-cyan)">{run.type}</a>
								</td>
								<td class="px-3 py-2 {statusColor(run.status)}">{run.status}</td>
								<td class="px-3 py-2">{run.triggeredBy?.username ?? '—'}</td>
								<td class="px-3 py-2 text-xs" style="color: var(--color-tron-text-secondary)">{run.lotId ?? '—'}</td>
								<td class="px-3 py-2 text-xs" style="color: var(--color-tron-text-secondary)">{formatTime(run.startedAt)}</td>
								<td class="px-3 py-2 text-xs" style="color: var(--color-tron-text-secondary)">{formatTime(run.endedAt)}</td>
								<td class="truncate px-3 py-2 font-mono text-xs" style="color: var(--color-tron-text-secondary)" title={run.runId}>{run.runId}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	{/if}

	<!-- Pagination -->
	{#if totalPages > 1}
		<div class="flex items-center justify-between text-xs">
			<span style="color: var(--color-tron-text-secondary)">Page {data.page} of {totalPages} · {data.total} total</span>
			<div class="flex gap-2">
				{#if data.page > 1}
					<a href={href({ page: String(data.page - 1) })} class="rounded border border-[var(--color-tron-border)] px-2 py-1 transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]" style="color: var(--color-tron-text)">← Prev</a>
				{/if}
				{#if data.page < totalPages}
					<a href={href({ page: String(data.page + 1) })} class="rounded border border-[var(--color-tron-border)] px-2 py-1 transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]" style="color: var(--color-tron-text)">Next →</a>
				{/if}
			</div>
		</div>
	{/if}
</div>
