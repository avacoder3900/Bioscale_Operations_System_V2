<script lang="ts">
	/**
	 * KB2-30 fix — refit the viewport whenever `signal` (the layout mode)
	 * changes. Must be a CHILD of <SvelteFlow> (the hook needs its context).
	 * Without this, a mode switch left the viewport fitted to the previous
	 * layout's coordinates — the new layout rendered off-screen and the canvas
	 * looked empty (nodes only visible in the minimap).
	 */
	import { useSvelteFlow } from '@xyflow/svelte';

	let { signal }: { signal: string } = $props();
	const { fitView } = useSvelteFlow();

	$effect(() => {
		void signal;
		// Small delay: the parent's $effect swaps the node arrays after render;
		// fit once the new positions are in.
		const t = setTimeout(() => void fitView({ padding: 0.12, duration: 250 }), 80);
		return () => clearTimeout(t);
	});
</script>
