<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { ReagentRobotRunState } from '$lib/server/services/reagent-filling/robots';

	interface Props {
		children: Snippet;
		data: {
			robots: { robotId: string; name: string; description: string }[];
			dashboardState: ReagentRobotRunState[];
		};
	}

	let { children, data }: Props = $props();

	let selectedRobotId = $derived(
		$page.url.searchParams.get('robot') ?? data.robots[0]?.robotId ?? ''
	);

	let selectedRobotState = $derived(
		data.dashboardState.find((r) => r.robotId === selectedRobotId)
	);

	const BASE = '/manufacturing/reagent-filling';

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
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- URL built from current page
		goto(url.toString(), { replaceState: true, invalidateAll: true });
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
		<a
			href={resolve('/manufacturing/opentrons')}
			class="text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
		>
			Opentrons
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
			<a href={resolve('/manufacturing/reagent-filling')} class={navLinkClass(BASE, true)}>
				Run Wizard
			</a>
			<a
				href={resolve('/manufacturing/reagent-filling/cooling-queue')}
				class={navLinkClass(`${BASE}/cooling-queue`)}
			>
				Cooling Queue
			</a>
			<a
				href={resolve('/manufacturing/reagent-filling/settings')}
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
			</button>
		{/each}
	</div>

	{@render children()}
</div>
