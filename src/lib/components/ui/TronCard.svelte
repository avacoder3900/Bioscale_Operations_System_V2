<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
		interactive?: boolean;
		class?: string;
	}

	let { children, interactive = false, class: className = '' }: Props = $props();

	let baseClass = $derived(interactive ? 'tron-card-interactive' : 'tron-card');
</script>

<div class="{baseClass} {className}">
	{@render children()}
</div>
