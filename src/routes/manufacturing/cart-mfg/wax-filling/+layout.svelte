<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { RobotRunState } from '$lib/server/services/wax-filling/robots';

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

	async function selectRobot(robotId: string) {
		const state = data.dashboardState.find((r) => r.robotId === robotId);
		// No active run on this robot → start one now so clicking goes straight
		// into wax setup (no intermediate "Start Wax Filling Run" page).
		if (state && !state.hasActiveRun) {
			try {
				const fd = new FormData();
				fd.set('robotId', robotId);
				await fetch(`${BASE}?/createRun`, {
					method: 'POST',
					body: fd,
					headers: { 'x-sveltekit-action': 'true' }
				});
			} catch {
				/* fall through — the page still shows the manual start button */
			}
		}
		const url = new URL($page.url);
		url.searchParams.set('robot', robotId);
		goto(url.pathname + url.search, { invalidateAll: true });
	}

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
		<div class="flex items-center gap-3">
			<span class="text-sm font-medium text-[var(--color-tron-text)]">
				{data.robots.find((r) => r.robotId === selectedRobotId)?.name ?? 'Robot'}
			</span>

			{#if selectedRobotState}
				<span
					class="rounded px-2 py-1 text-xs font-medium {stageBadgeColor(selectedRobotState.stage)}"
				>
					{selectedRobotState.hasActiveRun ? selectedRobotState.stage : 'Idle'}
				</span>
				{#each selectedRobotState.alerts as alert (alert.type)}
					<span
						class="rounded border border-red-500/30 bg-red-900/50 px-2 py-1 text-xs font-medium text-red-300"
					>
						{alert.message}
					</span>
				{/each}
			{/if}
		</div>

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
						{#if robotState.hasActiveRun && robotState.activeProcess}
							<div class="flex items-center gap-2 rounded border border-amber-500/30 bg-amber-900/20 px-3 py-1.5 text-xs text-amber-300">
								<span class="h-2 w-2 rounded-full bg-amber-400 animate-pulse"></span>
								{robotState.activeProcess === 'wax' ? 'Wax' : 'Reagent'}: {robotState.stage}
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

	<!-- Post-OT-2 wax queue: runs awaiting QC / storage. Lives here (not only
	     on the Opentron Control backup route) so the inline flow is complete. -->
	{#if !isRobotAgnosticRoute && (data.waxQueue?.length ?? 0) > 0}
		<section class="pt-2">
			<div class="mb-3 flex items-center gap-3">
				<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
					Wax Cartridges Requiring Inspection &amp; Storage
				</h2>
				<span class="rounded-full bg-[var(--color-tron-cyan)]/20 px-2.5 py-0.5 text-xs font-bold text-[var(--color-tron-cyan)]">
					{data.waxQueue!.length}
				</span>
			</div>
			<div class="space-y-2">
				{#each data.waxQueue! as run (run.runId)}
					<a href="/manufacturing/cart-mfg/opentron-control/wax/{run.runId}"
						class="flex items-center justify-between rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 transition-all hover:border-[var(--color-tron-cyan)]/50 hover:bg-[var(--color-tron-cyan)]/5">
						<div class="flex items-center gap-4">
							<div>
								<span class="font-mono text-sm font-bold" style="color: var(--color-tron-cyan)">{run.runId.slice(-8)}</span>
								<p class="text-xs" style="color: var(--color-tron-text-secondary)">{run.robotName} &middot; {run.operatorName}</p>
								<p class="mt-0.5 text-xs" style="color: var(--color-tron-text-secondary)">
									{#if run.trayId}<span>Tray <span class="font-mono text-[var(--color-tron-text)]">{run.trayId}</span></span>{/if}
									{#if run.trayId && run.fridgeLocation} &middot; {/if}
									{#if run.fridgeLocation}<span>Fridge <span class="font-mono text-[var(--color-tron-text)]">{run.fridgeLocation}</span></span>{/if}
								</p>
							</div>
							<div class="rounded bg-[var(--color-tron-cyan)]/10 px-2 py-1 text-xs font-medium" style="color: var(--color-tron-cyan)">
								{run.status}
							</div>
						</div>
						<div class="flex items-center gap-6 text-right">
							<div>
								<p class="text-sm font-bold" style="color: var(--color-tron-text)">{run.cartridgeCount} cartridges</p>
								<p class="text-xs" style="color: var(--color-tron-text-secondary)">OT-2 done {formatFinished(run.robotReleasedAt, run.elapsedSinceReleasedMin)}</p>
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
