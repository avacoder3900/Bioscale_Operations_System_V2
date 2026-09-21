<script lang="ts">
	// One lane per group, x = F7/F3. Hand-rolled SVG rather than a chart library:
	// this is a 1-D categorical strip plot with a shaded band and click-through, which
	// canvas renderers make awkward, and the repo already has client-side SVG charts
	// (see equipment/temperature-probes). No new dependency.
	//
	// "Outliers in a group" is fundamentally a scatter question — thirty numbers in a
	// table do not show separation, this does.

	export interface StripPoint {
		id: string;
		value: number;
		outlier: boolean;
		spuUdi: string | null;
		z: number | null;
	}
	export interface StripLane {
		groupId: string;
		groupName: string;
		color: string;
		median: number | null;
		low: number | null;
		high: number | null;
		points: StripPoint[];
	}

	interface Props {
		channel: 'A' | 'B' | 'C';
		lanes: StripLane[];
		xMin: number;
		xMax: number;
	}
	let { channel, lanes, xMin, xMax }: Props = $props();

	const W = 800;
	const PAD_L = 150;
	const PAD_R = 24;
	const PAD_T = 26;
	const LANE_H = 46;
	const PAD_B = 30;

	const H = $derived(PAD_T + lanes.length * LANE_H + PAD_B);

	// Guard a zero-width domain, which would divide by zero.
	const span = $derived(xMax - xMin || 1);
	function toX(v: number): number {
		return PAD_L + ((v - xMin) / span) * (W - PAD_L - PAD_R);
	}
	function laneY(i: number): number {
		return PAD_T + i * LANE_H + LANE_H / 2;
	}

	/** Deterministic jitter by index — never Math.random(), which would make points
	 *  jump on every re-render and every threshold change. */
	function jitter(i: number): number {
		return ((i % 5) - 2) * 4;
	}

	function cssColor(key: string): string {
		// An SVG presentation attribute, not a Tailwind class, so a runtime var() is fine.
		return `var(--color-tron-${key}, #00d4ff)`;
	}

	const TICKS = 5;
	const ticks = $derived(
		Array.from({ length: TICKS }, (_, i) => xMin + (span * i) / (TICKS - 1))
	);

	function tickLabel(v: number): string {
		const mag = Math.abs(v);
		return mag >= 100 ? v.toFixed(0) : mag >= 10 ? v.toFixed(1) : v.toFixed(2);
	}

	/** Shape per group index, so the plot never depends on colour alone — the tron
	 *  green/yellow/orange trio is weak under deuteranopia. */
	function shape(gi: number): 'circle' | 'square' | 'triangle' | 'diamond' {
		return (['circle', 'square', 'triangle', 'diamond'] as const)[gi % 4];
	}

	function pointTitle(lane: StripLane, p: StripPoint): string {
		const z = p.z != null ? `${p.z > 0 ? '+' : ''}${p.z.toFixed(1)} robust SD` : 'z n/a';
		return `${p.id}\n${lane.groupName}${p.spuUdi ? ` · ${p.spuUdi}` : ''}\nF7/F3 ${p.value.toFixed(3)} (${z})${
			p.outlier ? '\nFlagged as an outlier within its group' : ''
		}`;
	}
</script>

<svg
	viewBox="0 0 {W} {H}"
	class="w-full"
	preserveAspectRatio="xMidYMid meet"
	role="img"
	aria-label="F7/F3 by cartridge for well {channel}, one lane per group"
>
	<!-- axis -->
	{#each ticks as t}
		<line
			x1={toX(t)}
			y1={PAD_T - 8}
			x2={toX(t)}
			y2={H - PAD_B + 4}
			stroke="var(--color-tron-border)"
			stroke-width="1"
		/>
		<text
			x={toX(t)}
			y={H - PAD_B + 18}
			text-anchor="middle"
			font-size="11"
			fill="var(--color-tron-text-secondary)"
		>
			{tickLabel(t)}
		</text>
	{/each}
	<text
		x={PAD_L + (W - PAD_L - PAD_R) / 2}
		y={14}
		text-anchor="middle"
		font-size="11"
		fill="var(--color-tron-text-secondary)"
	>
		Well {channel} — F7/F3
	</text>

	{#each lanes as lane, gi (lane.groupId)}
		{@const y = laneY(gi)}
		<!-- lane label -->
		<text
			x={PAD_L - 10}
			y={y + 4}
			text-anchor="end"
			font-size="11"
			fill={cssColor(lane.color)}
		>
			{lane.groupName.length > 20 ? lane.groupName.slice(0, 19) + '…' : lane.groupName}
			<tspan fill="var(--color-tron-text-secondary)"> (n={lane.points.length})</tspan>
		</text>

		{#if lane.points.length === 0}
			<text x={PAD_L + 8} y={y + 4} font-size="11" fill="var(--color-tron-text-secondary)">
				no data on well {channel}
			</text>
		{:else}
			<!-- expected-range band -->
			{#if lane.low != null && lane.high != null}
				<rect
					x={toX(Math.max(lane.low, xMin))}
					y={y - 15}
					width={Math.max(0, toX(Math.min(lane.high, xMax)) - toX(Math.max(lane.low, xMin)))}
					height="30"
					fill={cssColor(lane.color)}
					opacity="0.12"
				/>
			{/if}
			<!-- median -->
			{#if lane.median != null}
				<line
					x1={toX(lane.median)}
					y1={y - 16}
					x2={toX(lane.median)}
					y2={y + 16}
					stroke={cssColor(lane.color)}
					stroke-width="2"
				/>
			{/if}

			{#each lane.points as p, pi (p.id)}
				{@const px = toX(p.value)}
				{@const py = y + jitter(pi)}
				{@const s = shape(gi)}
				<a href={'/validation/optical-confirmation/' + p.id}>
					<title>{pointTitle(lane, p)}</title>
					{#if s === 'circle'}
						<circle
							cx={px}
							cy={py}
							r="4.5"
							fill={p.outlier ? '#f59e0b' : cssColor(lane.color)}
							stroke={p.outlier ? '#f59e0b' : 'none'}
							stroke-width={p.outlier ? 2 : 0}
							opacity="0.9"
						/>
					{:else if s === 'square'}
						<rect
							x={px - 4}
							y={py - 4}
							width="8"
							height="8"
							fill={p.outlier ? '#f59e0b' : cssColor(lane.color)}
							stroke={p.outlier ? '#f59e0b' : 'none'}
							stroke-width={p.outlier ? 2 : 0}
							opacity="0.9"
						/>
					{:else if s === 'triangle'}
						<polygon
							points="{px},{py - 5} {px + 5},{py + 4} {px - 5},{py + 4}"
							fill={p.outlier ? '#f59e0b' : cssColor(lane.color)}
							stroke={p.outlier ? '#f59e0b' : 'none'}
							stroke-width={p.outlier ? 2 : 0}
							opacity="0.9"
						/>
					{:else}
						<polygon
							points="{px},{py - 5.5} {px + 5},{py} {px},{py + 5.5} {px - 5},{py}"
							fill={p.outlier ? '#f59e0b' : cssColor(lane.color)}
							stroke={p.outlier ? '#f59e0b' : 'none'}
							stroke-width={p.outlier ? 2 : 0}
							opacity="0.9"
						/>
					{/if}
				</a>
			{/each}
		{/if}
	{/each}
</svg>
