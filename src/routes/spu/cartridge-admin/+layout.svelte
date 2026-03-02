<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';
	import { resolve } from '$app/paths';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();

	function isActive(path: string, currentPath: string, exact = false): boolean {
		if (exact) return currentPath === path;
		return currentPath.startsWith(path);
	}

	let tabClass = $derived.by(
		() =>
			(path: string, exact = false) =>
				`min-h-[44px] border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
					isActive(path, $page.url.pathname, exact)
						? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
						: 'border-transparent text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'
				}`
	);
</script>

<div class="space-y-4">
	<nav class="flex items-center gap-2 text-sm">
		<a
			href={resolve('/spu')}
			class="text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
		>
			SPU
		</a>
		<span class="text-[var(--color-tron-text-secondary)]">/</span>
		<span class="text-[var(--color-tron-text)]">Cartridge Admin</span>
	</nav>

	<div class="flex gap-1 overflow-x-auto border-b border-[var(--color-tron-border)]">
		<a href={resolve('/spu/cartridge-admin')} class={tabClass('/spu/cartridge-admin', true)}>
			In Process
		</a>
		<a href={resolve('/spu/cartridge-admin/filled')} class={tabClass('/spu/cartridge-admin/filled')}>
			Filled Database
		</a>
		<a href={resolve('/spu/cartridge-admin/failures')} class={tabClass('/spu/cartridge-admin/failures')}>
			Failures
		</a>
		<a href={resolve('/spu/cartridge-admin/storage')} class={tabClass('/spu/cartridge-admin/storage')}>
			Storage
		</a>
		<a href={resolve('/spu/cartridge-admin/release')} class={tabClass('/spu/cartridge-admin/release')}>
			QA/QC Release
		</a>
		<a href={resolve('/spu/cartridge-admin/statistics')} class={tabClass('/spu/cartridge-admin/statistics')}>
			Statistics
		</a>
		<a href={resolve('/spu/cartridge-admin/sku-management')} class={tabClass('/spu/cartridge-admin/sku-management')}>
			SKU Management
		</a>
	</div>

	{@render children()}
</div>
