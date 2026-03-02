<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';

	interface Props {
		children: Snippet;
		data: {
			permissions: {
				canReadInstructions: boolean;
				canWriteInstructions: boolean;
				canApproveInstructions: boolean;
				canReadDocuments: boolean;
				canWriteDocuments: boolean;
				canReadProductionRuns: boolean;
			};
		};
	}

	let { children, data }: Props = $props();

	const navItems = [
		{
			href: '/spu/documents/instructions',
			label: 'Work Instructions',
			icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
			permission: 'canReadInstructions'
		},
		{
			href: '/spu/documents/repository',
			label: 'Repository',
			icon: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4',
			permission: 'canReadDocuments'
		},
		{
			href: '/spu/documents/upload',
			label: 'Upload',
			icon: 'M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12',
			permission: 'canWriteDocuments'
		},
		{
			href: '/spu/documents/build-logs',
			label: 'Build Logs',
			icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
			permission: 'canReadProductionRuns'
		}
	];

	function isActive(href: string, currentPath: string): boolean {
		return currentPath.startsWith(href);
	}

	function getSectionName(path: string): string {
		if (path.includes('/instructions')) return 'Work Instructions';
		if (path.includes('/repository')) return 'Repository';
		if (path.includes('/upload')) return 'Upload';
		if (path.includes('/build-logs')) return 'Build Logs';
		return 'Documents';
	}

	let currentSection = $derived(getSectionName($page.url.pathname));
</script>

<div class="space-y-6">
	<!-- Breadcrumb -->
	<nav class="flex items-center gap-2 text-sm">
		<a
			href="/spu"
			class="text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
		>
			SPU
		</a>
		<span class="text-[var(--color-tron-text-secondary)]">/</span>
		<a
			href="/spu/documents"
			class="text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
		>
			Documents
		</a>
		{#if currentSection !== 'Documents'}
			<span class="text-[var(--color-tron-text-secondary)]">/</span>
			<span class="text-[var(--color-tron-cyan)]">{currentSection}</span>
		{/if}
	</nav>

	<!-- Sub-navigation -->
	<div
		class="flex gap-2 border-b border-[var(--color-tron-border)] pb-4"
	>
		{#each navItems as item}
			{@const hasPermission = data.permissions[item.permission as keyof typeof data.permissions]}
			{@const active = isActive(item.href, $page.url.pathname)}
			{#if hasPermission}
				<a
					href={item.href}
					class="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200
						{active
						? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
						: 'text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-bg-tertiary)] hover:text-[var(--color-tron-cyan)]'}"
				>
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d={item.icon}
						/>
					</svg>
					{item.label}
				</a>
			{/if}
		{/each}
	</div>

	<!-- Page content -->
	{@render children()}
</div>
