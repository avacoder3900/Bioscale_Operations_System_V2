<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();
</script>

<!-- Work Instructions live in the Documents section (the SPU assembly flow
     will render the parsed, followable version of the doc — the document
     itself is a Documents concern). -->
{@render children()}
