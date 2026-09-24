<script lang="ts">
	/**
	 * One sweep trace: bx / by / bz / |B| against stage position y (microns).
	 *
	 * Two readout modes, driven by `profile.method`:
	 *   'peak'  — the well's peak fell inside stage travel, so peak/FWHM describe it.
	 *   'slope' — the peak lies past the 45000um stage limit, so the well is
	 *             characterised by its rising slope instead. That is an expected,
	 *             valid characterisation, not a fault: it is worded "travel-limited"
	 *             and coloured informational amber, never red.
	 */

	interface Point {
		y: number;
		bx?: number | null;
		by?: number | null;
		bz?: number | null;
		mag?: number | null;
	}

	/** Every field is optional — older sessions predate the slope fields entirely. */
	interface Profile {
		peakY?: number | null;
		peakMag?: number | null;
		peakBx?: number | null;
		peakBy?: number | null;
		peakBz?: number | null;
		baseline?: number | null;
		amplitude?: number | null;
		fwhm?: number | null;
		halfMaxLeftY?: number | null;
		halfMaxRightY?: number | null;
		clipped?: boolean | null;
		points?: number | null;
		yMin?: number | null;
		yMax?: number | null;
		travelLimited?: boolean | null;
		edge?: 'none' | 'distal' | 'proximal' | null;
		slopePerMm?: number | null;
		slopeR2?: number | null;
		slopeSpanY?: [number, number] | null;
		method?: 'peak' | 'slope' | null;
	}

	interface Props {
		series?: Point[] | null;
		profile?: Profile | null;
		channel: string;
	}

	let { series = null, profile = null, channel }: Props = $props();

	/** Stage travel ceiling, firmware STAGE_POSITION_LIMIT. */
	const STAGE_LIMIT = 45000;

	const W = 560;
	const H = 300;
	const PAD = { top: 18, right: 58, bottom: 46, left: 60 };
	const PLOT_W = W - PAD.left - PAD.right;
	const PLOT_H = H - PAD.top - PAD.bottom;

	type SeriesKey = 'mag' | 'bx' | 'by' | 'bz';

	/**
	 * |B| is the hero: neutral ink, heavy stroke. The three components are the
	 * categorical trio (validated all-pairs for CVD against this dark surface) at a
	 * lighter weight, so dominance is carried by weight + chroma, not hue alone.
	 */
	const SERIES: { key: SeriesKey; label: string; color: string; width: number; opacity: number }[] = [
		{ key: 'bx', label: 'bx', color: '#3987e5', width: 1.2, opacity: 0.8 },
		{ key: 'by', label: 'by', color: '#d95926', width: 1.2, opacity: 0.8 },
		{ key: 'bz', label: 'bz', color: '#199e70', width: 1.2, opacity: 0.8 },
		{ key: 'mag', label: 'B', color: '#e0e0e0', width: 2.2, opacity: 1 }
	];

	function num(v: unknown): number | null {
		return typeof v === 'number' && Number.isFinite(v) ? v : null;
	}

	function fmt(v: unknown, digits = 1): string {
		const n = num(v);
		return n === null ? '—' : n.toFixed(digits);
	}

	function fmtInt(v: unknown): string {
		const n = num(v);
		return n === null ? '—' : Math.round(n).toLocaleString();
	}

	/** Ascending in y, and defensive about rows that arrive without a position. */
	const pts = $derived(
		(series ?? [])
			.filter((p): p is Point => !!p && num(p.y) !== null)
			.slice()
			.sort((a, b) => a.y - b.y)
	);

	const hasData = $derived(pts.length >= 2);

	const xDomain = $derived.by<[number, number]>(() => {
		if (pts.length) {
			const lo = pts[0].y;
			const hi = pts[pts.length - 1].y;
			return hi > lo ? [lo, hi] : [lo - 1, hi + 1];
		}
		const lo = num(profile?.yMin) ?? 0;
		const hi = num(profile?.yMax) ?? lo + 1;
		return hi > lo ? [lo, hi] : [lo, lo + 1];
	});

	/**
	 * One shared field axis for all four traces — they are the same measurement in
	 * the same units, so a second y-scale would make this a dual-axis chart.
	 */
	const yDomain = $derived.by<[number, number]>(() => {
		let lo = Infinity;
		let hi = -Infinity;
		for (const p of pts) {
			for (const s of SERIES) {
				const v = num(p[s.key]);
				if (v === null) continue;
				if (v < lo) lo = v;
				if (v > hi) hi = v;
			}
		}
		if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
		if (hi === lo) return [lo - 1, hi + 1];
		const pad = (hi - lo) * 0.08;
		return [lo - pad, hi + pad];
	});

	function sx(v: number): number {
		const [lo, hi] = xDomain;
		return PAD.left + ((v - lo) / (hi - lo)) * PLOT_W;
	}

	function sy(v: number): number {
		const [lo, hi] = yDomain;
		return PAD.top + PLOT_H - ((v - lo) / (hi - lo)) * PLOT_H;
	}

	/** Breaks the polyline across gaps so a missing reading is not interpolated. */
	function pathFor(key: SeriesKey): string {
		let d = '';
		let pen = false;
		for (const p of pts) {
			const v = num(p[key]);
			if (v === null) {
				pen = false;
				continue;
			}
			d += (pen ? 'L' : 'M') + sx(p.y).toFixed(2) + ',' + sy(v).toFixed(2) + ' ';
			pen = true;
		}
		return d.trim();
	}

	const paths = $derived(SERIES.map((s) => ({ ...s, d: pathFor(s.key) })));

	function ticks(lo: number, hi: number, count: number): number[] {
		const out: number[] = [];
		for (let i = 0; i <= count; i++) out.push(lo + ((hi - lo) * i) / count);
		return out;
	}

	const xTicks = $derived(ticks(xDomain[0], xDomain[1], 4));
	const yTicks = $derived(ticks(yDomain[0], yDomain[1], 4));

	const method = $derived(profile?.method === 'slope' ? 'slope' : 'peak');
	const isTravelLimited = $derived(method === 'slope' || profile?.travelLimited === true);

	const peakY = $derived(num(profile?.peakY));
	const peakMag = $derived(num(profile?.peakMag));

	/**
	 * The fitted rising tail. slopePerMm is |B| per 1000 microns, so it converts back
	 * to per-micron to draw. A least-squares line passes through the centroid of the
	 * points it was fitted over, which supplies the intercept the contract omits.
	 */
	const slopeLine = $derived.by(() => {
		if (method !== 'slope') return null;
		const span = profile?.slopeSpanY;
		const perMm = num(profile?.slopePerMm);
		if (!Array.isArray(span) || span.length !== 2 || perMm === null) return null;
		const x1 = num(span[0]);
		const x2 = num(span[1]);
		if (x1 === null || x2 === null) return null;

		const perMicron = perMm / 1000;
		const inSpan = pts.filter((p) => p.y >= x1 && p.y <= x2 && num(p.mag) !== null);

		let anchorY: number;
		let anchorMag: number;
		if (inSpan.length) {
			anchorY = inSpan.reduce((a, p) => a + p.y, 0) / inSpan.length;
			anchorMag = inSpan.reduce((a, p) => a + (num(p.mag) as number), 0) / inSpan.length;
		} else if (peakY !== null && peakMag !== null) {
			anchorY = peakY;
			anchorMag = peakMag;
		} else {
			return null;
		}

		return {
			x1,
			x2,
			v1: anchorMag + (x1 - anchorY) * perMicron,
			v2: anchorMag + (x2 - anchorY) * perMicron
		};
	});

	/** End-of-line direct labels, nudged apart so four converging traces stay legible. */
	const endLabels = $derived.by(() => {
		const raw: { label: string; color: string; y: number }[] = [];
		for (const s of SERIES) {
			for (let i = pts.length - 1; i >= 0; i--) {
				const v = num(pts[i][s.key]);
				if (v !== null) {
					raw.push({ label: s.label, color: s.color, y: sy(v) });
					break;
				}
			}
		}
		raw.sort((a, b) => a.y - b.y);
		const MIN_GAP = 11;
		for (let i = 1; i < raw.length; i++) {
			if (raw[i].y - raw[i - 1].y < MIN_GAP) raw[i].y = raw[i - 1].y + MIN_GAP;
		}
		return raw;
	});

	// --- hover crosshair -------------------------------------------------------
	let hoverIdx = $state<number | null>(null);

	const hovered = $derived(hoverIdx !== null && pts[hoverIdx] ? pts[hoverIdx] : null);

	function onMove(event: PointerEvent) {
		const target = event.currentTarget as SVGRectElement | null;
		const rect = target?.ownerSVGElement?.getBoundingClientRect();
		if (!rect || !rect.width || !pts.length) return;
		const localX = ((event.clientX - rect.left) / rect.width) * W;
		const [lo, hi] = xDomain;
		const wanted = lo + ((localX - PAD.left) / PLOT_W) * (hi - lo);
		let best = 0;
		let bestDist = Infinity;
		for (let i = 0; i < pts.length; i++) {
			const d = Math.abs(pts[i].y - wanted);
			if (d < bestDist) {
				bestDist = d;
				best = i;
			}
		}
		hoverIdx = best;
	}

	function onLeave() {
		hoverIdx = null;
	}
