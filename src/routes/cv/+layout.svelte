<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/stores';

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
			href="/"
			class="text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
		>
			BIMS
		</a>
		<span class="text-[var(--color-tron-text-secondary)]">/</span>
		<span class="text-[var(--color-tron-text)]">Computer Vision</span>
	</nav>

	<div class="flex gap-1 overflow-x-auto border-b border-[var(--color-tron-border)]">
		<a href="/cv" class={tabClass('/cv', true)}>CV Dashboard</a>
		<a href="/cv/history" class={tabClass('/cv/history')}>History</a>
		<a href="/cv/failures" class={tabClass('/cv/failures')}>Common Failures</a>
	</div>

	{@render children()}
</div>
