<script lang="ts">
	/**
	 * KB2-35 — reports the live viewport (x/y/zoom) up to RoadmapCanvas so the
	 * screen-space floating axis + lane labels can track pan/zoom. Must be a
	 * child of <SvelteFlow> (useViewport needs its context).
	 */
	import { useViewport } from '@xyflow/svelte';

	let { onviewport }: { onviewport: (vp: { x: number; y: number; zoom: number }) => void } = $props();
	const viewport = useViewport();

	$effect(() => {
		const v = viewport.current;
		onviewport({ x: v.x, y: v.y, zoom: v.zoom });
	});
</script>
