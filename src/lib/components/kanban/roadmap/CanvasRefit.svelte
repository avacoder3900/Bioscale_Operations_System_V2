<script lang="ts">
	/**
	 * KB2-30/35 fix — position the viewport whenever `signal` (layout mode /
	 * fullscreen) changes. Must be a CHILD of <SvelteFlow>.
	 *
	 * Not a plain fitView: with the whole board on the canvas (KB2-34) a fit
	 * squeezes months into sub-pixel soup, and a zoom-clamped fit centers on
	 * the empty middle of the bounds. Instead: readable fixed zoom, anchored
	 * at the TOP-LEFT of the content — "now", where the action is — and the
	 * user pans right into the future.
	 */
	import { useSvelteFlow, useNodes, getNodesBounds } from '@xyflow/svelte';

	let { signal }: { signal: string } = $props();
	const { setViewport } = useSvelteFlow();
	const nodes = useNodes();

	$effect(() => {
		void signal;
		const t = setTimeout(() => {
			const current = nodes.current;
			if (!current.length) return;
			const b = getNodesBounds(current);
			const zoom = 0.6;
			// 210px clears the pinned lane rail; 60px clears the floating axis.
			void setViewport({ x: -b.x * zoom + 210, y: -b.y * zoom + 60, zoom }, { duration: 250 });
		}, 80);
		return () => clearTimeout(t);
	});
</script>
