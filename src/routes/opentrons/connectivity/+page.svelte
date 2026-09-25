<!--
  Fleet connectivity (OT2-TAILNET-4). One row per robot: which line BIMS uses
  and why, plus a live probe of each tailnet robot from THIS browser — the only
  thing that can tell whether this computer is on the tailnet.
-->
<script lang="ts">
	import { onMount } from 'svelte';

	let { data } = $props();

	type Probe = { state: 'idle' | 'probing' | 'ok' | 'fail'; ms?: number; detail?: string };
	let probes = $state<Record<string, Probe>>({});

	async function probe(robotId: string, directUrl: string) {
		probes[robotId] = { state: 'probing' };
		const t0 = performance.now();
		try {
			const res = await fetch(`${directUrl}/health`, {
				headers: { 'opentrons-version': '3' },
				signal: AbortSignal.timeout(3000)
			});
			const ms = Math.round(performance.now() - t0);
			if (!res.ok) {
				probes[robotId] = { state: 'fail', ms, detail: `robot answered ${res.status}` };
				return;
			}
			const body = await res.json().catch(() => ({}));
			probes[robotId] = { state: 'ok', ms, detail: body?.name ?? '' };
		} catch (e) {
			probes[robotId] = {
				state: 'fail',
				detail: e instanceof Error && e.name === 'TimeoutError' ? 'no answer in 3 s (not on the tailnet?)' : 'unreachable from this computer'
			};
		}
	}

	function probeAll() {
		for (const r of data.robots) if (r.directUrl) void probe(r.robotId, r.directUrl);
	}

	onMount(probeAll);

	const ago = (ms: number | null | undefined) =>
		ms == null ? '—' : ms < 60_000 ? `${Math.round(ms / 1000)}s ago` : `${Math.round(ms / 60_000)}m ago`;
	const time = (iso: string) => new Date(iso).toLocaleTimeString();
</script>

