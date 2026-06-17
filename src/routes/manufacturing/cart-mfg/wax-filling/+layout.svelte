<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { RobotRunState, RobotHealthSummary } from '$lib/server/services/wax-filling/robots';

	interface Props {
		children: Snippet;
		data: {
			robots: { robotId: string; name: string; description: string }[];
			dashboardState: RobotRunState[];
			waxQueue?: {
				runId: string;
				robotName: string;
				status: string;
				cartridgeCount: number;
				robotReleasedAt: string | null;
				elapsedSinceReleasedMin: number;
				operatorName: string;
				trayId: string | null;
				fridgeLocation: string | null;
			}[];
		};
	}

	let { children, data }: Props = $props();

	let selectedRobotId = $derived($page.url.searchParams.get('robot') ?? '');

	let selectedRobotState = $derived(data.dashboardState.find((r) => r.robotId === selectedRobotId));

	const BASE = '/manufacturing/cart-mfg/wax-filling';

	// Sub-routes that are robot-agnostic — they should render regardless of robot selection
	let isRobotAgnosticRoute = $derived(
		$page.url.pathname.startsWith(`${BASE}/settings`) ||
			$page.url.pathname.startsWith(`${BASE}/oven-queue`) ||
			$page.url.pathname.startsWith(`${BASE}/equipment`)
	);

	function isActive(path: string, currentPath: string, exact = false): boolean {
		if (exact) return currentPath === path;
		return currentPath.startsWith(path);
	}

	let navLinkClass = $derived.by(
		() =>
			(path: string, exact = false) =>
				`min-h-[44px] rounded px-3 py-2 text-sm font-medium transition-colors ${
					isActive(path, $page.url.pathname, exact)
						? 'bg-[var(--color-tron-cyan)]/10 text-[var(--color-tron-cyan)]'
						: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'
				}`
	);

	function selectRobot(robotId: string) {
		// Just navigate — do NOT create a run here. Run creation is deferred to
		// "wax setup complete" so clicking between robot tabs leaves idle robots
		// idle (they only flip to a run once the operator commits the wax setup).
		const url = new URL($page.url);
		url.searchParams.set('robot', robotId);
		goto(url.pathname + url.search, { invalidateAll: true });
	}

	// --- Robot health (ready / busy / hung / offline) -----------------------
	// Polled from a lightweight endpoint so badges stay fresh WITHOUT a full
	// invalidateAll (which would reset the operator's in-progress wax form).
	let liveHealth = $state<Record<string, RobotHealthSummary>>({});
	let restartingId = $state<string | null>(null);
	let restartMsg = $state('');

	function healthFor(robotId: string): RobotHealthSummary | null {
		return liveHealth[robotId] ?? data.dashboardState.find((r) => r.robotId === robotId)?.health ?? null;
	}

	function healthDotClass(status?: string | null): string {
		switch (status) {
			case 'ready': return 'bg-green-400';
			case 'busy': return 'bg-amber-400';
			case 'hung': return 'bg-red-500 animate-pulse';
			case 'offline': return 'bg-gray-500';
			default: return 'bg-gray-600';
		}
	}

	async function pollHealth() {
		try {
			const res = await fetch('/api/opentrons-lab/robots/health');
			if (res.ok) {
				const body = await res.json();
				if (body?.health) liveHealth = body.health;
			}
		} catch {
			/* transient — keep last known */
		}
	}

	async function restartServer(robotId: string, robotName: string) {
		if (restartingId) return;
		if (!confirm(`Restart the robot server on ${robotName}?\n\nThis clears a hung engine (~90s to come back). Any in-progress run on this robot will be cancelled.`)) return;
		restartingId = robotId;
		restartMsg = '';
		try {
			const res = await fetch(`/api/opentrons-lab/robots/${robotId}/restart-server`, { method: 'POST' });
			const body = await res.json().catch(() => ({}));
			restartMsg = res.ok ? (body.message ?? 'Restart sent.') : (body.message ?? body.error ?? 'Restart failed.');
		} catch {
			restartMsg = 'Restart request failed — check the bridge.';
		} finally {
			restartingId = null;
			// Badges will reflect recovery on the next heartbeat; poll a bit sooner.
			setTimeout(pollHealth, 3000);
		}
	}

	// Compact "running for" label for the gallery run counter.
	function elapsedLabel(iso: string | Date): string {
		const ms = Date.now() - new Date(iso).getTime();
		if (!Number.isFinite(ms) || ms < 0) return '';
		const min = Math.floor(ms / 60000);
		if (min < 60) return `${min}m`;
		return `${Math.floor(min / 60)}h ${min % 60}m`;
	}

	onMount(() => {
		pollHealth();
		const id = setInterval(pollHealth, 10000);
		return () => clearInterval(id);
	});

	/** Compact "MMM D, H:MMa" — e.g. "Apr 20, 1:23p". Falls back to elapsed if null. */
	function formatFinished(iso: string | null, elapsedMin: number): string {
		if (!iso) return `${elapsedMin} min ago`;
		const d = new Date(iso);
		const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
		const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(' ', '').toLowerCase();
		return `${date}, ${time}`;
	}

	function stageBadgeColor(stage: string | null): string {
		if (!stage) return 'bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)]';
		switch (stage) {
			case 'Setup':
				return 'bg-blue-900/50 text-blue-300 border border-blue-500/30';
			case 'Loading':
				return 'bg-purple-900/50 text-purple-300 border border-purple-500/30';
			case 'Running':
				return 'bg-green-900/50 text-green-300 border border-green-500/30';
			case 'Awaiting Removal':
				return 'bg-yellow-900/50 text-yellow-300 border border-yellow-500/30';
			case 'QC':
				return 'bg-cyan-900/50 text-cyan-300 border border-cyan-500/30';
			default:
				return 'bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)]';
		}
	}
