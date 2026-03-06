<script lang="ts">
	import { page } from '$app/state';
	
	const tabs = [
		{ href: '/spu/parts', label: 'Parts' },
		{ href: '/spu/receiving', label: 'Receiving' },
		{ href: '/spu/manufacturing/consumables', label: 'Consumables' },
		{ href: '/spu/bom/settings/mapping', label: 'BOM Mapping' },
		{ href: '/spu/cartridge-admin', label: 'Cartridge Admin' }
	];
</script>

<div class="flex items-center gap-2 border-b border-[var(--color-tron-border)] pb-0">
	{#each tabs as tab}
		<a
			href={tab.href}
			class="px-3 py-2 text-sm font-medium transition-colors {page.url.pathname.startsWith(tab.href) ? 'border-b-2 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)] font-semibold' : 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
		>
			{tab.label}
		</a>
	{/each}
</div>
