<script lang="ts">
	/**
	 * Recording clean-up timeline: one lane per servo on the RAW recording's
	 * time axis.
	 *
	 *   grey line   — what the recording commanded (every wobble, untouched)
	 *   cyan band   — a step's raw time span, in the lanes of the servos it moves
	 *   amber line  — the operator's version: from → target across that span
	 *
	 * Steps the operator added have no raw time, so they only appear in the
	 * playback strip under the lanes. Click a band (or a strip block) to select
	 * its step.
	 */
	import type { ResolvedStep } from '$lib/robot-arm/recording-cleanup';

	interface Props {
		t: number[];
		goal: number[][];
		jointNames: string[];
		steps: ResolvedStep[];
		/** Total playback time of the cleaned version. */
		playbackS: number;
		selectedId: string | null;
		onselect: (id: string) => void;
	}

	let { t, goal, jointNames, steps, playbackS, selectedId, onselect }: Props = $props();

	const LANE_H = 46;
	const W = 1000;
	let zoom = $state(1);
	let scroller: HTMLDivElement | undefined = $state();

	const t0 = $derived(t.length ? t[0] : 0);
	const t1 = $derived(t.length ? Math.max(t[t.length - 1], t0 + 0.001) : 1);
	const x = (s: number) => ((s - t0) / (t1 - t0)) * W;

	const servoIdx = [0, 1, 2, 3, 4, 5];

	/** Per-lane y range covering the raw trace and every target. */
	const ranges = $derived(
		servoIdx.map((j) => {
			let lo = Infinity;
			let hi = -Infinity;
			for (const row of goal) {
				lo = Math.min(lo, row[j]);
				hi = Math.max(hi, row[j]);
			}
			for (const s of steps)
				for (const m of s.moves)
					if (m.servoId === j + 1) {
						lo = Math.min(lo, m.to, m.from);
						hi = Math.max(hi, m.to, m.from);
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

	const tracePaths = $derived(
		servoIdx.map((j) => goal.map((row, i) => `${x(t[i]).toFixed(1)},${y(j, row[j]).toFixed(1)}`).join(' '))
	);

	const rawSteps = $derived(steps.filter((s) => s.step.raw));

	function scrollToSelected() {
		if (!scroller || !selectedId || zoom === 1) return;
		const s = steps.find((r) => r.step.id === selectedId);
		if (!s?.step.raw) return;
		const frac = (s.step.raw.tStart - t0) / (t1 - t0);
		scroller.scrollTo({ left: Math.max(0, frac * scroller.scrollWidth - scroller.clientWidth / 3), behavior: 'smooth' });
	}
	$effect(() => {
		void selectedId;
		void zoom;
		scrollToSelected();
	});

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
			<span class="flex items-center gap-1"><span class="inline-block h-0.5 w-4 bg-slate-400"></span> recorded</span>
			<span class="flex items-center gap-1"><span class="inline-block h-2.5 w-4 rounded-sm bg-cyan-400/25 ring-1 ring-cyan-400/50"></span> step</span>
			<span class="flex items-center gap-1"><span class="inline-block h-0.5 w-4 bg-amber-400"></span> your version</span>
		</div>
		<div class="flex items-center gap-1">
			zoom
			{#each [1, 2, 4, 8, 16] as z (z)}
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
		<!-- Lane labels stay put while the lanes scroll. -->
		<div class="w-24 shrink-0 pt-5">
			{#each servoIdx as j (j)}
				<div class="flex items-center truncate pr-2 text-[11px]" style="height: {LANE_H}px; color: var(--color-tron-text-secondary)" title={jointNames[j]}>
					<span class="mr-1 font-mono text-cyan-400">{j + 1}</span>{jointNames[j]}
				</div>
			{/each}
		</div>
		<div bind:this={scroller} class="min-w-0 flex-1 overflow-x-auto rounded border border-[var(--color-tron-border)] bg-black/30">
			<div class="relative" style="width: {zoom * 100}%">
				<!-- Step numbers + time ticks -->
				<div class="relative h-5 border-b border-[var(--color-tron-border)]/60 text-[10px]">
					{#each ticks as s (s)}
						<span class="absolute top-0.5 -translate-x-1/2 opacity-50" style="left: {(x(s) / W) * 100}%; color: var(--color-tron-text-secondary)">{fmtS(s)}</span>
					{/each}
				</div>
				<svg
					viewBox="0 0 {W} {LANE_H * 6}"
					preserveAspectRatio="none"
					class="block w-full"
					style="height: {LANE_H * 6}px"
					role="img"
					aria-label="Recorded servo positions with steps"
				>
					{#each servoIdx as j (j)}
						<line x1="0" x2={W} y1={(j + 1) * LANE_H} y2={(j + 1) * LANE_H} stroke="rgba(148,163,184,0.15)" vector-effect="non-scaling-stroke" />
					{/each}
					{#each rawSteps as s (s.step.id)}
						{@const sel = s.step.id === selectedId}
						{@const xa = x(s.step.raw!.tStart)}
						{@const xb = Math.max(x(s.step.raw!.tEnd), xa + 1.5)}
						{#each s.moves as m (m.servoId)}
							<rect
								x={xa}
								width={xb - xa}
								y={(m.servoId - 1) * LANE_H + 1}
								height={LANE_H - 2}
								fill={sel ? 'rgba(34,211,238,0.35)' : 'rgba(34,211,238,0.12)'}
								stroke={sel ? 'rgba(34,211,238,0.9)' : 'rgba(34,211,238,0.35)'}
								vector-effect="non-scaling-stroke"
								class="cursor-pointer"
								role="button"
								tabindex="-1"
								aria-label="Step {s.number}"
								onclick={() => onselect(s.step.id)}
								onkeydown={(e) => e.key === 'Enter' && onselect(s.step.id)}
							/>
						{/each}
					{/each}
					{#each servoIdx as j (j)}
						<polyline points={tracePaths[j]} fill="none" stroke="rgba(148,163,184,0.8)" stroke-width="1" vector-effect="non-scaling-stroke" pointer-events="none" />
					{/each}
					{#each rawSteps as s (s.step.id)}
						{#each s.moves as m (m.servoId)}
							<line
								x1={x(s.step.raw!.tStart)}
								x2={Math.max(x(s.step.raw!.tEnd), x(s.step.raw!.tStart) + 1.5)}
								y1={y(m.servoId - 1, m.from)}
								y2={y(m.servoId - 1, m.to)}
								stroke="rgb(251,191,36)"
								stroke-width={s.step.id === selectedId ? 2.5 : 1.5}
								vector-effect="non-scaling-stroke"
								pointer-events="none"
							/>
						{/each}
					{/each}
				</svg>
				<!-- Step numbers over their bands -->
				<div class="pointer-events-none relative h-4 text-[10px]">
					{#each rawSteps as s (s.step.id)}
						<span
							class="absolute top-0 -translate-x-1/2 font-mono {s.step.id === selectedId ? 'font-bold text-cyan-300' : 'text-cyan-500/70'}"
							style="left: {((x(s.step.raw!.tStart) + x(s.step.raw!.tEnd)) / 2 / W) * 100}%">{s.number}</span
						>
					{/each}
				</div>
			</div>
		</div>
	</div>

	<!-- Playback strip: the cleaned version, block width = step time. -->
	<div class="flex items-center gap-2">
		<div class="w-24 shrink-0 text-[11px]" style="color: var(--color-tron-text-secondary)">
			playback<br /><span class="font-mono">{fmtS(playbackS)}</span>
		</div>
		<div class="flex h-6 min-w-0 flex-1 overflow-hidden rounded border border-[var(--color-tron-border)] bg-black/30">
			{#each steps as s (s.step.id)}
				{@const total = Math.max(playbackS, 0.001)}
				<button
					type="button"
					onclick={() => onselect(s.step.id)}
					title="Step {s.number}{s.step.label ? ` · ${s.step.label}` : ''} · {s.step.durationS} s{s.step.pauseAfterS ? ` + ${s.step.pauseAfterS} s pause` : ''}"
					class="flex h-full shrink-0 items-center justify-center overflow-hidden border-r border-black/50 text-[9px] font-mono transition-colors
						{s.step.id === selectedId ? 'bg-cyan-400 text-black' : s.step.raw ? 'bg-cyan-500/25 text-cyan-200 hover:bg-cyan-500/40' : 'bg-violet-500/30 text-violet-200 hover:bg-violet-500/45'}"
					style="width: {((s.step.durationS + s.step.pauseAfterS) / total) * 100}%"
				>
					{s.number}
				</button>
			{/each}
		</div>
	</div>
</div>
