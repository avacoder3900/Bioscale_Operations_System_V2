<!--
  Fleet connectivity (OT2-TAILNET-4). One row per robot: which line BIMS uses
  and why, plus a live probe of each tailnet robot from THIS browser — the only
  thing that can tell whether this computer is on the tailnet.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { queryLocalNetworkPermission, type LocalNetworkPermission } from '$lib/opentrons/direct-client';
	import { createBridgeClient, plainRobotFetch, type BridgeClient, type BridgeProbe } from '$lib/opentrons/bridge-client';

	let { data } = $props();

	type Probe = { state: 'idle' | 'probing' | 'ok' | 'fail'; ms?: number; detail?: string };
	let probes = $state<Record<string, Probe>>({});

	/** Daemon column (OT2-TAILNET-5 §8): /bridge on the robot's own tailnet origin, from THIS browser. */
	type Daemon =
		| { phase: 'probing' }
		| { phase: 'done'; probe: BridgeProbe; version?: string; healthMs?: number; healthError?: string };
	let daemons = $state<Record<string, Daemon>>({});
	// One client per robot so a health-only token (audit-logged when minted) is
	// reused across "Probe again" clicks until it nears expiry.
	const bridgeClients = new Map<string, BridgeClient>();

	async function probeDaemon(r: (typeof data.robots)[number], timeoutMs: number) {
		if (!r.directUrl) return;
		daemons[r.robotId] = { phase: 'probing' };
		let client = bridgeClients.get(r.robotId);
		if (!client) {
			client = createBridgeClient({ robotId: r.robotId, robotFetch: plainRobotFetch(r.directUrl), kinds: [] });
			bridgeClients.set(r.robotId, client);
		}
		// 1. No token: is /bridge served on this origin at all? (+ latency)
		const probe = await client.probe(timeoutMs);
		const result: Extract<Daemon, { phase: 'done' }> = { phase: 'done', probe };
		// 2. With a health-only token, when this deployment can mint one for this
		//    robot: the daemon's version + authenticated latency.
		if (probe.served && data.bridge.canMintTokens && r.bridgeJobsHere) {
			try {
				const h = await client.health();
				result.version = h.body.version;
				result.healthMs = h.latencyMs;
			} catch (e) {
				result.healthError = e instanceof Error ? e.message : String(e);
			}
		}
		daemons[r.robotId] = result;
	}

	function daemonAuthHint(r: (typeof data.robots)[number]): string {
		if (!data.bridge.canMintTokens) return 'version needs manufacturing:write (a bridge token)';
		if (!data.bridge.secretSet) return 'version needs OT2_BRIDGE_TOKEN_SECRET on this deployment';
		if (!r.bridgeJobsHere) return 'version needs this robot on the tailnet line here';
		return '';
	}
	/**
	 * Which line a robot page's daemon jobs take from THIS browser. The session
	 * submits them to /bridge only when this deployment allows daemon jobs for the
	 * robot (bridgeJobsHere = bridgeJobGate, the same gate as /connection's
	 * bridgeJobs) AND this computer reaches the robot directly.
	 */
	function daemonJobsLine(r: (typeof data.robots)[number], direct: boolean): string {
		if (!r.bridgeJobsHere) return 'BIMS queue';
		return direct ? 'Tailscale (/bridge)' : 'BIMS queue (this computer is not on the direct line)';
	}
	function daemonJobsTitle(r: (typeof data.robots)[number]): string {
		if (r.bridgeJobsHere) return 'Daemon jobs are allowed over Tailscale for this robot on this deployment';
		if (r.transport !== 'tailnet') return `Daemon jobs stay on the BIMS queue: ${r.reason}`;
		return data.bridge.secretSet
			? 'Daemon jobs stay on the BIMS queue here'
			: 'Daemon jobs stay on the BIMS queue: OT2_BRIDGE_TOKEN_SECRET is not set on this deployment';
	}
	/** Chrome's Local Network Access permission for THIS BIMS address. */
	let permission = $state<LocalNetworkPermission>('unsupported');

	async function probe(robotId: string, directUrl: string, timeoutMs = 3000) {
		probes[robotId] = { state: 'probing' };
		const t0 = performance.now();
		try {
			const res = await fetch(`${directUrl}/health`, {
				headers: { 'opentrons-version': '3' },
				signal: AbortSignal.timeout(timeoutMs)
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

	async function probeAll(timeoutMs = 3000) {
		permission = await queryLocalNetworkPermission();
		if (permission === 'prompt' && timeoutMs === 3000) return; // needs a click — see allowDirect()
		await Promise.all(
			data.robots
				.filter((r) => r.directUrl)
				.flatMap((r) => [probe(r.robotId, r.directUrl!, timeoutMs), probeDaemon(r, timeoutMs)])
		);
		permission = await queryLocalNetworkPermission();
	}

	/** From a click, so Chrome may show its "access devices on your network" prompt; wait for the answer. */
	const allowDirect = () => void probeAll(60_000);

	onMount(() => void probeAll());

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
			onclick={() => void probeAll()}
			class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-sm text-[var(--color-tron-text)] hover:border-[var(--color-tron-cyan)]"
		>
			Probe again
		</button>
	</div>

	{#if permission === 'prompt'}
		<div class="flex items-center justify-between gap-4 rounded-lg border border-amber-500/40 bg-amber-900/20 p-3 text-sm text-amber-200">
			<span>
				This browser has not yet allowed BIMS to reach robots on your network (Chrome "Local network access", asked once per
				BIMS address). Until it does, every robot here stays on the queue.
			</span>
			<button type="button" onclick={allowDirect} class="shrink-0 rounded border border-amber-400/60 px-3 py-1.5 text-amber-100 hover:bg-amber-800/40">
				Allow direct link
			</button>
		</div>
	{:else if permission === 'denied'}
		<div class="rounded-lg border border-red-500/40 bg-red-900/20 p-3 text-sm text-red-200">
			This browser blocked BIMS from reaching devices on your network. Click the icon left of the address bar → Site settings →
			<strong>Local network access → Allow</strong>, then reload. Robots stay on the queue until then.
		</div>
	{/if}

	<div class="overflow-x-auto rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
		<table class="w-full text-sm">
			<thead class="text-left text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
				<tr class="border-b border-[var(--color-tron-border)]">
					<th class="px-3 py-2">Robot</th>
					<th class="px-3 py-2">Line in use</th>
					<th class="px-3 py-2">Robot set to</th>
					<th class="px-3 py-2">Allowed here</th>
					<th class="px-3 py-2">From this browser</th>
					<th class="px-3 py-2" title="The robot's bridge daemon (/bridge on the tailnet URL), probed from this browser">Daemon</th>
					<th class="px-3 py-2">Bridge heartbeat</th>
					<th class="px-3 py-2">Direct calls 24 h</th>
				</tr>
			</thead>
			<tbody>
				{#each data.robots as r (r.robotId)}
					{@const p = probes[r.robotId]}
					{@const d = daemons[r.robotId]}
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
							{:else if !p && permission === 'prompt'}
								<span class="text-amber-300">needs browser permission</span>
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
							{#if !r.directUrl}
								<span class="text-[var(--color-tron-text-secondary)]">—</span>
							{:else if !d && permission === 'prompt'}
								<span class="text-amber-300">needs browser permission</span>
							{:else if !d || d.phase === 'probing'}
								<span class="text-[var(--color-tron-text-secondary)]">probing…</span>
							{:else if d.probe.served}
								{#if d.version}
									<span class="text-green-400">✓ {d.healthMs} ms</span>
									<div class="font-mono text-[11px] text-[var(--color-tron-text-secondary)]">{d.version}</div>
								{:else if d.probe.state === 'disabled'}
									<span class="text-amber-300">/bridge served, job server off</span>
									<div class="text-[11px] text-[var(--color-tron-text-secondary)]">no BRIDGE_TOKEN_SECRET on the robot</div>
								{:else}
									<span class="text-green-400">✓ /bridge served · {d.probe.latencyMs} ms</span>
									<div class="text-[11px] text-[var(--color-tron-text-secondary)]">
										{d.healthError ? `health: ${d.healthError}` : daemonAuthHint(r)}
									</div>
								{/if}
							{:else if d.probe.state === 'not-served'}
								<span class="text-[var(--color-tron-text-secondary)]">✗ /bridge not served</span>
								<div class="text-[11px] text-[var(--color-tron-text-secondary)]">
									robot answered {d.probe.status} — old daemon or no serve mount (ot2-tailnet-provision.sh)
								</div>
							{:else}
								<span class="text-red-400">✗</span>
								<div class="max-w-xs text-[11px] text-[var(--color-tron-text-secondary)]">
									{p?.state === 'ok'
										? 'robot API answers but /bridge gave no readable reply — daemon down, or this BIMS address is not on its CORS list'
										: 'unreachable from this computer'}
								</div>
							{/if}
							<!-- OT2-TAILNET-5 S6: where a page's daemon jobs (sweep, deck scan, tip calibrate, tip swap, restart, test-scan) go from this browser. -->
							<div class="mt-1 max-w-xs text-[11px] text-[var(--color-tron-text-secondary)]" title={daemonJobsTitle(r)}>
								jobs: {daemonJobsLine(r, direct)}
							</div>
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
