<script lang="ts">
	/**
	 * ARM-06 — the rendered path as one lane per servo (encoder steps over
	 * time), with a tick where each pose is reached and the hold after it
	 * shaded. Optional playhead while the arm plays. Pure SVG, scales to width.
	 */
	import type { RenderedPath } from '$lib/robot-arm/animation';

	interface Props {
		path: RenderedPath | null;
		jointNames: string[];
		playheadS?: number | null;
		/** Marker index → highlight (the keyframe being edited). */
		selectedIndex?: number | null;
		onselect?: (index: number) => void;
	}

	let { path, jointNames, playheadS = null, selectedIndex = null, onselect }: Props = $props();

	const W = 1000;
	const LANE_H = 44;
	const LABEL_W = 90;
	const PAD = 4;

	const total = $derived(path ? Math.max(path.durationS, 0.001) : 1);
	const x = (s: number) => LABEL_W + (s / total) * (W - LABEL_W);

	const lanes = $derived.by(() => {
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
			if (hi - lo < 40) {
				const mid = (hi + lo) / 2;
				lo = mid - 20;
				hi = mid + 20;
			}
			const y = (v: number) => s * LANE_H + PAD + ((hi - v) / (hi - lo)) * (LANE_H - 2 * PAD);
			const d = path.goal.map((g, i) => `${i ? 'L' : 'M'}${x(path.t[i]).toFixed(1)},${y(g[s]).toFixed(1)}`).join(' ');
			return { s, lo, hi, d, range: hi - lo };
		});
	});

	const H = 6 * LANE_H;
</script>

<div class="overflow-x-auto rounded border bg-black/30" style="border-color: var(--color-tron-border)">
	<svg viewBox="0 0 {W} {H + 18}" class="block w-full" style="min-width: 640px; font-family: ui-monospace, monospace">
		{#if path}
			{#each path.markers as m, i (i)}
				{#if m.holdS > 0}
					<rect x={x(m.t)} y="0" width={Math.max(1, x(m.t + m.holdS) - x(m.t))} height={H} fill="rgba(56,189,248,0.08)" />
				{/if}
			{/each}
			{#each lanes as l (l.s)}
				<line x1={LABEL_W} x2={W} y1={(l.s + 1) * LANE_H} y2={(l.s + 1) * LANE_H} stroke="var(--color-tron-border)" stroke-width="0.5" />
				<text x="4" y={l.s * LANE_H + 14} font-size="10" fill="var(--color-tron-text-secondary)">{l.s + 1} {jointNames[l.s] ?? ''}</text>
				<text x="4" y={l.s * LANE_H + 27} font-size="8" fill="var(--color-tron-text-secondary)">Δ {Math.round(l.range)}</text>
				<path d={l.d} fill="none" stroke="#f59e0b" stroke-width="1.6" />
			{/each}
			{#each path.markers as m, i (i)}
				{@const sel = selectedIndex != null && m.index === selectedIndex}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<g style="cursor: {onselect && m.index >= 0 ? 'pointer' : 'default'}" onclick={() => m.index >= 0 && onselect?.(m.index)}>
					<line x1={x(m.t)} x2={x(m.t)} y1="0" y2={H} stroke={sel ? '#38bdf8' : m.kind === 'pose' ? '#e5e7eb' : '#a78bfa'} stroke-width={sel ? 1.5 : 0.8} stroke-dasharray={m.kind === 'pose' ? '' : '3 2'} />
					<text x={x(m.t) + 2} y={H + 12} font-size="9" fill={sel ? '#38bdf8' : 'var(--color-tron-text)'}>{m.label}</text>
				</g>
			{/each}
			{#if playheadS != null}
				<line x1={x(Math.min(playheadS, total))} x2={x(Math.min(playheadS, total))} y1="0" y2={H} stroke="#4ade80" stroke-width="2" />
			{/if}
		{:else}
			<text x={W / 2} y={H / 2} text-anchor="middle" font-size="12" fill="var(--color-tron-text-secondary)">Add poses to see the path</text>
		{/if}
	</svg>
</div>
