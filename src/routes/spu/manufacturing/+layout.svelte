<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';

	interface Props {
		children: Snippet;
		data: { processConfigs: { configId: string; processName: string; processType: string }[]; isAdmin?: boolean };
	}

	let { children, data }: Props = $props();
	let sidebarOpen = $state(false);

	const navItems = [
		{
			href: '/spu/manufacturing',
			label: 'Dashboard',
			icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
			exact: true
		},
		{
			href: '/spu/manufacturing/wi-02',
			label: 'Cut Thermoseal',
			icon: 'M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.242 4.243 3 3 0 004.242-4.242zm0-5.758a3 3 0 10-4.242-4.243 3 3 0 004.242 4.243z'
		},
		{
			href: '/spu/manufacturing/laser-cutting',
			label: 'Laser Cut',
			icon: 'M13 10V3L4 14h7v7l9-11h-7z'
		},
		{
			href: '/spu/manufacturing/wi-01',
			label: 'Cartridge Back',
			icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10'
		},
		{
			href: '/spu/manufacturing/opentrons',
			label: 'Opentrons',
			icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z'
		},
		{
			href: '/spu/manufacturing/wi-03',
			label: 'Cut Top Seal',
			icon: 'M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.242 4.243 3 3 0 004.242-4.242zm0-5.758a3 3 0 10-4.242-4.243 3 3 0 004.242 4.243z'
		},
		{
			href: '/spu/manufacturing/top-seal-cutting',
			label: 'Top Seal Apply',
			icon: 'M4 6h16M4 12h16M4 18h7'
		},
		{
			href: '/spu/manufacturing/qa-qc',
			label: 'QA/QC',
			icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z'
		},
		{
			href: '/spu/manufacturing/consumables',
			label: 'Line Inventory',
			icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4'
		},
		{
			href: '/spu/equipment',
			label: 'Equipment',
			icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z'
		}
	];

	const opentronsPrefixes = [
		'/spu/manufacturing/opentrons',
		'/spu/manufacturing/wax-filling',
		'/spu/manufacturing/reagent-filling'
	];

	function isActive(href: string, currentPath: string, exact = false): boolean {
		if (exact) return currentPath === href;
		if (href === '/spu/manufacturing/opentrons') {
			return opentronsPrefixes.some((p) => currentPath.startsWith(p));
		}
		return currentPath.startsWith(href);
	}

	// Find the currently active nav label for the header
	const activeLabel = $derived(
		navItems.find((item) => isActive(item.href, $page.url.pathname, item.exact))?.label ?? 'Manufacturing'
	);
</script>

<!-- Mobile/tablet overlay backdrop -->
{#if sidebarOpen}
	<button
		type="button"
		class="fixed inset-0 z-30 bg-black/50 lg:hidden"
		onclick={() => { sidebarOpen = false; }}
		aria-label="Close menu"
	></button>
{/if}

<div class="flex min-h-[calc(100vh-4rem)]">
	<!-- Sidebar -->
	<aside
		class="fixed left-0 top-0 z-40 h-full border-r border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] pt-4 transition-all duration-200 ease-in-out
			{sidebarOpen ? 'w-48 translate-x-0' : 'w-0 -translate-x-full'}"
	>
		<div class="flex h-full w-48 flex-col overflow-hidden">
			<!-- Close button -->
			<div class="flex items-center justify-between px-3 pb-3">
				<span class="text-xs font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Menu</span>
				<button
					type="button"
					onclick={() => { sidebarOpen = false; }}
					class="rounded p-1.5 text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-surface)] hover:text-[var(--color-tron-cyan)]"
					aria-label="Close menu"
				>
					<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>

			<!-- Nav items -->
			<nav class="flex-1 space-y-0.5 overflow-y-auto px-2">
				{#each navItems as item}
					{@const active = isActive(item.href, $page.url.pathname, item.exact)}
					<a
						href={item.href}
						onclick={() => { sidebarOpen = false; }}
						class="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-all
							{active
								? 'bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]'
								: 'text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-surface)] hover:text-[var(--color-tron-text)]'}"
					>
						<svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={item.icon} />
						</svg>
						<span class="truncate text-xs">{item.label}</span>
					</a>
				{/each}
			</nav>

			<!-- Admin links at bottom -->
			{#if data.isAdmin}
				{#if $page.url.pathname.startsWith('/spu/manufacturing/wi-01') || $page.url.pathname.startsWith('/spu/manufacturing/wi-02')}
					<div class="border-t border-[var(--color-tron-border)] p-3">
						<p class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Admin</p>
						{#if $page.url.pathname.startsWith('/spu/manufacturing/wi-01')}
							<a
								href="/spu/manufacturing/wi-01/steps"
								onclick={() => { sidebarOpen = false; }}
								class="block rounded px-2 py-1.5 text-xs transition-colors {$page.url.pathname === '/spu/manufacturing/wi-01/steps'
									? 'text-[var(--color-tron-cyan)]'
									: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]'}"
							>
								Edit WI-01 Steps
							</a>
						{/if}
						{#if $page.url.pathname.startsWith('/spu/manufacturing/wi-02')}
							<a
								href="/spu/manufacturing/wi-02/steps"
								onclick={() => { sidebarOpen = false; }}
								class="block rounded px-2 py-1.5 text-xs transition-colors {$page.url.pathname === '/spu/manufacturing/wi-02/steps'
									? 'text-[var(--color-tron-cyan)]'
									: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]'}"
							>
								Edit WI-02 Steps
							</a>
						{/if}
					</div>
				{/if}
			{/if}
		</div>
	</aside>

	<!-- Main content -->
	<main class="min-w-0 flex-1 p-4 lg:p-6">
		<!-- Header with breadcrumb + hamburger -->
		<div class="mb-6 flex items-center gap-3">
			<button
				type="button"
				onclick={() => { sidebarOpen = !sidebarOpen; }}
				class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-2 text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
				aria-label="Toggle menu"
			>
				<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
				</svg>
			</button>
			<nav class="flex items-center gap-2 text-sm">
				<a
					href="/spu"
					class="text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
				>
					SPU
				</a>
				<span class="text-[var(--color-tron-text-secondary)]">/</span>
				<a
					href="/spu/manufacturing"
					class="text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
				>
					Manufacturing
				</a>
				<span class="text-[var(--color-tron-text-secondary)]">/</span>
				<span class="text-[var(--color-tron-text)]">{activeLabel}</span>
			</nav>
		</div>

		{@render children()}
	</main>
</div>
