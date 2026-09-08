<script lang="ts">
	import { page } from '$app/stores';

	interface Props {
		/** Hide the breadcrumb row when a parent layout already renders one. */
		showBreadcrumb?: boolean;
	}

	let { showBreadcrumb = true }: Props = $props();

	// The SPU manufacturing section spans several route trees that each keep
	// their own URLs. This strip is rendered by every one of their layouts so
	// the tabs stay put as you move between them.
	// `exact` opts an entry out of prefix matching, so a parent route does not
	// stay lit while you are on one of its subroutes.
	const navItems: { href: string; label: string; icon: string; exact?: boolean }[] = [
		{
			href: '/assembly',
			label: 'SPU Assembly',
			icon: 'M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z'
		},
		{
			href: '/spu/mfg/barcodes',
			label: 'Barcodes',
			icon: 'M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z'
		},
	];

	function isActive(item: { href: string; exact?: boolean }, currentPath: string): boolean {
		return item.exact
			? currentPath === item.href
			: currentPath === item.href || currentPath.startsWith(item.href + '/');
	}

	let currentLabel = $derived(
		navItems.find((i) => isActive(i, $page.url.pathname))?.label ?? null
	);
</script>

{#if showBreadcrumb}
	<nav class="flex items-center gap-2 text-sm">
		<a
			href="/spu"
			class="text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
		>
			SPU
		</a>
		<span class="text-[var(--color-tron-text-secondary)]">/</span>
		<a
			href="/spu/mfg"
			class="text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
		>
			SPU Manufacturing
		</a>
		{#if currentLabel}
			<span class="text-[var(--color-tron-text-secondary)]">/</span>
			<span class="text-[var(--color-tron-cyan)]">{currentLabel}</span>
		{/if}
	</nav>
{/if}

<div class="flex flex-wrap gap-2 border-b border-[var(--color-tron-border)]">
	{#each navItems as item (item.href)}
		{@const active = isActive(item, $page.url.pathname)}
		<a
			href={item.href}
			class="flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors {active
				? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
				: 'border-transparent text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]'}"
		>
			<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={item.icon} />
			</svg>
			{item.label}
		</a>
	{/each}
</div>
