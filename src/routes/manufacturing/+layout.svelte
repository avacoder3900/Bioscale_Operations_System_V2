<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';

	interface Props {
		children: Snippet;
		data: { processConfigs: { configId: string; processName: string; processType: string }[]; isAdmin?: boolean };
	}

	let { children, data }: Props = $props();

	const navItems = [
		{ href: '/manufacturing', label: 'Dashboard', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6', exact: true },
		{ href: '/manufacturing/cut-thermoseal', label: 'Cut Thermoseal', icon: 'M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.242 4.243 3 3 0 004.242-4.242zm0-5.758a3 3 0 10-4.242-4.243 3 3 0 004.242 4.243z' },
		{ href: '/manufacturing/laser-cutting', label: 'Laser Cut', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
		{ href: '/manufacturing/wi-01', label: 'Cartridge Back', icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10' },
		{ href: '/manufacturing/wax-creation', label: 'Wax Creation', icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM12 7v5m-2.5-2.5h5' },
		{ href: '/manufacturing/opentron-control', label: 'Opentron Control', icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z' },
		{ href: '/manufacturing/qa-qc', label: 'QA/QC', icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z' },
		{ href: '/manufacturing/top-seal-cutting', label: 'Cut Top Seal', icon: 'M4 6h16M4 12h16M4 18h7' },
		{ href: '/equipment/activity', label: 'Equipment', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z' },
		{ href: '/manufacturing/opentrons', label: 'Robots', icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z' },
		{ href: '/manufacturing/scrap', label: 'Checkout', icon: 'M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1' },
		{ href: '/manufacturing/analysis', label: 'Analysis', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' }
	];

	function isActive(href: string, currentPath: string, exact = false): boolean {
		if (exact) return currentPath === href;
		return currentPath.startsWith(href);
	}
</script>

<style>
	.mfg-sidebar {
		width: 30px;
		transition: width 0.15s ease;
	}
	.mfg-sidebar:hover {
		width: 180px;
	}
	.mfg-sidebar .nav-label {
		opacity: 0;
		white-space: nowrap;
		transition: opacity 0.1s ease;
	}
	.mfg-sidebar:hover .nav-label {
		opacity: 1;
	}
</style>

<div class="flex">
	<!-- Sidebar: icons only, expand on hover -->
	<aside class="mfg-sidebar sticky top-14 h-[calc(100vh-3.5rem)] shrink-0 overflow-hidden border-r border-[var(--color-tron-border)] bg-[var(--color-tron-bg)]">
		<nav class="flex flex-col gap-0.5 px-0.5 pt-2">
			{#each navItems as item}
				{@const active = isActive(item.href, $page.url.pathname, item.exact)}
				<a
					href={item.href}
					class="flex items-center gap-2 rounded-md px-1.5 py-1.5 transition-colors
						{active
							? 'bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]'
							: 'text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-surface)] hover:text-[var(--color-tron-text)]'}"
					title={item.label}
				>
					<svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={item.icon} />
					</svg>
					<span class="nav-label text-xs font-medium">{item.label}</span>
				</a>
			{/each}
		</nav>

		{#if data.isAdmin}
			{#if $page.url.pathname.startsWith('/manufacturing/wi-01') || $page.url.pathname.startsWith('/manufacturing/wi-02')}
				<div class="border-t border-[var(--color-tron-border)] p-2 mt-2">
					{#if $page.url.pathname.startsWith('/manufacturing/wi-01')}
						<a href="/manufacturing/wi-01/steps"
							class="nav-label block rounded px-2.5 py-1.5 text-xs transition-colors {$page.url.pathname === '/manufacturing/wi-01/steps'
								? 'text-[var(--color-tron-cyan)]'
								: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]'}">
							Edit Steps
						</a>
					{/if}
					{#if $page.url.pathname.startsWith('/manufacturing/wi-02')}
						<a href="/manufacturing/wi-02/steps"
							class="nav-label block rounded px-2.5 py-1.5 text-xs transition-colors {$page.url.pathname === '/manufacturing/wi-02/steps'
								? 'text-[var(--color-tron-cyan)]'
								: 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]'}">
							Edit Steps
						</a>
					{/if}
				</div>
			{/if}
		{/if}
	</aside>

	<!-- Main content -->
	<div class="min-w-0 flex-1 p-4 lg:p-6">
		{@render children()}
	</div>
</div>
