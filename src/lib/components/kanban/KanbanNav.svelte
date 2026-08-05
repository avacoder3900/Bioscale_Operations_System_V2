<script lang="ts">
	import { page } from '$app/stores';
	import type { KanbanBoard } from '$lib/shared/kanban-status';

	// Primary two-tier views (KB2-06; KB2-14 folded Replenish into Inventory).
	// Every link preserves the ?board= param.
	const tabs = [
		{ href: '/kanban', label: 'Queue' },
		{ href: '/kanban/inventory', label: 'Inventory' },
		{ href: '/kanban/flow', label: 'Flow' },
		{ href: '/kanban/policy', label: 'Policy' }
	];

	let board = $derived<KanbanBoard>(
		$page.url.searchParams.get('board') === 'software' ? 'software' : 'ops'
	);

	function tabHref(href: string): string {
		return board === 'software' ? `${href}?board=software` : href;
	}

	// Board switcher keeps the current view, swaps the board.
	function boardHref(b: KanbanBoard): string {
		const params = new URLSearchParams($page.url.search);
		if (b === 'software') params.set('board', 'software');
		else params.delete('board');
		const qs = params.toString();
		return `${$page.url.pathname}${qs ? `?${qs}` : ''}`;
	}

	function isActive(href: string, path: string): boolean {
		if (href === '/kanban') return path === '/kanban';
		return path === href || path.startsWith(`${href}/`);
	}

	const boardOptions: KanbanBoard[] = ['ops', 'software'];
</script>

<div class="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-tron-border)] pb-3">
	<nav class="flex flex-wrap items-center gap-1" aria-label="Kanban views">
		{#each tabs as tab (tab.href)}
			{@const active = isActive(tab.href, $page.url.pathname)}
			<a
				href={tabHref(tab.href)}
				class="rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200
					{active
					? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
					: 'text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-bg-tertiary)] hover:text-[var(--color-tron-cyan)]'}"
			>
				{tab.label}
			</a>
		{/each}
	</nav>

	<!-- Board switcher: ops | software -->
	<div
		class="flex items-center overflow-hidden rounded-lg border border-[var(--color-tron-border)]"
		role="group"
		aria-label="Board"
	>
		{#each boardOptions as b (b)}
			<a
				href={boardHref(b)}
				class="px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition-colors
					{board === b
					? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
					: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]'}"
			>
				{b}
			</a>
		{/each}
	</div>
</div>
