<script lang="ts">
	/**
	 * ARM-06 — the rendered path as one lane per servo (encoder steps over
	 * time), with a tick where each pose is reached and the hold after it
	 * shaded. Optional playhead while the arm plays. Pure SVG, scales to width.
	 *
	 * Editable (the move-set editor): every pose has a dot on every lane —
	 * drag it up/down (or focus it and use the arrow keys) to move that joint
	 * at that pose; drag the ◆ above a pose sideways to change when the arm
	 * gets there, and the ▮ at the end of a hold to change how long it holds.
	 * The component only reports; the page owns the keyframes.
	 */
	import { ENCODER_MAX, type RenderedPath } from '$lib/robot-arm/animation';

	interface Props {
		path: RenderedPath | null;
		jointNames: string[];
		playheadS?: number | null;
		/** Marker index → highlight (the keyframe being edited). */
		selectedIndex?: number | null;
		onselect?: (index: number) => void;
		/** Turns on the drag handles below. */
		editable?: boolean;
		/** A joint dragged at a keyframe: servo is 1..6, value the new absolute position. */
		onjoint?: (index: number, servo: number, value: number) => void;
		/** The arrival ◆ of keyframe `index` dragged: the move into it now takes `durationS`. */
		onduration?: (index: number, durationS: number) => void;
		/** The end of keyframe `index`'s hold dragged. */
		onhold?: (index: number, holdS: number) => void;
	}

	let { path, jointNames, playheadS = null, selectedIndex = null, onselect, editable = false, onjoint, onduration, onhold }: Props = $props();

	const W = 1000;
	const LANE_H = $derived(editable ? 64 : 44);
	const LABEL_W = 90;
	const PAD = $derived(editable ? 8 : 4);
	/** Room above the lanes for the timing handles: ◆ arrivals, then ▮ hold ends. */
	const TOP = $derived(editable ? 28 : 0);

	type Drag =
		| { kind: 'joint'; index: number; servo: number; startY: number; startValue: number; stepsPerUnit: number }
		| { kind: 'duration' | 'hold'; index: number; origin: number };
	let drag = $state<Drag | null>(null);
	/** Axis ranges held still while dragging, so the curve does not rescale under the pointer. */
	let frozen = $state<{ ranges: { lo: number; hi: number }[]; total: number } | null>(null);
	let svgEl: SVGSVGElement | undefined = $state();

	const total = $derived(path ? Math.max(path.durationS, frozen?.total ?? 0, 0.001) : 1);
	const x = (s: number) => LABEL_W + (s / total) * (W - LABEL_W);

	const ranges = $derived.by(() => {
		if (!path) return [];
		return Array.from({ length: 6 }, (_, s) => {
			let lo = Infinity;
			let hi = -Infinity;
			for (const g of path.goal) {
				lo = Math.min(lo, g[s]);
				hi = Math.max(hi, g[s]);
			}
			if (!Number.isFinite(lo)) {
				lo = 0;
				hi = 1;
			}
			const f = frozen?.ranges[s];
			if (f) {
				lo = Math.min(lo, f.lo);
				hi = Math.max(hi, f.hi);
			} else if (hi - lo < 40) {
				const mid = (hi + lo) / 2;
				lo = mid - 20;
				hi = mid + 20;
			}
			return { lo, hi };
		});
	});

	const yOf = (s: number, v: number) => {
		const r = ranges[s];
		return TOP + s * LANE_H + PAD + ((r.hi - v) / (r.hi - r.lo)) * (LANE_H - 2 * PAD);
	};

	const lanes = $derived.by(() => {
		if (!path) return [];
		return ranges.map((r, s) => ({
			s,
			range: r.hi - r.lo,
			d: path.goal.map((g, i) => `${i ? 'L' : 'M'}${x(path.t[i]).toFixed(1)},${yOf(s, g[s]).toFixed(1)}`).join(' ')
		}));
	});

	const H = $derived(TOP + 6 * LANE_H);
	const editMarkers = $derived(path && editable ? path.markers.map((m, j) => ({ m, j })).filter(({ m }) => m.index >= 0) : []);

	/** viewBox units per screen pixel (the SVG scales uniformly with its width). */
	function unitsPerPx(): number {
		const rect = svgEl?.getBoundingClientRect();
		return rect && rect.width ? W / rect.width : 1;
	}
	function svgX(clientX: number): number {
		const rect = svgEl?.getBoundingClientRect();
		return rect ? (clientX - rect.left) * unitsPerPx() : 0;
	}

	function begin(e: PointerEvent, d: Drag) {
		if (!path) return;
		e.preventDefault();
		e.stopPropagation();
		frozen = { ranges: ranges.map((r) => ({ ...r })), total: path.durationS };
		drag = d;
		svgEl?.setPointerCapture(e.pointerId);
		onselect?.(d.index);
	}

	function startJoint(e: PointerEvent, index: number, servo: number, value: number) {
		const r = ranges[servo - 1];
		// preventDefault in begin() stops the click focusing the dot; focus it so ↑/↓ work next.
		(e.currentTarget as SVGElement | null)?.focus();
		begin(e,{ kind: 'joint', index, servo, startY: e.clientY, startValue: value, stepsPerUnit: (r.hi - r.lo) / (LANE_H - 2 * PAD) });
	}

	function move(e: PointerEvent) {
		if (!drag || !path) return;
		if (drag.kind === 'joint') {
			const dyUnits = (e.clientY - drag.startY) * unitsPerPx();
			// Shift = fine: a fifth of the speed.
			const v = drag.startValue - dyUnits * drag.stepsPerUnit * (e.shiftKey ? 0.2 : 1);
			onjoint?.(drag.index, drag.servo, Math.max(0, Math.min(ENCODER_MAX, Math.round(v))));
			return;
		}
		const t = ((svgX(e.clientX) - LABEL_W) / (W - LABEL_W)) * total;
		if (drag.kind === 'duration') onduration?.(drag.index, t - drag.origin);
		else onhold?.(drag.index, t - drag.origin);
	}

	function end() {
		drag = null;
		frozen = null;
	}

	function key(e: KeyboardEvent, index: number, servo: number, value: number) {
		const step = e.shiftKey ? 10 : 1;
		let v: number | null = null;
		if (e.key === 'ArrowUp') v = value + step;
		else if (e.key === 'ArrowDown') v = value - step;
		if (v == null) return;
		e.preventDefault();
		onselect?.(index);
		onjoint?.(index, servo, Math.max(0, Math.min(ENCODER_MAX, v)));
	}
