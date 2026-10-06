<!--
	Sonic fingerprint chart (VALIDATION-08). One SVG for every sonic graph:
	multi-series lines with gaps (null), a 10 s time grid (or a log-frequency
	axis), shaded running stretches, P#/B# section labels, an optional
	mean ± K·σ band, and ▲/▼ value labels that stack instead of overlapping.
-->
<script lang="ts" module>
	export interface ChartSeries {
		label: string;
		color: string;
		values: (number | null)[];
		width?: number;
		dashed?: boolean;
	}
	export interface ChartMarker {
		x: number;
		v: number;
		side: 1 | -1;
		color: string;
		text: string;
	}
</script>

<script lang="ts">
	interface Props {
		x: number[];
		series: ChartSeries[];
		xDomain?: [number, number];
		xLog?: boolean;
		tickS?: number;
		yLabel?: string;
		xLabel?: string;
		title?: string;
		height?: number;
		markers?: ChartMarker[];
		shade?: [number, number][];
		sections?: { name: string; a: number; b: number }[];
		/** mean ± k·σ; null entries (non-finite values from the server) leave a gap. */
		band?: { mu: (number | null)[]; sd: (number | null)[]; k: number } | null;
		legend?: boolean;
		/** Label of the series to highlight; the others are dimmed and it is drawn on top. */
		focus?: string | null;
		/** Hover crosshair + a tooltip listing every series' value at that x. */
		tooltip?: boolean;
		/** Value format for the tooltip. */
		fmt?: (v: number) => string;
	}

	let {
		x,
		series,
		xDomain,
		xLog = false,
		tickS = 10,
		yLabel = '',
		xLabel = '',
		title = '',
		height = 380,
		markers = [],
		shade = [],
		sections = [],
		band = null,
		legend = true,
		focus = null,
		tooltip = false,
		fmt = (v: number) => String(Math.round(v * 10) / 10)
	}: Props = $props();

	/** Focused series last so it is drawn over the others. */
	const drawOrder = $derived(
		focus && series.some((s) => s.label === focus) ? [...series.filter((s) => s.label !== focus), ...series.filter((s) => s.label === focus)] : series
	);

	// ── hover ────────────────────────────────────────────────────────────
	let svgEl = $state<SVGSVGElement | null>(null);
	let hoverI = $state<number | null>(null);
	let tipPos = $state({ left: 0, top: 0 });

	function onMove(ev: PointerEvent) {
		if (!svgEl || !x.length) return;
		const r = svgEl.getBoundingClientRect();
		const px = ((ev.clientX - r.left) / r.width) * W;
		if (px < pad.left || px > W - pad.right) {
			hoverI = null;
			return;
		}
		// Nearest x by screen distance (x is monotonic on every sonic chart; a linear scan is fine at ~500 points).
		let best = -1;
		let bestD = Infinity;
		x.forEach((xi, i) => {
			if (!okX(xi)) return;
			const d = Math.abs(geo.sx(xi) - px);
			if (d < bestD) {
				bestD = d;
				best = i;
			}
		});
		hoverI = best >= 0 ? best : null;
		const host = svgEl.parentElement!.getBoundingClientRect();
		let left = ev.clientX - host.left + 14;
		if (left + 200 > host.width) left = ev.clientX - host.left - 214;
		tipPos = { left: Math.max(0, left), top: Math.max(0, ev.clientY - host.top - 20) };
	}

	const tipRows = $derived(
		hoverI == null
			? []
			: series
					.map((s) => ({ label: s.label, color: s.color, v: s.values[hoverI!] }))
					.filter((r): r is { label: string; color: string; v: number } => fin(r.v))
					.sort((a, b) => b.v - a.v)
	);

	const W = 1200;
	const pad = { top: 28, right: 20, bottom: 42, left: 62 };

	const fin = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

	/** Loop-based min/max: long envelopes (10k+ points) must not go through Math.min(...spread). */
	function extent(vals: Iterable<number>): [number, number] | null {
		let lo = Infinity;
		let hi = -Infinity;
		for (const v of vals) {
			if (v < lo) lo = v;
			if (v > hi) hi = v;
		}
		return lo <= hi ? [lo, hi] : null;
	}

	const geo = $derived.by(() => {
		const H = height;
		const innerW = W - pad.left - pad.right;
		const innerH = H - pad.top - pad.bottom;
		// x domain: explicit if finite, else the data's. A log axis needs a positive start.
		const xsOk = x.filter((v) => fin(v) && (!xLog || v > 0));
		let [x0, x1]: [number, number] = xDomain && fin(xDomain[0]) && fin(xDomain[1]) ? [xDomain[0], xDomain[1]] : (extent(xsOk) ?? [0, 1]);
		if (x1 < x0) [x0, x1] = [x1, x0];
		if (xLog) {
			if (x0 <= 0) x0 = extent(xsOk)?.[0] ?? 1;
			if (x1 <= x0) x1 = x0 * 10;
		}
		const lx = (v: number) => (xLog ? Math.log10(Math.max(v, 1e-9)) : v);
		const xSpan = lx(x1) - lx(x0) || 1;
		const sx = (v: number) => pad.left + ((lx(v) - lx(x0)) / xSpan) * innerW;
		const ys: number[] = [];
		for (const s of series) for (const v of s.values) if (fin(v)) ys.push(v);
		if (band) {
			band.mu.forEach((m, i) => {
				const sd = band.sd[i];
				if (fin(m) && fin(sd)) ys.push(m - band.k * sd, m + band.k * sd);
			});
		}
		for (const m of markers) if (fin(m.v)) ys.push(m.v);
		let [y0, y1] = extent(ys) ?? [0, 1];
		const span = y1 - y0 || Math.abs(y0) * 0.1 || 1;
		if (y1 === y0) {
			// Flat data (one point, or a constant): centre it instead of pinning it to an edge.
			y0 -= span / 2;
			y1 += span / 2;
		}
		// Head-room for the stacked value labels above peaks / below valleys.
		y0 -= span * (markers.some((m) => m.side < 0) ? 0.22 : 0.06);
		y1 += span * (markers.some((m) => m.side > 0) ? 0.28 : 0.06);
		const sy = (v: number) => pad.top + (1 - (v - y0) / (y1 - y0)) * innerH;
		return { H, innerW, innerH, x0, x1, sx, sy, y0, y1 };
	});

	/** An x is drawable when finite (and positive on a log axis). */
	const okX = (v: number | undefined): v is number => fin(v) && (!xLog || v > 0);

	function path(values: (number | null)[]): string {
		const { sx, sy } = geo;
		let d = '';
		let pen = false;
		values.forEach((v, i) => {
			const xi = x[i];
			if (!fin(v) || !okX(xi)) {
				pen = false;
				return;
			}
			d += `${pen ? 'L' : 'M'}${sx(xi).toFixed(1)},${sy(v).toFixed(1)}`;
			pen = true;
		});
		return d;
	}

	/** One closed polygon per unbroken run of finite mean/σ — a gap splits the band. */
	const bandPath = $derived.by(() => {
		if (!band) return '';
		const { sx, sy } = geo;
		const out: string[] = [];
		let up: string[] = [];
		let dn: string[] = [];
		const flush = () => {
			if (up.length > 1) out.push(`M${up.join('L')}L${dn.reverse().join('L')}Z`);
			up = [];
			dn = [];
		};
		band.mu.forEach((m, i) => {
			const sd = band.sd[i];
			const xi = x[i];
			if (!fin(m) || !fin(sd) || !okX(xi)) {
				flush();
				return;
			}
			up.push(`${sx(xi).toFixed(1)},${sy(m + band.k * sd).toFixed(1)}`);
			dn.push(`${sx(xi).toFixed(1)},${sy(m - band.k * sd).toFixed(1)}`);
		});
		flush();
		return out.join('');
	});

	const xTicks = $derived.by(() => {
		const { x0, x1, innerW } = geo;
		if (xLog) return [100, 200, 500, 1000, 2000, 5000, 10000].filter((v) => v >= x0 && v <= x1).map((v) => ({ v, label: true }));
		const step = fin(tickS) && tickS > 0 ? tickS : 10;
		const n = Math.floor((x1 - x0) / step);
		if (!(n >= 0) || n > 1000) return [];
		// A grid line on every tick; labels thinned so they never overlap (~28 px apart).
		const every = Math.max(1, Math.ceil(28 / ((step / (x1 - x0 || 1)) * innerW)));
		const out: { v: number; label: boolean }[] = [];
		for (let k = Math.ceil(x0 / step - 1e-9); k * step <= x1 + 1e-9; k++) out.push({ v: Math.round(k * step * 1e6) / 1e6, label: k % every === 0 });
		return out;
	});

	const yTicks = $derived.by(() => {
		const { y0, y1 } = geo;
		const raw = (y1 - y0) / 5;
		if (!fin(raw) || raw <= 0) return [];
		const mag = 10 ** Math.floor(Math.log10(raw));
		const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
		const dec = Math.min(Math.max(0, -Math.floor(Math.log10(step))), 10);
		const out: number[] = [];
		for (let k = Math.ceil(y0 / step); k * step <= y1; k++) out.push(Number((k * step).toFixed(dec)));
		return out;
	});

	/** Shaded stretches clipped to the plotted domain. */
	const shadeRects = $derived.by(() => {
		const { x0, x1, sx } = geo;
		return shade.flatMap(([a, b]) => {
			if (!fin(a) || !fin(b)) return [];
			const l = Math.max(Math.min(a, b), x0);
			const r = Math.min(Math.max(a, b), x1);
			if (r <= l) return [];
			return [{ x: sx(l), w: Math.max(sx(r) - sx(l), 1) }];
		});
	});

	const shownSections = $derived(sections.filter((s) => fin(s.a) && fin(s.b)));

	/** Value labels: each box moves further out until it overlaps no earlier box, and stays inside the SVG. */
	const placed = $derived.by(() => {
		const { sx, sy, x0, x1, H } = geo;
		const boxes: { l: number; r: number; t: number; b: number }[] = [];
		return markers
			.filter((m) => fin(m.v) && okX(m.x) && m.x >= x0 && m.x <= x1)
			.sort((a, b) => a.x - b.x)
			.map((m) => {
				const px = sx(m.x);
				const py = sy(m.v);
				const lines = m.text.split('\n');
				const boxH = 11 * lines.length + 4;
				const boxW = Math.max(...lines.map((l) => l.length)) * 6.2 + 8;
				const cx = Math.min(Math.max(px, boxW / 2 + 2), W - boxW / 2 - 2);
				const l = cx - boxW / 2;
				const r = cx + boxW / 2;
				let level = 0;
				let ty = 0;
				for (; level < 8; level++) {
					const off = 14 + (boxH + 3) * level;
					ty = Math.min(Math.max(m.side > 0 ? py - off - boxH : py + off, 2), H - boxH - 2);
					if (!boxes.some((b) => l < b.r + 2 && r > b.l - 2 && ty < b.b + 2 && ty + boxH > b.t - 2)) break;
				}
				boxes.push({ l, r, t: ty, b: ty + boxH });
				return { ...m, px, py, cx, lines, level, ty, boxH, boxW };
			});
	});

	const ariaLabel = $derived(title || yLabel || 'Sonic chart');
