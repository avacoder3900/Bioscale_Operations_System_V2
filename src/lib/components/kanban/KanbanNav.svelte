<script lang="ts">
	import { page } from '$app/stores';

	// The single kanban nav (KB2-06; KB2-14 folded Replenish into Inventory;
	// KB2-15 folded Analytics into Flow and absorbed the old header nav;
	// KB2-16 removed Projects and the ops/software board switcher — one board,
	// tags carry the grouping).
	// KB2-16 decision #11: the pages are named for what they are — Tier 2 (the
	// committed queue) and Tier 1 (the unbounded option inventory). Routes stay.
	const tabs = [
		{ href: '/kanban', label: 'Tier 2' },
		{ href: '/kanban/inventory', label: 'Tier 1' },
		{ href: '/kanban/flow', label: 'Flow' },
		{ href: '/kanban/policy', label: 'Policy' },
		{ href: '/kanban/archived', label: 'Archive' }
	];

	function isActive(href: string, path: string): boolean {
		if (href === '/kanban') return path === '/kanban';
		return path === href || path.startsWith(`${href}/`);
	}
</script>

<div class="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-tron-border)] pb-3">
	<nav class="flex flex-wrap items-center gap-1" aria-label="Kanban views">
		{#each tabs as tab (tab.href)}
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
