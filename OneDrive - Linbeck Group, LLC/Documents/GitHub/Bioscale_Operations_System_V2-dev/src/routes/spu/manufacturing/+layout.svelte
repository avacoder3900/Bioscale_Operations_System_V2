<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';

	interface Props {
		children: Snippet;
		data: { processConfigs: { configId: string; processName: string; processType: string }[]; isAdmin?: boolean };
	}

	let { children, data }: Props = $props();

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
			href: '/spu/manufacturing/wax-filling',
			label: 'Wax Fill',
			icon: 'M12 2a7 7 0 017 7c0 5-7 13-7 13S5 14 5 9a7 7 0 017-7zm0 4a3 3 0 100 6 3 3 0 000-6z'
		},
		{
			href: '/spu/manufacturing/reagent-filling',
			label: 'Reagent Fill',
			icon: 'M9 3h6v2l-1 1v4l4 8a2 2 0 01-2 3H8a2 2 0 01-2-3l4-8V6L9 5V3z'
		},
		{
			href: '/spu/manufacturing/top-seal-cutting',
			label: 'Top Seal',
			icon: 'M4 6h16M4 12h16M4 18h7'
		},
		{
			href: '/spu/manufacturing/cv-inspection',
			label: 'CV Inspection',
			icon: 'M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z'
		},
		{
			href: '/spu/manufacturing/qa-qc',
			label: 'QA/QC',
			icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z'
		},
		{
			href: '/spu/manufacturing/inventory',
			label: 'Equipment',
			icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01'
		},
		{
			href: '/spu/manufacturing/opentrons',
			label: 'Robots',
			icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z'
		}
	];

	function isActive(href: string, currentPath: string, exact = false): boolean {
		if (exact) return currentPath === href;
		return currentPath.startsWith(href);
	}
</script>

<div class="space-y-6">
	<nav class="flex items-center gap-2 text-sm">
		<a
			href="/spu"
			class="text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
		>
			SPU
		</a>
		<span class="text-[var(--color-tron-text-secondary)]">/</span>
		<span class="text-[var(--color-tron-text)]">Manufacturing</span>
	</nav>

	<div class="flex gap-4 border-b border-[var(--color-tron-border)]">
		{#each navItems as item}
			<a
				href={item.href}
				class="flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors {isActive(
					item.href,
					$page.url.pathname,
					item.exact
				)
					? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
					: 'border-transparent text-[var(--color-tron-text-secondary)]'}"
			>
				<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={item.icon} />
				</svg>
				{item.label}
			</a>
		{/each}
	</div>

	{#if data.isAdmin}
		{#if $page.url.pathname.startsWith('/spu/manufacturing/wi-01') || $page.url.pathname.startsWith('/spu/manufacturing/wi-02')}
			<div class="flex gap-3 text-xs">
				{#if $page.url.pathname.startsWith('/spu/manufacturing/wi-01')}
					<a
						href="/spu/manufacturing/wi-01/steps"
						class="rounded border px-2 py-1 transition-colors {$page.url.pathname === '/spu/manufacturing/wi-01/steps'
							? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
							: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]'}"
					>
						Edit Steps
					</a>
				{/if}
				{#if $page.url.pathname.startsWith('/spu/manufacturing/wi-02')}
					<a
						href="/spu/manufacturing/wi-02/steps"
						class="rounded border px-2 py-1 transition-colors {$page.url.pathname === '/spu/manufacturing/wi-02/steps'
							? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
							: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]'}"
					>
						Edit Steps
					</a>
				{/if}
			</div>
		{/if}
	{/if}

	{@render children()}
</div>