</script>

<div class="overflow-x-auto rounded border bg-black/30" style="border-color: var(--color-tron-border)">
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<svg
		bind:this={svgEl}
		viewBox="0 0 {W} {H + 18}"
		class="block w-full select-none"
		style="min-width: 640px; font-family: ui-monospace, monospace"
		onpointermove={move}
		onpointerup={end}
		onpointercancel={end}
	>
		{#if path}
			{#each path.markers as m, i (i)}
				{#if m.holdS > 0}
					<rect x={x(m.t)} y={TOP} width={Math.max(1, x(m.t + m.holdS) - x(m.t))} height={H - TOP} fill={m.kind === 'fire' ? 'rgba(245,158,11,0.12)' : 'rgba(56,189,248,0.08)'} />
				{/if}
			{/each}
			{#each lanes as l (l.s)}
				<line x1={LABEL_W} x2={W} y1={TOP + (l.s + 1) * LANE_H} y2={TOP + (l.s + 1) * LANE_H} stroke="var(--color-tron-border)" stroke-width="0.5" />
				<text x="4" y={TOP + l.s * LANE_H + 14} font-size="10" fill="var(--color-tron-text-secondary)">{l.s + 1} {jointNames[l.s] ?? ''}</text>
				<text x="4" y={TOP + l.s * LANE_H + 27} font-size="8" fill="var(--color-tron-text-secondary)">Δ {Math.round(l.range)}</text>
				<path d={l.d} fill="none" stroke="#f59e0b" stroke-width="1.6" />
			{/each}
			{#each path.markers as m, i (i)}
				{@const sel = selectedIndex != null && m.index === selectedIndex}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<g style="cursor: {onselect && m.index >= 0 ? 'pointer' : 'default'}" onclick={() => m.index >= 0 && onselect?.(m.index)}>
					<!-- A fire step (cartridge trapdoor) is an amber line at the moment the Pi fires it. -->
					<line x1={x(m.t)} x2={x(m.t)} y1={TOP} y2={H} stroke={sel ? '#38bdf8' : m.kind === 'fire' ? '#f59e0b' : m.kind === 'pose' ? '#e5e7eb' : '#a78bfa'} stroke-width={sel || m.kind === 'fire' ? 1.5 : 0.8} stroke-dasharray={m.kind === 'pose' || m.kind === 'fire' ? '' : '3 2'} />
					<text x={x(m.t) + 2} y={H + 12} font-size="9" fill={sel ? '#38bdf8' : m.kind === 'fire' ? '#fbbf24' : 'var(--color-tron-text)'}>{m.fire ? `⚡ ${m.fire.solenoid}` : m.label}</text>
				</g>
			{/each}
			{#each editMarkers as { m, j } (j)}
				{@const sel = selectedIndex === m.index}
				{@const prev = j > 0 ? path.markers[j - 1] : null}
				{#if prev}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<path
						d="M{x(m.t)},2 l6,6 l-6,6 l-6,-6 z"
						fill={sel ? '#38bdf8' : '#e5e7eb'}
						style="cursor: ew-resize; touch-action: none"
						onpointerdown={(e) => begin(e, { kind: 'duration', index: m.index, origin: prev.t + prev.holdS })}
					><title>Drag: when the arm reaches {m.label}</title></path>
				{/if}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<rect
					x={x(m.t + m.holdS) - 2}
					y="17"
					width="4"
					height="9"
					fill={m.holdS > 0 ? '#38bdf8' : 'rgba(56,189,248,0.5)'}
					style="cursor: ew-resize; touch-action: none"
					onpointerdown={(e) => begin(e, { kind: 'hold', index: m.index, origin: m.t })}
				><title>Drag: how long to hold {m.label} ({m.holdS} s)</title></rect>
				{#each m.positions as v, s (s)}
					<circle
						cx={x(m.t)}
						cy={yOf(s, v)}
						r={sel ? 5 : 4}
						fill={sel ? '#38bdf8' : '#0b1220'}
						stroke={sel ? '#e0f2fe' : '#f59e0b'}
						stroke-width="1.5"
						style="cursor: ns-resize; touch-action: none"
						role="slider"
						tabindex="0"
						aria-label="{m.label}: servo {s + 1} {jointNames[s] ?? ''}"
						aria-valuemin={0}
						aria-valuemax={ENCODER_MAX}
						aria-valuenow={v}
						onpointerdown={(e) => startJoint(e, m.index, s + 1, v)}
						onkeydown={(e) => key(e, m.index, s + 1, v)}
					><title>{m.label} · servo {s + 1}: {v} — drag up/down (Shift = fine), or ↑/↓</title></circle>
				{/each}
			{/each}
			{#if playheadS != null}
				<line x1={x(Math.min(playheadS, total))} x2={x(Math.min(playheadS, total))} y1={TOP} y2={H} stroke="#4ade80" stroke-width="2" />
			{/if}
		{:else}
			<text x={W / 2} y={H / 2} text-anchor="middle" font-size="12" fill="var(--color-tron-text-secondary)">Add poses to see the path</text>
		{/if}
	</svg>
</div>
