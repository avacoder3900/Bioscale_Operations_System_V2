<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
		class?: string;
	}

	let { children, class: className = '' }: Props = $props();
</script>

<div class="tron-grid-bg relative min-h-screen {className}">
	<div class="tron-scanlines absolute inset-0"></div>
	<div class="relative z-10">
		{@render children()}
	</div>
</div>
