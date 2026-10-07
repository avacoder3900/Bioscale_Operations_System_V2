<!--
  Robots page group (ROBOT-OVERHAUL, 2026-10-07). The RobotBoard — every OT-2,
  wax AND reagent, health, restart/reset — sits on top of /robots, where every
  open wizard renders side by side (round 2: no more one-robot pages). Tool
  pages (settings, history, cooling queue, well issues) stand on their own
  under the breadcrumb instead of the board.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';
	import { resolve } from '$app/paths';
	import RobotBoard from '$lib/components/manufacturing/RobotBoard.svelte';
	import type { BoardProcess } from '$lib/manufacturing/robot-panels';
	import type { RobotBoardRow } from '$lib/server/manufacturing/robot-board';

	interface Props {
		children: Snippet;
		data: { board: RobotBoardRow[] };
	}

	let { children, data }: Props = $props();

	const path = $derived($page.url.pathname);
	// Tool pages stand on their own — no board above them.
	const isTool = $derived(/\/(settings|history|cooling-queue|well-issues)(\/|$)/.test(path));
	const crumb = $derived(
		!isTool
			? ''
			: path.endsWith('/history')
				? 'Run history'
				: path.endsWith('/cooling-queue')
					? 'Cooling queue'
					: path.endsWith('/well-issues')
						? 'Well issues'
						: path.includes('/wax-filling/')
							? 'Wax settings'
							: 'Reagent settings'
	);
	// Which wizard is open per robot (from the Robots page's own load) — the
	// board uses it to show Open / Close instead of Start.
	const openPanels = $derived.by(() => {
		const out: Record<string, BoardProcess> = {};
		for (const p of ($page.data.panels ?? []) as { robotId: string; process: BoardProcess }[]) out[p.robotId] = p.process;
		return out;
	});
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
		<RobotBoard rows={data.board} {openPanels} />
		<div class="border-t border-[var(--color-tron-border)] pt-4">
			{@render children()}
		</div>
	{/if}
</div>
