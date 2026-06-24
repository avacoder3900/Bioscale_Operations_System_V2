<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { ReagentRobotRunState } from '$lib/server/services/reagent-filling/robots';
	import type { RobotHealthSummary } from '$lib/server/services/wax-filling/robots';

	interface Props {
		children: Snippet;
		data: {
			robots: { robotId: string; name: string; description: string }[];
			dashboardState: ReagentRobotRunState[];
			reagentQueue?: {
				runId: string;
				robotName: string;
				status: string;
				assayTypeName: string;
				cartridgeCount: number;
				sealedCount: number;
				robotReleasedAt: string | null;
				elapsedSinceReleasedMin: number;
				sealMinRemaining: number;
				sealOverdue: boolean;
				operatorName: string;
				trayId: string | null;
				fridgeLocation: string | null;
			}[];
		};
	}

	let { children, data }: Props = $props();

	let selectedRobotId = $derived(
		$page.url.searchParams.get('robot') ?? ''
	);

	let selectedRobotState = $derived(
		data.dashboardState.find((r) => r.robotId === selectedRobotId)
	);

	const BASE = '/manufacturing/cart-mfg/reagent-filling';

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
		const url = new URL($page.url);
		url.searchParams.set('robot', robotId);
		// Use relative path (pathname + search) — passing a full URL to goto()
		// has been observed to skip SPA navigation. Matches the wax-filling pattern.
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- URL built from current page
		goto(url.pathname + url.search, { invalidateAll: true });
	}

	// --- Robot health (ready / busy / hung / offline) — mirrors wax-filling ---
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
	function elapsedLabel(iso: string | Date | null): string {
		if (!iso) return '';
		const ms = Date.now() - new Date(iso).getTime();
		if (!Number.isFinite(ms) || ms < 0) return '';
		const min = Math.floor(ms / 60000);
		return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
	}
	async function pollHealth() {
		try {
			const res = await fetch('/api/opentrons-lab/robots/health');
			if (res.ok) {
				const body = await res.json();
				if (body?.health) liveHealth = body.health;
			}
		} catch { /* keep last known */ }
	}
	async function restartServer(robotId: string, robotName: string) {
		if (restartingId) return;
		if (!confirm(`Restart the robot server on ${robotName}?\n\nThis clears a hung engine (~90s). Any in-progress run on this robot will be cancelled.`)) return;
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
			setTimeout(pollHealth, 3000);
		}
	}
	// Master "force reset to idle" — aborts any stale reagent/wax run record that's
	// locking the robot AND best-effort clears the robot's own run state. Works in
	// any circumstance (stale BIMS record, stuck robot run). Cartridges left as-is.
	let resettingId = $state<string | null>(null);
	let resetMsg = $state('');
	async function forceReset(robotId: string, robotName: string) {
		if (resettingId) return;
		if (!confirm(`Force ${robotName} back to idle?\n\nThis ABORTS any active reagent/wax run on this robot and clears its run state. Use for stale/stuck runs. Cartridges are left as-is.`)) return;
		resettingId = robotId;
		resetMsg = '';
		try {
			const res = await fetch(`/api/opentrons-lab/robots/${robotId}/force-reset`, { method: 'POST' });
			const body = await res.json().catch(() => ({}));
			resetMsg = res.ok ? (body.message ?? 'Reset to idle.') : (body.message ?? body.error ?? 'Reset failed.');
			if (res.ok) await invalidateAll();
		} catch {
			resetMsg = 'Reset request failed — check the bridge.';
		} finally {
			resettingId = null;
			setTimeout(pollHealth, 1500);
		}
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

	function sealUrgencyColor(overdue: boolean, minRemaining: number): string {
		if (overdue) return 'text-red-400';
		if (minRemaining <= 15) return 'text-yellow-400';
		return 'text-green-400';
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
			case 'Inspection':
				return 'bg-yellow-900/50 text-yellow-300 border border-yellow-500/30';
			case 'Top Sealing':
				return 'bg-cyan-900/50 text-cyan-300 border border-cyan-500/30';
			case 'Storage':
				return 'bg-orange-900/50 text-orange-300 border border-orange-500/30';
			case 'Completed':
				return 'bg-emerald-900/50 text-emerald-300 border border-emerald-500/30';
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
		<span class="text-[var(--color-tron-text)]">Reagent Filling</span>
	</nav>

	<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
		<div class="flex items-center gap-3">
			<label for="robot-select" class="text-sm font-medium text-[var(--color-tron-text-secondary)]">
				Robot
			</label>
			<select
				id="robot-select"
				value={selectedRobotId}
				onchange={(e) => selectRobot(e.currentTarget.value)}
				class="min-h-[44px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
			>
				{#each data.robots as robot (robot.robotId)}
					<option value={robot.robotId}>{robot.name}</option>
				{/each}
			</select>

			{#if selectedRobotState}
				<span
					class="rounded px-2 py-1 text-xs font-medium {stageBadgeColor(selectedRobotState.stage)}"
				>
					{selectedRobotState.hasActiveRun ? selectedRobotState.stage : 'Idle'}
				</span>
				{#if selectedRobotState.assayTypeName && selectedRobotState.hasActiveRun}
					<span
						class="rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 px-2 py-1 text-xs font-medium text-[var(--color-tron-cyan)]"
					>
						{selectedRobotState.assayTypeName}
					</span>
				{/if}
			{/if}
		</div>

		<nav class="flex items-center gap-1">
			<a href={resolve('/manufacturing/cart-mfg/reagent-filling')} class={navLinkClass(BASE, true)}>
				Run Wizard
			</a>
			<a
				href={resolve('/manufacturing/cart-mfg/reagent-filling/cooling-queue')}
				class={navLinkClass(`${BASE}/cooling-queue`)}
			>
				Cooling Queue
			</a>
			<a
				href={resolve('/manufacturing/cart-mfg/reagent-filling/settings')}
				class={navLinkClass(`${BASE}/settings`)}
			>
				Settings
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
					<span class="h-2.5 w-2.5 rounded-full {healthDotClass(h?.status)}" title={`${h?.label}: ${h?.detail}`}></span>
				{/if}
				{robotState.name}
				<span class="rounded px-1.5 py-0.5 text-xs {stageBadgeColor(robotState.stage)}">
					{robotState.hasActiveRun ? robotState.stage : 'Idle'}
				</span>
			</button>
		{/each}
	</div>

	{#if selectedRobotId}
		{@const sh = healthFor(selectedRobotId)}
		{@const selName = data.dashboardState.find((r) => r.robotId === selectedRobotId)?.name ?? 'this robot'}
		{@const isHung = sh?.status === 'hung'}
		{@const isOffline = sh?.status === 'offline'}
		<!-- Restart-server control is ALWAYS available for the selected robot, not just
		     when health reports "hung" (mirrors wax-filling). Loud red only when hung. -->
		<div class="mt-3 flex flex-wrap items-center gap-3 rounded-lg border {isHung ? 'border-red-500/50 bg-red-900/20' : isOffline ? 'border-gray-500/40 bg-gray-800/30' : 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]'} px-4 py-3">
			<span class="h-2.5 w-2.5 rounded-full {healthDotClass(sh?.status)}"></span>
			<div class="flex-1 text-sm">
				<span class="font-semibold {isHung ? 'text-red-300' : isOffline ? 'text-gray-300' : 'text-[var(--color-tron-text)]'}">{sh?.label ?? 'Robot'}</span>
				{#if sh?.detail}<span class="text-[var(--color-tron-text-secondary)]"> — {sh.detail}</span>{/if}
			</div>
			<button type="button" onclick={() => restartServer(selectedRobotId, selName)} disabled={restartingId === selectedRobotId}
				class="min-h-[36px] rounded border px-4 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 {isHung
					? 'border-red-500/60 bg-red-900/30 text-red-200 hover:bg-red-900/50'
					: 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-text)]'}">
				{restartingId === selectedRobotId ? 'Restarting…' : 'Restart robot server'}
			</button>
		</div>
		{#if restartMsg}<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">{restartMsg}</p>{/if}
		{@render children()}
	{:else}
		<!-- No robot selected — show robot selection cards -->
		<div class="space-y-4 pt-4">
			<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Select a Robot</h2>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">Choose a robot to start or continue a reagent filling run.</p>
			<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{#each data.dashboardState as robotState (robotState.robotId)}
					{@const robot = data.robots.find((r) => r.robotId === robotState.robotId)}
					<div class="flex flex-col gap-2">
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
						{#if robotState.hasActiveRun && robotState.activeProcess === 'wax'}
							<a
								href={resolve('/manufacturing/cart-mfg/wax-filling') + '?robot=' + robotState.robotId}
								class="rounded border border-amber-500/50 bg-amber-900/20 px-3 py-1.5 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-900/30"
								onclick={(e) => e.stopPropagation()}
							>
								Go to wax run →
							</a>
						{/if}
					</button>
					<!-- Master force-reset: free a robot stuck on a stale run, in any circumstance. -->
					<button
						type="button"
						onclick={() => forceReset(robotState.robotId, robotState.name)}
						disabled={resettingId === robotState.robotId}
						class="rounded border border-red-500/40 bg-red-900/15 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-900/30 disabled:opacity-40"
						title="Abort any stale run and force this robot back to idle"
					>
						{resettingId === robotState.robotId ? 'Resetting…' : 'Force reset to idle'}
					</button>
					{#if resetMsg && resettingId === null}
						<p class="text-center text-[11px] text-[var(--color-tron-text-secondary)]">{resetMsg}</p>
					{/if}
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Post-OT-2 reagent queue: runs awaiting top sealing / storage. Lives here
	     (not only on the Opentron Control backup route) so the inline flow is complete. -->
	{#if (data.reagentQueue?.length ?? 0) > 0}
		<section class="pt-2">
			<div class="mb-3 flex items-center gap-3">
				<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
					Reagent Cartridges Requiring Top Sealing &amp; Storage
				</h2>
				<span class="rounded-full bg-purple-500/20 px-2.5 py-0.5 text-xs font-bold text-purple-300">
					{data.reagentQueue!.length}
				</span>
			</div>
			<div class="space-y-2">
				{#each data.reagentQueue! as run (run.runId)}
					<a href="/manufacturing/cart-mfg/opentron-control/reagent/{run.runId}"
						class="flex items-center justify-between rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 transition-all hover:border-purple-500/50 hover:bg-purple-900/5">
						<div class="flex items-center gap-4">
							<div>
								<span class="font-mono text-sm font-bold text-purple-300">{run.runId.slice(-8)}</span>
								<p class="text-xs" style="color: var(--color-tron-text-secondary)">{run.robotName} &middot; {run.assayTypeName || 'Unknown assay'} &middot; {run.operatorName}</p>
								<p class="mt-0.5 text-xs" style="color: var(--color-tron-text-secondary)">
									{#if run.trayId}<span>Tray <span class="font-mono text-[var(--color-tron-text)]">{run.trayId}</span></span>{/if}
									{#if run.trayId && run.fridgeLocation} &middot; {/if}
									{#if run.fridgeLocation}<span>Fridge <span class="font-mono text-[var(--color-tron-text)]">{run.fridgeLocation}</span></span>{/if}
								</p>
							</div>
							<div class="rounded bg-purple-500/10 px-2 py-1 text-xs font-medium text-purple-300">
								{run.status}
							</div>
						</div>
						<div class="flex items-center gap-6 text-right">
							<div>
								<p class="text-sm font-bold" style="color: var(--color-tron-text)">{run.sealedCount}/{run.cartridgeCount} sealed</p>
								<p class="text-xs" style="color: var(--color-tron-text-secondary)">OT-2 done {formatFinished(run.robotReleasedAt, run.elapsedSinceReleasedMin)}</p>
								<p class="mt-0.5 text-xs {sealUrgencyColor(run.sealOverdue, run.sealMinRemaining)}">
									{#if run.sealOverdue}
										OVERDUE — seal immediately
									{:else}
										{run.sealMinRemaining} min to seal deadline
									{/if}
								</p>
							</div>
							<svg class="h-5 w-5" style="color: var(--color-tron-text-secondary)" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
							</svg>
						</div>
					</a>
				{/each}
			</div>
		</section>
	{/if}
</div>
