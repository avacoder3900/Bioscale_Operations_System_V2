<script lang="ts">
	import type { Snippet } from 'svelte';

	// Pass-through layout. The root layout (src/routes/+layout.svelte) already
	// provides the app shell (GridBackground + header + nav). Rendering a second
	// shell here made the header/nav appear twice on every /spu page.
	let { children }: { children: Snippet } = $props();
</script>

{@render children()}