</script>

<div class="w-full">
	{#if title}<div class="tron-text-primary mb-1 text-sm font-semibold">{title}</div>{/if}
	<div class="relative w-full overflow-x-auto">
		<svg
			bind:this={svgEl}
			onpointermove={tooltip ? onMove : undefined}
			onpointerleave={tooltip ? () => (hoverI = null) : undefined}
			viewBox="0 0 {W} {geo.H}" class="w-full rounded bg-[var(--color-tron-bg-tertiary)]" style="min-width: 640px" preserveAspectRatio="xMidYMid meet" role="img" aria-label={ariaLabel}>
			<title>{ariaLabel}</title>
			<!-- running stretches -->
			{#each shadeRects as r, i (i)}
				<rect x={r.x} y={pad.top} width={r.w} height={geo.innerH} fill="var(--color-tron-text-secondary)" opacity="0.08" />
			{/each}
			<!-- grid -->
			{#each xTicks as t, i (i)}
				<line x1={geo.sx(t.v)} x2={geo.sx(t.v)} y1={pad.top} y2={pad.top + geo.innerH} stroke="var(--color-tron-border)" stroke-width="1" opacity="0.6" />
				{#if t.label}
					<text x={geo.sx(t.v)} y={geo.H - pad.bottom + 15} text-anchor="middle" font-size="11" fill="var(--color-tron-text-secondary)">{xLog ? (t.v >= 1000 ? `${t.v / 1000}k` : t.v) : t.v}</text>
				{/if}
			{/each}
			{#each yTicks as v, i (i)}
				<line x1={pad.left} x2={W - pad.right} y1={geo.sy(v)} y2={geo.sy(v)} stroke="var(--color-tron-border)" stroke-dasharray="2,3" opacity="0.5" />
				<text x={pad.left - 6} y={geo.sy(v)} text-anchor="end" dominant-baseline="middle" font-size="11" fill="var(--color-tron-text-secondary)">{v}</text>
			{/each}
			<!-- section labels -->
			{#each shownSections as s, i (i)}
				<text x={(geo.sx(s.a) + geo.sx(s.b)) / 2} y={pad.top - 8} text-anchor="middle" font-size="11" font-weight="bold" fill="var(--color-tron-text-secondary)">{s.name}</text>
				<line x1={geo.sx(s.a)} x2={geo.sx(s.a)} y1={pad.top - 4} y2={pad.top} stroke="var(--color-tron-text-secondary)" />
			{/each}
			<!-- axes -->
			<line x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + geo.innerH} stroke="var(--color-tron-text-secondary)" />
			<line x1={pad.left} y1={pad.top + geo.innerH} x2={W - pad.right} y2={pad.top + geo.innerH} stroke="var(--color-tron-text-secondary)" />
			{#if yLabel}
				<text transform="translate(16 {pad.top + geo.innerH / 2}) rotate(-90)" text-anchor="middle" font-size="12" fill="var(--color-tron-text-secondary)">{yLabel}</text>
			{/if}
			{#if xLabel}
				<text x={pad.left + geo.innerW / 2} y={geo.H - 6} text-anchor="middle" font-size="12" fill="var(--color-tron-text-secondary)">{xLabel}</text>
			{/if}
			<!-- band -->
			{#if band}
				<path d={bandPath} fill="var(--color-tron-text-secondary)" opacity="0.22" />
				<path d={path(band.mu)} fill="none" stroke="var(--color-tron-text-primary)" stroke-width="1.5" stroke-dasharray="6,4" />
			{/if}
			<!-- series -->
			{#each drawOrder as s, i (i)}
				<path
					d={path(s.values)}
					fill="none"
					stroke={s.color}
					stroke-width={focus === s.label ? (s.width ?? 1.8) + 1.6 : (s.width ?? 1.8)}
					opacity={focus && focus !== s.label ? 0.15 : 1}
					stroke-dasharray={s.dashed ? '6,4' : undefined}
					stroke-linejoin="round"
				/>
			{/each}
			{#if hoverI != null && okX(x[hoverI])}
				<line x1={geo.sx(x[hoverI])} x2={geo.sx(x[hoverI])} y1={pad.top} y2={pad.top + geo.innerH} stroke="var(--color-tron-text-primary)" stroke-dasharray="2,3" opacity="0.6" />
			{/if}
			<!-- markers + labels -->
			{#each placed as m, i (i)}
				{#if m.level > 0 || Math.abs(m.cx - m.px) > 1}
					<line x1={m.px} y1={m.py} x2={m.cx} y2={m.side > 0 ? m.ty + m.boxH : m.ty} stroke={m.color} stroke-width="0.8" />
				{/if}
				<path d={m.side > 0 ? `M${m.px - 6},${m.py + 5}L${m.px + 6},${m.py + 5}L${m.px},${m.py - 6}Z` : `M${m.px - 6},${m.py - 5}L${m.px + 6},${m.py - 5}L${m.px},${m.py + 6}Z`} fill={m.color} stroke="black" stroke-width="0.6" />
				<rect x={m.cx - m.boxW / 2} y={m.ty} width={m.boxW} height={m.boxH} rx="3" fill="var(--color-tron-bg-primary)" stroke={m.color} stroke-width="0.8" opacity="0.92" />
				{#each m.lines as line, j (j)}
					<text x={m.cx} y={m.ty + 12 + 11 * j} text-anchor="middle" font-size="10.5" font-weight="bold" fill={m.color}>{line}</text>
				{/each}
			{/each}
		</svg>
		{#if tooltip && hoverI != null}
			<div
				class="pointer-events-none absolute z-10 min-w-[170px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 font-mono text-xs shadow-lg"
				style="left: {tipPos.left}px; top: {tipPos.top}px"
			>
				<div class="tron-text-muted mb-1">{xLog ? `${Math.round(x[hoverI])} Hz` : `${x[hoverI].toFixed(1)} s`}</div>
				{#each tipRows as r (r.label)}
					<div class="flex justify-between gap-3" style={focus && focus !== r.label ? 'opacity: 0.45' : ''}>
						<span><span class="mr-1.5 inline-block h-2 w-2 rounded-full" style="background: {r.color}"></span>{r.label}</span><span>{fmt(r.v)}</span>
					</div>
				{:else}
					<div class="tron-text-muted">nothing running</div>
				{/each}
			</div>
		{/if}
	</div>
	{#if legend && series.length}
		<div class="mt-2 flex flex-wrap justify-center gap-x-5 gap-y-1 text-xs">
			{#each series as s, i (i)}
				<span class="inline-flex items-center gap-1.5"><span class="inline-block h-1 w-6 rounded" style="background: {s.color}"></span><span class="tron-text-primary">{s.label}</span></span>
			{/each}
			{#if band}<span class="inline-flex items-center gap-1.5"><span class="inline-block h-3 w-6 rounded bg-[var(--color-tron-text-secondary)] opacity-40"></span><span class="tron-text-muted">mean ±{band.k}σ</span></span>{/if}
		</div>
	{/if}
</div>
