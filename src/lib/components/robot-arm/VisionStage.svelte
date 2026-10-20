<script lang="ts" module>
	export type StageStatus = 'ok' | 'moved' | 'missing' | 'registered' | 'unregistered' | 'calibrated';

	export interface StageTag {
		key: string;
		label: string;
		/** Where the tag is now (normalised, TL TR BR BL); null = not seen. */
		corners: [number, number][] | null;
		center: [number, number] | null;
		/** Calibrated outline, drawn dashed with a line to the current centre. */
		refCorners?: [number, number][] | null;
		refCenter?: [number, number] | null;
		status: StageStatus;
	}
</script>

<script lang="ts">
	/**
	 * ARM-05 — a camera frame with AprilTag outlines drawn over it.
	 *
	 * Used for the live view, the calibration preview, and the before/after
	 * pictures of a home check. Coordinates are normalised (0..1), so the
	 * overlay is right at whatever size the page lays the image out.
	 */
	interface Props {
		src: string | null;
		width: number;
		height: number;
		tags: StageTag[];
		alt?: string;
		emptyText?: string;
	}

	import RotatedFrame from './RotatedFrame.svelte';
	import { cameraRotation } from '$lib/robot-arm/camera-rotation.svelte';

	let { src, width, height, tags, alt = 'Camera frame', emptyText = 'No frame' }: Props = $props();

	const w = $derived(width || 640);
	const h = $derived(height || 480);
	const s = $derived(Math.max(1.5, w * 0.004));

	const STATUS_COLOR: Record<StageStatus, string> = {
		ok: '#4ade80',
		moved: '#f59e0b',
		missing: '#ef4444',
		registered: '#38bdf8',
		unregistered: '#f59e0b',
		calibrated: '#e5e7eb'
	};

	const pts = (c: [number, number][]) => c.map(([x, y]) => `${x * w},${y * h}`).join(' ');

	// The operator's view rotation (camera mounted on its side). The image and
	// the outlines turn together inside RotatedFrame; each label is turned back
	// about its tag centre so it reads upright and sits above the tag on screen.
	const rot = $derived(cameraRotation.deg);
	$effect(() => cameraRotation.restore());
</script>

<RotatedFrame width={w} height={h} rotation={rot} class="rounded border bg-black" style="border-color: var(--color-tron-border);">
	{#if src}
		<img {src} {alt} class="absolute inset-0 h-full w-full select-none object-fill" draggable="false" />
	{:else}
		<div class="absolute inset-0 flex items-center justify-center text-xs" style="color: var(--color-tron-text-secondary)">{emptyText}</div>
	{/if}
	<svg viewBox="0 0 {w} {h}" preserveAspectRatio="none" class="pointer-events-none absolute inset-0 h-full w-full">
		{#each tags as t (t.key)}
			{@const sc = STATUS_COLOR[t.status]}
			{#if t.refCorners?.length === 4}
				<polygon points={pts(t.refCorners)} fill="none" stroke={sc} stroke-width={s} stroke-dasharray="{s * 3} {s * 2}" opacity="0.75" />
			{/if}
			{#if t.refCenter && t.center && t.status === 'moved'}
				<line x1={t.refCenter[0] * w} y1={t.refCenter[1] * h} x2={t.center[0] * w} y2={t.center[1] * h} stroke={sc} stroke-width={s} />
			{/if}
			{#if t.corners?.length === 4}
				<polygon points={pts(t.corners)} fill="{sc}22" stroke={sc} stroke-width={s * 1.4} />
				<!-- the tag's printed top edge, so a flipped/turned tag is visible -->
				<line x1={t.corners[0][0] * w} y1={t.corners[0][1] * h} x2={t.corners[1][0] * w} y2={t.corners[1][1] * h} stroke="#fff" stroke-width={s * 1.4} />
			{/if}
			{@const at = t.center ?? t.refCenter}
			{#if at}
				<text
					x={at[0] * w}
					y={at[1] * h - s * 8}
					transform="rotate({-rot} {at[0] * w} {at[1] * h})"
					text-anchor="middle"
					font-size={s * 7}
					fill={t.center ? '#fff' : sc}
					stroke="#000"
					stroke-width={s * 1.2}
					paint-order="stroke"
					style="font-family: ui-sans-serif, system-ui;">{t.label}{t.center ? '' : ' — not found'}</text
				>
			{/if}
		{/each}
	</svg>
</RotatedFrame>
