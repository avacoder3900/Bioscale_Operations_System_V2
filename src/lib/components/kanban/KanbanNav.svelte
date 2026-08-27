<script lang="ts">
	import { page } from '$app/stores';

	// The single kanban nav (KB2-06; KB2-14 folded Replenish into Inventory;
	// KB2-15 folded Analytics into Flow and absorbed the old header nav;
	// KB2-16 removed Projects and the ops/software board switcher — one board,
	// tags carry the grouping).
	// KB2-16 decision #11 (amended 2026-08-18): the committed queue is simply
	// "Board" — once something is on it, it's approved; no second priority list.
	// Tier 1 stays the unbounded option inventory. Routes stay.
	// KB2-29 adds Roadmap (derived schedule + must-start) and Plans
	// (immortalized strategy docs).
	// The Cleaning calendar sits at /spu/cleaning, outside the kanban tree, but
	// it is scheduled work like everything else here so it rides in this tab bar
	// immediately right of Roadmap. Following it leaves the kanban layout.
	const tabs = [
		{ href: '/kanban', label: 'Board' },
		{ href: '/kanban/inventory', label: 'Tier 1' },
		{ href: '/kanban/roadmap', label: 'Roadmap' },
		{ href: '/spu/cleaning', label: 'Cleaning', requires: 'cleaning' },
		{ href: '/kanban/plans', label: 'Plans' },
		{ href: '/kanban/flow', label: 'Flow' },
		{ href: '/kanban/policy', label: 'Policy' },
		{ href: '/kanban/archived', label: 'Archive' }
	];

	const visibleTabs = $derived(
		tabs.filter((t) => t.requires !== 'cleaning' || $page.data.canAccessCleaning !== false)
	);

	function isActive(href: string, path: string): boolean {
		if (href === '/kanban') return path === '/kanban';
		return path === href || path.startsWith(`${href}/`);
	}
</script>

<div class="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-tron-border)] pb-3">
	<nav class="flex flex-wrap items-center gap-1" aria-label="Kanban views">
		{#each visibleTabs as tab (tab.href)}
			{@const active = isActive(tab.href, $page.url.pathname)}
			<a
				href={tab.href}
				class="rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200
					{active
					? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
					: 'text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-bg-tertiary)] hover:text-[var(--color-tron-cyan)]'}"
			>
				{tab.label}
			</a>
		{/each}
	</nav>
</div>