<div class="mx-auto max-w-6xl space-y-6 p-4">
	<div class="flex items-baseline justify-between">
		<div>
			<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Robot connectivity</h1>
			<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
				Which line BIMS uses for each OT-2. <strong>Queue</strong> = Vercel queue → robot bridge (default).
				<strong>Tailnet</strong> = browser → robot over Tailscale; needs the robot set to Tailnet <em>and</em> this deployment
				allowing it. This deployment allows:
				<code class="text-[var(--color-tron-cyan)]">{data.deploymentTokens.length ? data.deploymentTokens.join(', ') : 'none (all robots on queue)'}</code>
			</p>
		</div>
		<button
			type="button"
			onclick={probeAll}
			class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-sm text-[var(--color-tron-text)] hover:border-[var(--color-tron-cyan)]"
		>
			Probe again
		</button>
	</div>

	<div class="overflow-x-auto rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
		<table class="w-full text-sm">
			<thead class="text-left text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
				<tr class="border-b border-[var(--color-tron-border)]">
					<th class="px-3 py-2">Robot</th>
					<th class="px-3 py-2">Line in use</th>
					<th class="px-3 py-2">Robot set to</th>
					<th class="px-3 py-2">Allowed here</th>
					<th class="px-3 py-2">From this browser</th>
					<th class="px-3 py-2">Bridge heartbeat</th>
					<th class="px-3 py-2">Direct calls 24 h</th>
				</tr>
			</thead>
			<tbody>
				{#each data.robots as r (r.robotId)}
					{@const p = probes[r.robotId]}
					{@const direct = r.transport === 'tailnet' && p?.state === 'ok'}
					<tr class="border-b border-[var(--color-tron-border)] last:border-0 align-top">
						<td class="px-3 py-2">
							<a href="/opentrons/devices/{r.robotId}/edit" class="font-medium text-[var(--color-tron-text)] hover:text-[var(--color-tron-cyan)]">{r.name}</a>
							{#if r.directUrl}<div class="font-mono text-[11px] text-[var(--color-tron-text-secondary)]">{r.directUrl}</div>{/if}
						</td>
						<td class="px-3 py-2">
							<span
								class="rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider {direct
									? 'border-green-500/40 bg-green-900/30 text-green-300'
									: 'border-[var(--color-tron-border)] bg-black/30 text-[var(--color-tron-text-secondary)]'}"
								title={r.reason}
							>
								{direct ? 'direct' : 'queue'}
							</span>
							<div class="mt-1 max-w-xs text-[11px] text-[var(--color-tron-text-secondary)]">
								{r.transport === 'tailnet' && p?.state === 'fail' ? 'queue — this computer cannot reach the robot on Tailscale' : r.reason}
							</div>
						</td>
						<td class="px-3 py-2 text-[var(--color-tron-text)]">{r.mode}</td>
						<td class="px-3 py-2 text-[var(--color-tron-text)]">{r.allowedHere ? 'yes' : 'no'}</td>
						<td class="px-3 py-2">
							{#if !r.directUrl}
								<span class="text-[var(--color-tron-text-secondary)]">—</span>
							{:else if !p || p.state === 'probing'}
								<span class="text-[var(--color-tron-text-secondary)]">probing…</span>
							{:else if p.state === 'ok'}
								<span class="text-green-400">✓ {p.ms} ms</span>
								<div class="text-[11px] text-[var(--color-tron-text-secondary)]">{p.detail}</div>
							{:else}
								<span class="text-red-400">✗</span>
								<div class="text-[11px] text-[var(--color-tron-text-secondary)]">{p.detail}</div>
							{/if}
						</td>
						<td class="px-3 py-2">
							{#if r.bridge}
								<span class={r.bridge.status === 'offline' ? 'text-red-400' : 'text-[var(--color-tron-text)]'}>{r.bridge.label}</span>
								<div class="text-[11px] text-[var(--color-tron-text-secondary)]">{ago(r.bridge.lastBeatMsAgo)}</div>
							{:else}—{/if}
						</td>
						<td class="px-3 py-2 text-[var(--color-tron-text)]">
							{#if r.calls24h}
								{r.calls24h.calls} calls{r.calls24h.errors ? ` · ${r.calls24h.errors} failed` : ''}
								<div class="text-[11px] text-[var(--color-tron-text-secondary)]">avg {r.calls24h.avgLatencyMs} ms</div>
							{:else}
								<span class="text-[var(--color-tron-text-secondary)]">none</span>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
		<h2 class="mb-2 text-sm font-medium uppercase tracking-wider text-[var(--color-tron-cyan)]">Latest direct calls</h2>
		{#if data.recent.length === 0}
			<p class="text-sm text-[var(--color-tron-text-secondary)]">No direct calls in the last 3 days — every robot command went through the queue.</p>
		{:else}
			<table class="w-full text-xs">
				<tbody>
					{#each data.recent as c (c._id)}
						<tr class="border-b border-[var(--color-tron-border)] last:border-0">
							<td class="py-1 pr-3 font-mono text-[var(--color-tron-text-secondary)]">{time(c.at)}</td>
							<td class="py-1 pr-3 text-[var(--color-tron-text)]">{c.robotName}</td>
							<td class="py-1 pr-3 font-mono text-[var(--color-tron-text)]">{c.verb}</td>
							<td class="py-1 pr-3 font-mono text-[var(--color-tron-text-secondary)]">{c.method} {c.path}</td>
							<td class="py-1 pr-3 {c.ok ? 'text-green-400' : 'text-red-400'}">{c.status || 'no answer'}</td>
							<td class="py-1 pr-3 text-[var(--color-tron-text-secondary)]">{c.latencyMs} ms</td>
							<td class="py-1 text-[var(--color-tron-text-secondary)]">{c.username}{c.error ? ` — ${c.error}` : ''}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
</div>
