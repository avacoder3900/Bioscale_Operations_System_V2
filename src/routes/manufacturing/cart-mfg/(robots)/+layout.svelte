<!--
  Robots page group (ROBOT-OVERHAUL, 2026-10-07). The RobotBoard — every OT-2,
  wax AND reagent, health, restart/reset — stays on top of /robots and both
  wizards, so moving from one robot or process to another never leaves the
  page. Tool pages (settings, history, cooling queue, well issues) stand on
  their own under the breadcrumb instead of the board.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';
	import { resolve } from '$app/paths';
	import RobotBoard from '$lib/components/manufacturing/RobotBoard.svelte';
	import type { BoardProcess, RobotBoardRow } from '$lib/server/manufacturing/robot-board';

	interface Props {
		children: Snippet;
		data: { board: RobotBoardRow[] };
	}

	let { children, data }: Props = $props();

	const BASE = '/manufacturing/cart-mfg';
	const path = $derived($page.url.pathname);
	const selectedProcess = $derived<BoardProcess | null>(
		path.startsWith(`${BASE}/wax-filling`) ? 'wax' : path.startsWith(`${BASE}/reagent-filling`) ? 'reagent' : null
	);
	// Tool pages stand on their own — no board above them.
	const isTool = $derived(/\/(settings|history|cooling-queue|well-issues)(\/|$)/.test(path));
	const isWizard = $derived(selectedProcess !== null && !isTool);
	const selectedRobotId = $derived(isWizard ? ($page.url.searchParams.get('robot') ?? '') : '');
	const selectedName = $derived(data.board.find((r) => r.robotId === selectedRobotId)?.name ?? '');
	const processName = $derived(selectedProcess === 'wax' ? 'Wax' : 'Reagent');
	const crumb = $derived(
		isTool
			? path.endsWith('/history')
				? 'Run history'
				: path.endsWith('/cooling-queue')
					? 'Cooling queue'
					: path.endsWith('/well-issues')
						? 'Well issues'
						: `${processName} settings`
			: selectedProcess
				? `${processName} filling${selectedName ? ` · ${selectedName}` : ''}`
				: ''
	);
</script>

<div class="space-y-4">
	<nav class="flex items-center gap-2 text-sm">
		<a href={resolve('/manufacturing')} class="text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]">Manufacturing</a>
		<span class="text-[var(--color-tron-text-secondary)]">/</span>
		{#if crumb}
			<a href={resolve('/manufacturing/cart-mfg/robots')} class="text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]">Robots</a>
			<span class="text-[var(--color-tron-text-secondary)]">/</span>
			<span class="text-[var(--color-tron-text)]">{crumb}</span>
		{:else}
			<span class="text-[var(--color-tron-text)]">Robots</span>
		{/if}
	</nav>

	{#if isTool}
		{@render children()}
	{:else}
		<RobotBoard rows={data.board} {selectedRobotId} {selectedProcess} />

		{#if isWizard && !selectedRobotId}
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				Pick a robot above to start or continue a {selectedProcess} fill.
			</p>
		{:else}
			<div class="border-t border-[var(--color-tron-border)] pt-4">
				{@render children()}
			</div>
		{/if}
	{/if}
</div>
