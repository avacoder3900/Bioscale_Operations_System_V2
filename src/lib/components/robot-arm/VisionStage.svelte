<script lang="ts" module>
	export type StageStatus = 'ok' | 'moved' | 'depth_off' | 'missing' | 'placed' | 'selected';

	export interface StageMarker {
		id: string;
		label: string;
		/** Sticker colour, CSS. */
		color: string;
		/** Where the marker is now (normalised); null = not found. */
		x: number | null;
		y: number | null;
		/** Calibrated spot (normalised), drawn as a dashed ring with a line to the current spot. */
		refX?: number | null;
		refY?: number | null;
		status: StageStatus;
	}
</script>

<script lang="ts">
	/**
	 * ARM-04 — a camera frame with sticker markers drawn over it.
	 *
	 * One component for all three uses on the Vision tab: placing markers on a
	 * frozen frame (draggable), the live tracking overlay, and the before/after
	 * pictures of a home check. Coordinates in and out are normalised (0..1),
	 * so the overlay is right at whatever size the page lays the image out.
	 */
	interface Props {
		src: string | null;
		width: number;
		height: number;
		markers: StageMarker[];
		/** Markers can be dragged; clicks on the frame are reported. */
		editable?: boolean;
		/** Crosshair cursor — something is waiting to be placed. */
		placing?: boolean;
		alt?: string;
		emptyText?: string;
		onmove?: (id: string, x: number, y: number) => void;
		ondrop?: (id: string, x: number, y: number) => void;
		onframeclick?: (x: number, y: number) => void;
		onselect?: (id: string) => void;
	}

	let {
		src,
		width,
		height,
		markers,
		editable = false,
		placing = false,
		alt = 'Camera frame',
		emptyText = 'No frame',
		onmove,
		ondrop,
		onframeclick,
		onselect
	}: Props = $props();

	let svgEl = $state<SVGSVGElement | null>(null);
	let dragging = $state<string | null>(null);
	let moved = false;

	const w = $derived(width || 640);
	const h = $derived(height || 480);
	// Marker size tracks the frame, not the screen: a 640 px frame gets ~8 px rings.
	const r = $derived(Math.max(4, w * 0.012));

	const STATUS_COLOR: Record<StageStatus, string> = {
		ok: '#4ade80',
		moved: '#f59e0b',
		depth_off: '#f97316',
		missing: '#ef4444',
		placed: '#e5e7eb',
		selected: '#38bdf8'
	};

	function norm(e: PointerEvent | MouseEvent): { x: number; y: number } | null {
		if (!svgEl) return null;
		const rect = svgEl.getBoundingClientRect();
		if (!rect.width || !rect.height) return null;
		return {
			x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
			y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
		};
	}

	function down(e: PointerEvent, id: string) {
		if (!editable) return;
		e.stopPropagation();
		e.preventDefault();
		(e.currentTarget as Element).setPointerCapture?.(e.pointerId);
		dragging = id;
		moved = false;
		onselect?.(id);
	}

	function move(e: PointerEvent) {
		if (!dragging) return;
		const p = norm(e);
		if (!p) return;
		moved = true;
		onmove?.(dragging, p.x, p.y);
	}

	function up(e: PointerEvent) {
		if (!dragging) return;
		const id = dragging;
		dragging = null;
		const p = norm(e);
		if (p && moved) ondrop?.(id, p.x, p.y);
	}

	function frameClick(e: MouseEvent) {
		if (!editable || dragging) return;
		// A click that ends a drag or lands on a marker is not a click on the frame.
		if ((e.target as Element | null)?.closest('g')) return;
		const p = norm(e);
		if (p) onframeclick?.(p.x, p.y);
	}
</script>

<div class="relative w-full overflow-hidden rounded border bg-black" style="border-color: var(--color-tron-border); aspect-ratio: {w} / {h};">
	{#if src}
		<img {src} {alt} class="absolute inset-0 h-full w-full select-none object-fill" draggable="false" />
	{:else}
		<div class="absolute inset-0 flex items-center justify-center text-xs" style="color: var(--color-tron-text-secondary)">{emptyText}</div>
	{/if}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<svg
		bind:this={svgEl}
		viewBox="0 0 {w} {h}"
		preserveAspectRatio="none"
		class="absolute inset-0 h-full w-full"
		style="touch-action: {editable ? 'none' : 'auto'}; cursor: {placing ? 'crosshair' : 'default'};"
		onclick={frameClick}
		onpointermove={move}
		onpointerup={up}
		onpointercancel={up}
	>
		{#each markers as m (m.id)}
			{@const sc = STATUS_COLOR[m.status]}
			{#if m.refX != null && m.refY != null}
				<circle cx={m.refX * w} cy={m.refY * h} r={r * 1.4} fill="none" stroke={sc} stroke-width={r * 0.25} stroke-dasharray="{r * 0.6} {r * 0.4}" opacity="0.8" />
				{#if m.x != null && m.y != null && (m.status === 'moved' || m.status === 'depth_off')}
					<line x1={m.refX * w} y1={m.refY * h} x2={m.x * w} y2={m.y * h} stroke={sc} stroke-width={r * 0.25} opacity="0.9" />
				{/if}
			{/if}
			{#if m.x != null && m.y != null}
				<g
					transform="translate({m.x * w} {m.y * h})"
					style="cursor: {editable ? (dragging === m.id ? 'grabbing' : 'grab') : 'default'};"
					onpointerdown={(e) => down(e, m.id)}
				>
					<!-- generous invisible hit area for fingers -->
					<circle r={r * 2.6} fill="transparent" />
					<circle r={r} fill={m.color} stroke={sc} stroke-width={r * 0.35} />
					<line x1={-r * 1.8} x2={-r * 1.15} y1="0" y2="0" stroke={sc} stroke-width={r * 0.2} />
					<line x1={r * 1.15} x2={r * 1.8} y1="0" y2="0" stroke={sc} stroke-width={r * 0.2} />
					<line y1={-r * 1.8} y2={-r * 1.15} x1="0" x2="0" stroke={sc} stroke-width={r * 0.2} />
					<line y1={r * 1.15} y2={r * 1.8} x1="0" x2="0" stroke={sc} stroke-width={r * 0.2} />
					<text
						x={r * 2}
						y={-r * 1.2}
						font-size={r * 2}
						fill="#fff"
						stroke="#000"
						stroke-width={r * 0.35}
						paint-order="stroke"
						style="pointer-events: none; font-family: ui-sans-serif, system-ui;">{m.label}</text
					>
				</g>
			{:else if m.refX != null && m.refY != null}
				<text
					x={m.refX * w + r * 2}
					y={m.refY * h - r * 1.2}
					font-size={r * 2}
					fill={sc}
					stroke="#000"
					stroke-width={r * 0.35}
					paint-order="stroke"
					style="pointer-events: none; font-family: ui-sans-serif, system-ui;">{m.label} — not found</text
				>
			{/if}
		{/each}
	</svg>
</div>
