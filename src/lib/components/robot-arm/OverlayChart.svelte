<script lang="ts">
	/**
	 * Overlay chart: one lane per servo on the ANIMATED recording's time axis.
	 *
	 *   grey line   — the animated recording (its goals, as saved)
	 *   amber line  — the pilot's recording, lined up with the animation in time
	 *   cyan line   — the result: the animation with the pilot's offset applied
	 *
	 * A lane whose servo is not being corrected shows the pilot's line dimmed
	 * and the result on top of the animation.
	 */
	interface Props {
		t: number[];
		smooth: number[][];
		pilot: number[][];
		result: number[][];
		jointNames: string[];
		corrected: boolean[];
	}

	let { t, smooth, pilot, result, jointNames, corrected }: Props = $props();

	const LANE_H = 52;
	const W = 1000;
	let zoom = $state(1);

	const t0 = $derived(t.length ? t[0] : 0);
	const t1 = $derived(t.length ? Math.max(t[t.length - 1], t0 + 0.001) : 1);
	const x = (s: number) => ((s - t0) / (t1 - t0)) * W;
	const servoIdx = [0, 1, 2, 3, 4, 5];

	/** Thin to at most this many points per line for drawing. */
	const MAX_POINTS = 1500;
	const every = $derived(Math.max(1, Math.ceil(t.length / MAX_POINTS)));

	const ranges = $derived(
		servoIdx.map((j) => {
			let lo = Infinity;
			let hi = -Infinity;
			for (const series of [smooth, pilot, result]) {
				for (let i = 0; i < series.length; i += every) {
					lo = Math.min(lo, series[i][j]);
					hi = Math.max(hi, series[i][j]);
				}
			}
			if (!Number.isFinite(lo)) return { lo: 0, hi: 4095 };
			if (hi - lo < 20) {
				const mid = (hi + lo) / 2;
				return { lo: mid - 10, hi: mid + 10 };
			}
			const pad = (hi - lo) * 0.08;
			return { lo: lo - pad, hi: hi + pad };
		})
	);
	const y = (j: number, v: number) => {
		const r = ranges[j];
		return j * LANE_H + 3 + (1 - (v - r.lo) / (r.hi - r.lo)) * (LANE_H - 6);
	};
	function path(series: number[][], j: number): string {
		const pts: string[] = [];
		for (let i = 0; i < series.length; i += every) pts.push(`${x(t[i]).toFixed(1)},${y(j, series[i][j]).toFixed(1)}`);
		const last = series.length - 1;
		if (last >= 0 && last % every !== 0) pts.push(`${x(t[last]).toFixed(1)},${y(j, series[last][j]).toFixed(1)}`);
		return pts.join(' ');
	}
	const smoothPaths = $derived(servoIdx.map((j) => path(smooth, j)));
	const pilotPaths = $derived(servoIdx.map((j) => path(pilot, j)));
	const resultPaths = $derived(servoIdx.map((j) => path(result, j)));

	function fmtS(s: number) {
		return s >= 60 ? `${Math.floor(s / 60)}:${(s % 60).toFixed(0).padStart(2, '0')}` : `${s.toFixed(1)} s`;
	}
	const ticks = $derived.by(() => {
		const span = t1 - t0;
		const target = 10 * zoom;
		const raw = span / target;
		const nice = [0.5, 1, 2, 5, 10, 15, 30, 60, 120].find((n) => n >= raw) ?? 300;
		const out: number[] = [];
		for (let s = Math.ceil(t0 / nice) * nice; s <= t1; s += nice) out.push(s);
		return out;
	});
</script>

<div class="space-y-2">
	<div class="flex items-center justify-between gap-2 text-[11px]" style="color: var(--color-tron-text-secondary)">
		<div class="flex flex-wrap items-center gap-3">
			<span class="flex items-center gap-1"><span class="inline-block h-0.5 w-4 bg-slate-400"></span> animated</span>
			<span class="flex items-center gap-1"><span class="inline-block h-0.5 w-4 bg-amber-400"></span> pilot, lined up in time</span>
			<span class="flex items-center gap-1"><span class="inline-block h-0.5 w-4 bg-cyan-400"></span> result</span>
		</div>
		<div class="flex items-center gap-1">
			zoom
			{#each [1, 2, 4, 8] as z (z)}
				<button
					type="button"
					onclick={() => (zoom = z)}
					class="rounded px-1.5 py-0.5 font-mono transition-colors {zoom === z
						? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
						: 'hover:bg-white/10'}">{z}×</button
				>
			{/each}
		</div>
	</div>

	<div class="flex">
		<div class="w-24 shrink-0 pt-5">
			{#each servoIdx as j (j)}
				<div class="flex items-center truncate pr-2 text-[11px]" style="height: {LANE_H}px; color: var(--color-tron-text-secondary)" title={jointNames[j]}>
					<span class="mr-1 font-mono text-cyan-400">{j + 1}</span>
					<span class={corrected[j] ? '' : 'line-through opacity-60'}>{jointNames[j]}</span>
				</div>
			{/each}
		</div>
		<div class="min-w-0 flex-1 overflow-x-auto rounded border border-[var(--color-tron-border)] bg-black/30">
			<div class="relative" style="width: {zoom * 100}%">
				<div class="relative h-5 border-b border-[var(--color-tron-border)]/60 text-[10px]">
					{#each ticks as s (s)}
						<span class="absolute top-0.5 -translate-x-1/2 opacity-50" style="left: {(x(s) / W) * 100}%; color: var(--color-tron-text-secondary)">{fmtS(s)}</span>
					{/each}
				</div>
				<svg viewBox="0 0 {W} {LANE_H * 6}" preserveAspectRatio="none" class="block w-full" style="height: {LANE_H * 6}px" aria-label="Overlay per servo">
					{#each servoIdx as j (j)}
						<line x1="0" x2={W} y1={(j + 1) * LANE_H} y2={(j + 1) * LANE_H} stroke="rgba(255,255,255,0.08)" />
						<polyline points={smoothPaths[j]} fill="none" stroke="#94a3b8" stroke-width="1.2" vector-effect="non-scaling-stroke" />
						<polyline points={pilotPaths[j]} fill="none" stroke="#fbbf24" stroke-width="1" stroke-opacity={corrected[j] ? 0.9 : 0.35} vector-effect="non-scaling-stroke" />
						<polyline points={resultPaths[j]} fill="none" stroke="#22d3ee" stroke-width="1.4" vector-effect="non-scaling-stroke" />
					{/each}
				</svg>
			</div>
		</div>
	</div>
</div>
