<script lang="ts">
	interface Props {
		points: number[];
		width?: number;
		height?: number;
	}
	let { points, width = 160, height = 36 }: Props = $props();
	const path = $derived.by(() => {
		if (!points.length) return '';
		const lo = Math.min(...points),
			hi = Math.max(...points);
		const n = points.length;
		return points
			.map((v, i) => {
				const x = n === 1 ? width / 2 : (i / (n - 1)) * (width - 4) + 2;
				const y = hi === lo ? height / 2 : height - 3 - ((v - lo) / (hi - lo)) * (height - 6);
				return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
			})
			.join(' ');
	});
	const last = $derived.by(() => {
		if (!points.length) return null;
		const lo = Math.min(...points),
			hi = Math.max(...points);
		const n = points.length;
		const v = points[n - 1];
		return { x: n === 1 ? width / 2 : width - 2, y: hi === lo ? height / 2 : height - 3 - ((v - lo) / (hi - lo)) * (height - 6) };
	});
</script>

<svg viewBox="0 0 {width} {height}" class="h-9 w-full" role="img" aria-label="trend">
	<path d={path} fill="none" stroke="var(--color-tron-cyan)" stroke-width="1.5" />
	{#if last}<circle cx={last.x} cy={last.y} r="2.5" fill="var(--color-tron-cyan)" />{/if}
</svg>
