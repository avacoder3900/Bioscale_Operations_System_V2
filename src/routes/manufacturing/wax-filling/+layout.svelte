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
		};
	}

	let { children, data }: Props = $props();

	let selectedRobotId = $derived($page.url.searchParams.get('robot') ?? '');

	let selectedRobotState = $derived(data.dashboardState.find((r) => r.robotId === selectedRobotId));

	const BASE = '/manufacturing/wax-filling';

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
		goto(url.pathname + url.search, { invalidateAll: true });
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
			<a href={resolve('/manufacturing/wax-filling')} class={navLinkClass(BASE, true)}>
				Run Wizard
			</a>
			<a
				href={resolve('/manufacturing/wax-filling/oven-queue')}
				class={navLinkClass(`${BASE}/oven-queue`)}
			>
				Oven Queue
			</a>
			<a
				href={resolve('/manufacturing/wax-filling/settings')}
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
								href={resolve('/manufacturing/reagent-filling') + '?robot=' + robotState.robotId}
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
</div>
