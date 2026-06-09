<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	const REFRESH_MS = 10_000;
	let refreshTimer: ReturnType<typeof setInterval> | null = null;

	onMount(() => {
		refreshTimer = setInterval(() => {
			invalidateAll();
		}, REFRESH_MS);
	});

	onDestroy(() => {
		if (refreshTimer) clearInterval(refreshTimer);
	});

	function statusColor(status: string): string {
		if (status === 'online') return 'var(--color-tron-green,#39ff14)';
		if (status === 'degraded') return 'var(--color-tron-yellow,#facc15)';
		return 'var(--color-tron-red,#ff3366)';
	}

	function relativeTime(iso: string | null): string {
		if (!iso) return '—';
		const then = new Date(iso).getTime();
		const ms = Date.now() - then;
		if (ms < 0) return 'in the future';
		if (ms < 5_000) return 'just now';
		if (ms < 60_000) return `${Math.floor(ms / 1000)} s ago`;
		if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
		if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
		return `${Math.floor(ms / 86_400_000)} d ago`;
	}
</script>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Capture Stations</h1>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				Pi-hosted camera + scanner stations registered with BIMS. Auto-refreshes every
				{Math.round(REFRESH_MS / 1000)} s.
			</p>
		</div>
		<div class="text-xs text-[var(--color-tron-text-secondary)]">
			{data.stations.length} station{data.stations.length === 1 ? '' : 's'}
		</div>
	</div>

	{#if data.stations.length === 0}
		<div
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-12 text-center"
		>
			<p class="text-[var(--color-tron-text-secondary)]">
				No capture stations registered yet.
			</p>
			<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">
				Provision a Pi with
				<code class="rounded bg-[var(--color-tron-bg-tertiary)] px-1">services/bims-capture-agent/RUNBOOK.md</code>
				— `setup-station.sh` self-registers on first boot.
			</p>
		</div>
	{:else}
		<div class="overflow-x-auto">
			<table class="w-full text-left text-sm">
				<thead class="text-xs uppercase text-[var(--color-tron-text-secondary)]">
					<tr class="border-b border-[var(--color-tron-border)]">
						<th class="px-3 py-2">Name</th>
						<th class="px-3 py-2">Status</th>
						<th class="px-3 py-2">Hostname</th>
						<th class="px-3 py-2">Camera</th>
						<th class="px-3 py-2">Scanner</th>
						<th class="px-3 py-2">Agent</th>
						<th class="px-3 py-2">Last seen</th>
						<th class="px-3 py-2">Operator</th>
						<th class="px-3 py-2"></th>
					</tr>
				</thead>
				<tbody>
					{#each data.stations as s (s.id)}
						<tr class="border-b border-[var(--color-tron-border)] hover:bg-[var(--color-tron-bg-secondary)]">
							<td class="px-3 py-3">
								<div class="font-medium text-[var(--color-tron-cyan)]">{s.name}</div>
								{#if s.location}
									<div class="text-xs text-[var(--color-tron-text-secondary)]">{s.location}</div>
								{/if}
							</td>
							<td class="px-3 py-3">
								<span class="inline-flex items-center gap-2">
									<span
										class="inline-block h-2 w-2 rounded-full"
										style="background:{statusColor(s.status)}"
									></span>
									<span style="color:{statusColor(s.status)}">{s.status}</span>
								</span>
							</td>
							<td class="px-3 py-3 font-mono text-xs">{s.hostname}</td>
							<td class="px-3 py-3 text-xs">
								{#if s.capabilities.camera}
									<span style="color:{s.health?.cameraOk ? statusColor('online') : statusColor('offline')}">
										{s.health?.cameraOk ? '✓' : '✗'}
									</span>
								{:else}
									<span class="text-[var(--color-tron-text-secondary)]">—</span>
								{/if}
							</td>
							<td class="px-3 py-3 text-xs">
								{#if s.capabilities.scanner}
									<span style="color:{s.health?.scannerOk ? statusColor('online') : statusColor('offline')}">
										{s.health?.scannerOk ? '✓' : '✗'}
									</span>
								{:else}
									<span class="text-[var(--color-tron-text-secondary)]">—</span>
								{/if}
							</td>
							<td class="px-3 py-3 font-mono text-xs">{s.agentVersion ?? '—'}</td>
							<td class="px-3 py-3 text-xs" title={s.lastSeenAt ?? ''}>
								{relativeTime(s.lastSeenAt)}
							</td>
							<td class="px-3 py-3 text-xs">
								{#if s.currentOperator}
									<span class="text-[var(--color-tron-cyan)]">{s.currentOperator.username}</span>
									<span class="text-[var(--color-tron-text-secondary)]">
										since {relativeTime(s.currentOperator.since)}
									</span>
								{:else}
									<span class="text-[var(--color-tron-text-secondary)]">—</span>
								{/if}
							</td>
							<td class="px-3 py-3 text-xs">
								<a
									href={`/cv/stations/${s.id}`}
									class="text-[var(--color-tron-cyan)] hover:underline"
								>
									details →
								</a>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