</script>

<div class="space-y-4">
	<nav class="flex items-center gap-2 text-sm">
		<a
			href={resolve('/manufacturing')}
			class="text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
		>
			Manufacturing
		</a>
		<span class="text-[var(--color-tron-text-secondary)]">/</span>
		<span class="text-[var(--color-tron-text)]">Wax Filling</span>
	</nav>

	<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
		<nav class="flex items-center gap-1">
			<a href={resolve('/manufacturing/cart-mfg/wax-filling')} class={navLinkClass(BASE, true)}>
				Run Wizard
			</a>
			<a
				href={resolve('/manufacturing/cart-mfg/wax-filling/oven-queue')}
				class={navLinkClass(`${BASE}/oven-queue`)}
			>
				Oven Queue
			</a>
			<a
				href={resolve('/manufacturing/cart-mfg/wax-filling/settings')}
				class={navLinkClass(`${BASE}/settings`)}
			>
				Settings
			</a>
			<a
				href="/manufacturing/cart-mfg/opentron-control/settings"
				class="min-h-[44px] rounded px-3 py-2 text-sm font-medium transition-colors text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]"
			>
				Teach Positions
			</a>
			<a
				href={resolve('/equipment/activity')}
				class="min-h-[44px] rounded px-3 py-2 text-sm font-medium transition-colors text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]"
			>
				Equipment
			</a>
		</nav>
	</div>

	<div class="flex gap-2 border-b border-[var(--color-tron-border)]">
		{#each data.dashboardState as robotState (robotState.robotId)}
			{@const isSelected = robotState.robotId === selectedRobotId}
			<button
				type="button"
				onclick={() => selectRobot(robotState.robotId)}
				class="flex min-h-[44px] items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors {isSelected
					? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
					: 'border-transparent text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
			>
				{#if healthFor(robotState.robotId)}
					{@const h = healthFor(robotState.robotId)}
					<span
						class="h-2.5 w-2.5 rounded-full {healthDotClass(h?.status)}"
						title={`${h?.label}: ${h?.detail}`}
					></span>
				{/if}
				{robotState.name}
				<span class="rounded px-1.5 py-0.5 text-xs {stageBadgeColor(robotState.stage)}">
					{robotState.hasActiveRun ? robotState.stage : 'Idle'}
				</span>
				{#if robotState.alerts.length > 0}
					<span class="h-2 w-2 rounded-full bg-red-500"></span>
				{/if}
			</button>
		{/each}
	</div>

	{#if selectedRobotId}
		{@const sh = healthFor(selectedRobotId)}
		{#if sh && (sh.status === 'hung' || sh.status === 'offline')}
			{@const selName = data.dashboardState.find((r) => r.robotId === selectedRobotId)?.name ?? 'this robot'}
			<div class="mt-3 flex flex-wrap items-center gap-3 rounded-lg border {sh.status === 'hung' ? 'border-red-500/50 bg-red-900/20' : 'border-gray-500/40 bg-gray-800/30'} px-4 py-3">
				<span class="h-2.5 w-2.5 rounded-full {healthDotClass(sh.status)}"></span>
				<div class="flex-1 text-sm">
					<span class="font-semibold {sh.status === 'hung' ? 'text-red-300' : 'text-gray-300'}">{sh.label}</span>
					<span class="text-[var(--color-tron-text-secondary)]"> — {sh.detail}</span>
				</div>
				{#if sh.status === 'hung'}
					<button
						type="button"
						onclick={() => restartServer(selectedRobotId, selName)}
						disabled={restartingId === selectedRobotId}
						class="min-h-[36px] rounded border border-red-500/60 bg-red-900/30 px-4 py-1.5 text-sm font-medium text-red-200 transition-colors hover:bg-red-900/50 disabled:opacity-50"
					>
						{restartingId === selectedRobotId ? 'Restarting…' : 'Restart robot server'}
					</button>
				{/if}
			</div>
			{#if restartMsg}
				<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">{restartMsg}</p>
			{/if}
		{/if}
	{/if}

	{#if selectedRobotId || isRobotAgnosticRoute}
		{@render children()}
	{:else}
		<!-- No robot selected — show robot selection cards -->
		<div class="space-y-4 pt-4">
			<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Select a Robot</h2>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">Choose a robot to start or continue a wax filling run.</p>
			<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{#each data.dashboardState as robotState (robotState.robotId)}
					{@const robot = data.robots.find((r) => r.robotId === robotState.robotId)}
					<button
						type="button"
						onclick={() => selectRobot(robotState.robotId)}
						class="group flex flex-col items-center gap-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 transition-all hover:border-[var(--color-tron-cyan)] hover:shadow-[0_0_15px_rgba(0,255,255,0.15)]"
					>
						<div class="flex h-16 w-16 items-center justify-center rounded-full border-2 border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] transition-colors group-hover:border-[var(--color-tron-cyan)]">
							<svg class="h-8 w-8 text-[var(--color-tron-text-secondary)] transition-colors group-hover:text-[var(--color-tron-cyan)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
							</svg>
						</div>
						<div class="text-center">
							<h3 class="text-lg font-semibold text-[var(--color-tron-text)] transition-colors group-hover:text-[var(--color-tron-cyan)]">
								{robotState.name}
							</h3>
							{#if robot?.description}
							{/if}
						</div>
						{#if healthFor(robotState.robotId)}
							{@const h = healthFor(robotState.robotId)}
							<div class="flex items-center gap-1.5 text-xs" title={h?.detail}>
								<span class="h-2 w-2 rounded-full {healthDotClass(h?.status)}"></span>
								<span class="{h?.status === 'hung' ? 'text-red-300' : h?.status === 'offline' ? 'text-gray-400' : h?.status === 'busy' ? 'text-amber-300' : 'text-green-300'}">{h?.label}</span>
							</div>
						{/if}
						{#if robotState.hasActiveRun && robotState.activeProcess}
							<div class="flex flex-col items-center gap-1">
								<div class="flex items-center gap-2 rounded border border-amber-500/30 bg-amber-900/20 px-3 py-1.5 text-xs text-amber-300">
									<span class="h-2 w-2 rounded-full bg-amber-400 animate-pulse"></span>
									{robotState.activeProcess === 'wax' ? 'Wax' : 'Reagent'}: {robotState.stage}
								</div>
								{#if (robotState.cartridgeCount ?? 0) > 0 || robotState.runStartTime}
									<div class="text-xs text-[var(--color-tron-text-secondary)]">
										{#if (robotState.cartridgeCount ?? 0) > 0}{robotState.cartridgeCount} cart{robotState.cartridgeCount === 1 ? '' : 's'}{/if}{#if (robotState.cartridgeCount ?? 0) > 0 && robotState.runStartTime} · {/if}{#if robotState.runStartTime}{elapsedLabel(robotState.runStartTime)}{/if}
									</div>
								{/if}
							</div>
						{:else}
							<div class="flex items-center gap-2 text-xs text-green-300">
								<span class="h-2 w-2 rounded-full bg-green-400"></span>
								Idle
							</div>
						{/if}
						{#if robotState.alerts.length > 0}
							{#each robotState.alerts as alert (alert.type)}
								<span class="rounded border border-red-500/30 bg-red-900/50 px-2 py-1 text-xs font-medium text-red-300">
									{alert.message}
								</span>
							{/each}
						{/if}
						{#if robotState.hasActiveRun && robotState.activeProcess === 'reagent'}
							<a
								href={resolve('/manufacturing/cart-mfg/reagent-filling') + '?robot=' + robotState.robotId}
								class="rounded border border-amber-500/50 bg-amber-900/20 px-3 py-1.5 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-900/30"
								onclick={(e) => e.stopPropagation()}
							>
								Go to reagent run →
							</a>
						{/if}
					</button>
				{/each}
			</div>
		</div>
	{/if}

	<!-- The post-OT-2 "Wax Cartridges Requiring Inspection & Storage" queue was
	     removed from wax filling — inspection (photo + Ready/Rejected) lives on the
	     Wax Inspect page, not the wax-fill flow. -->
</div>
