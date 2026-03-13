<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
		variant?: 'info' | 'success' | 'warning' | 'error' | 'neutral';
		class?: string;
	}

	let { children, variant = 'info', class: className = '' }: Props = $props();

	let badgeClass = $derived(`tron-badge tron-badge-${variant}`);
</script>

<span class="{badgeClass} {className}">
	{@render children()}
</span>