</script>

<div class="rounded-lg border border-slate-700/60 bg-slate-900/40 p-3">
	<div class="mb-2 flex items-center justify-between gap-2">
		<h4 class="text-sm font-semibold text-slate-100 dark:text-slate-100">{channel}</h4>
		{#if isTravelLimited}
			<span
				class="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-amber-300 dark:text-amber-300"
			>
				Travel-limited{profile?.edge && profile.edge !== 'none' ? ' · ' + profile.edge : ''}
			</span>
		{/if}
	</div>

	{#if !hasData}
		<p class="px-2 py-10 text-center text-xs text-slate-400 dark:text-slate-400">
			No sweep points recorded for this channel.
		</p>
	{:else}
		<svg
			viewBox="0 0 {W} {H}"
			class="h-auto w-full"
			role="img"
			aria-label="Field components and magnitude against stage position for {channel}"
		>
			<!-- recessive grid -->
			{#each yTicks as t (t)}
				<line
					x1={PAD.left}
					x2={PAD.left + PLOT_W}
					y1={sy(t)}
					y2={sy(t)}
					stroke="currentColor"
					stroke-width="1"
					class="text-slate-100/10"
				/>
			{/each}

			<!-- fitted span shading -->
			{#if slopeLine}
				<rect
					x={Math.min(sx(slopeLine.x1), sx(slopeLine.x2))}
					y={PAD.top}
					width={Math.abs(sx(slopeLine.x2) - sx(slopeLine.x1))}
					height={PLOT_H}
					fill="#ffc233"
					opacity="0.1"
				/>
			{/if}

			<!-- axes -->
			<line
				x1={PAD.left}
				x2={PAD.left + PLOT_W}
				y1={PAD.top + PLOT_H}
				y2={PAD.top + PLOT_H}
				stroke="currentColor"
				stroke-width="1"
				class="text-slate-500/50"
			/>
			<line
				x1={PAD.left}
				x2={PAD.left}
				y1={PAD.top}
				y2={PAD.top + PLOT_H}
				stroke="currentColor"
				stroke-width="1"
				class="text-slate-500/50"
			/>

			{#each xTicks as t (t)}
				<text
					x={sx(t)}
					y={PAD.top + PLOT_H + 16}
					text-anchor="middle"
					font-size="10"
					fill="currentColor"
					class="text-slate-400 dark:text-slate-400"
				>
					{fmtInt(t)}
				</text>
			{/each}
			{#each yTicks as t (t)}
				<text
					x={PAD.left - 8}
					y={sy(t) + 3}
					text-anchor="end"
					font-size="10"
					fill="currentColor"
					class="text-slate-400 dark:text-slate-400"
				>
					{fmt(t, 0)}
				</text>
			{/each}

			<text
				x={PAD.left + PLOT_W / 2}
				y={H - 6}
				text-anchor="middle"
				font-size="11"
				fill="currentColor"
				class="text-slate-300 dark:text-slate-300"
			>
				stage position y (microns)
			</text>
			<text
				x="14"
				y={PAD.top + PLOT_H / 2}
				text-anchor="middle"
				font-size="11"
				fill="currentColor"
				class="text-slate-300 dark:text-slate-300"
				transform="rotate(-90 14 {PAD.top + PLOT_H / 2})"
			>
				field
			</text>

			<!-- peak guide -->
			{#if peakY !== null && peakY >= xDomain[0] && peakY <= xDomain[1]}
				<line
					x1={sx(peakY)}
					x2={sx(peakY)}
					y1={PAD.top}
					y2={PAD.top + PLOT_H}
					stroke="currentColor"
					stroke-width="1"
					stroke-dasharray="4 3"
					class="text-slate-300/50"
				/>
			{/if}

			<!-- traces -->
			{#each paths as p (p.key)}
				{#if p.d}
					<path
						d={p.d}
						fill="none"
						stroke={p.color}
						stroke-width={p.width}
						opacity={p.opacity}
						stroke-linejoin="round"
						stroke-linecap="round"
					/>
				{/if}
			{/each}

			<!-- fitted rising tail -->
			{#if slopeLine}
				<line
					x1={sx(slopeLine.x1)}
					x2={sx(slopeLine.x2)}
					y1={sy(slopeLine.v1)}
					y2={sy(slopeLine.v2)}
					stroke="#ffc233"
					stroke-width="2"
					stroke-dasharray="6 4"
				/>
			{/if}

			<!-- peak marker -->
			{#if peakY !== null && peakMag !== null && peakY >= xDomain[0] && peakY <= xDomain[1]}
				<circle
					cx={sx(peakY)}
					cy={sy(peakMag)}
					r="4"
					fill="#e0e0e0"
					stroke="#0a0a0f"
					stroke-width="2"
				/>
			{/if}

			<!-- direct labels -->
			{#each endLabels as l (l.label)}
				<text x={PAD.left + PLOT_W + 6} y={l.y + 3} font-size="10" fill={l.color} font-weight="600">
					{l.label}
				</text>
			{/each}

			<!-- hover crosshair -->
			{#if hovered}
				<line
					x1={sx(hovered.y)}
					x2={sx(hovered.y)}
					y1={PAD.top}
					y2={PAD.top + PLOT_H}
					stroke="currentColor"
					stroke-width="1"
					class="text-slate-200/40"
				/>
				{#each SERIES as s (s.key)}
					{@const hv = num(hovered[s.key])}
					{#if hv !== null}
						<circle
							cx={sx(hovered.y)}
							cy={sy(hv)}
							r="3"
							fill={s.color}
							stroke="#0a0a0f"
							stroke-width="1.5"
						/>
					{/if}
				{/each}
			{/if}

			<rect
				x={PAD.left}
				y={PAD.top}
				width={PLOT_W}
				height={PLOT_H}
				fill="transparent"
				onpointermove={onMove}
				onpointerleave={onLeave}
			/>
		</svg>

		<!-- legend -->
		<div
			class="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-slate-300 dark:text-slate-300"
		>
			{#each SERIES as s (s.key)}
				<span class="inline-flex items-center gap-1.5">
					<span
						class="inline-block rounded-sm"
						style="width:12px;height:{s.key === 'mag'
							? 3
							: 2}px;background:{s.color};opacity:{s.opacity}"
					></span>
					{s.key === 'mag' ? '|B|' : s.label}
				</span>
			{/each}
			{#if hovered}
				<span class="ml-auto tabular-nums text-slate-400 dark:text-slate-400">
					y {fmtInt(hovered.y)} · |B| {fmt(hovered.mag, 2)}
				</span>
			{/if}
		</div>

		<!-- readout -->
		{#if !profile}
			<p class="mt-2 border-t border-slate-700/60 pt-2 text-xs text-slate-400 dark:text-slate-400">
				No profile recorded for this channel.
			</p>
		{:else if method === 'slope'}
			<div class="mt-2 border-t border-slate-700/60 pt-2">
				<dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-3">
					<div>
						<dt class="text-slate-400 dark:text-slate-400">Slope</dt>
						<dd class="font-semibold tabular-nums text-amber-300 dark:text-amber-300">
							{fmt(profile.slopePerMm, 2)}
							<span class="font-normal text-slate-400 dark:text-slate-400">/mm</span>
						</dd>
					</div>
					<div>
						<dt class="text-slate-400 dark:text-slate-400">Fit R²</dt>
						<dd class="font-semibold tabular-nums text-slate-100 dark:text-slate-100">
							{fmt(profile.slopeR2, 3)}
						</dd>
					</div>
					<div>
						<dt class="text-slate-400 dark:text-slate-400">Edge</dt>
						<dd class="font-semibold text-slate-100 dark:text-slate-100">{profile.edge ?? '—'}</dd>
					</div>
					<div>
						<dt class="text-slate-400 dark:text-slate-400">Fitted span</dt>
						<dd class="tabular-nums text-slate-200 dark:text-slate-200">
							{#if profile.slopeSpanY}
								{fmtInt(profile.slopeSpanY[0])}–{fmtInt(profile.slopeSpanY[1])} µm
							{:else}
								—
							{/if}
						</dd>
					</div>
					<div>
						<dt class="text-slate-400 dark:text-slate-400">Baseline</dt>
						<dd class="tabular-nums text-slate-200 dark:text-slate-200">
							{fmt(profile.baseline, 2)}
						</dd>
					</div>
					<div>
						<dt class="text-slate-400 dark:text-slate-400">Points</dt>
						<dd class="tabular-nums text-slate-200 dark:text-slate-200">{fmtInt(profile.points)}</dd>
					</div>
				</dl>
				<p class="mt-2 text-[11px] leading-relaxed text-amber-200/80 dark:text-amber-200/80">
					Stage travel ends at the {STAGE_LIMIT.toLocaleString()} µm limit, so this well is characterised
					by its rising slope rather than by a peak.
				</p>
			</div>
		{:else}
			<div class="mt-2 border-t border-slate-700/60 pt-2">
				<dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-3">
					<div>
						<dt class="text-slate-400 dark:text-slate-400">Peak y</dt>
						<dd class="font-semibold tabular-nums text-slate-100 dark:text-slate-100">
							{fmtInt(profile.peakY)} µm
						</dd>
					</div>
					<div>
						<dt class="text-slate-400 dark:text-slate-400">|B| peak</dt>
						<dd class="font-semibold tabular-nums text-slate-100 dark:text-slate-100">
							{fmt(profile.peakMag, 2)}
						</dd>
					</div>
					<div>
						<dt class="text-slate-400 dark:text-slate-400">Amplitude</dt>
						<dd class="tabular-nums text-slate-200 dark:text-slate-200">
							{fmt(profile.amplitude, 2)}
						</dd>
					</div>
					<div>
						<dt class="text-slate-400 dark:text-slate-400">Baseline</dt>
						<dd class="tabular-nums text-slate-200 dark:text-slate-200">
							{fmt(profile.baseline, 2)}
						</dd>
					</div>
					<div>
						<dt class="text-slate-400 dark:text-slate-400">FWHM</dt>
						<dd class="tabular-nums text-slate-200 dark:text-slate-200">
							{profile.fwhm == null ? '—' : fmtInt(profile.fwhm) + ' µm'}
						</dd>
					</div>
					<div>
						<dt class="text-slate-400 dark:text-slate-400">Half-max</dt>
						<dd class="tabular-nums text-slate-200 dark:text-slate-200">
							{fmtInt(profile.halfMaxLeftY)} / {fmtInt(profile.halfMaxRightY)}
						</dd>
					</div>
				</dl>
			</div>
		{/if}
	{/if}
</div>
