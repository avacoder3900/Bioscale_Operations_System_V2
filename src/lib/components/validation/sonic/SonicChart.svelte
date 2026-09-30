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
		band?: { mu: number[]; sd: number[]; k: number } | null;
		legend?: boolean;
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
		legend = true
	}: Props = $props();

	const W = 1200;
	const pad = { top: 28, right: 20, bottom: 42, left: 62 };

	const geo = $derived.by(() => {
		const H = height;
		const innerW = W - pad.left - pad.right;
		const innerH = H - pad.top - pad.bottom;
		const [x0, x1] = xDomain ?? [Math.min(...x), Math.max(...x)];
		const lx = (v: number) => (xLog ? Math.log10(Math.max(v, 1e-9)) : v);
		const sx = (v: number) => pad.left + ((lx(v) - lx(x0)) / (lx(x1) - lx(x0) || 1)) * innerW;
		const ys: number[] = [];
		for (const s of series) for (const v of s.values) if (v != null && Number.isFinite(v)) ys.push(v);
		if (band) band.mu.forEach((m, i) => ys.push(m - band.k * band.sd[i], m + band.k * band.sd[i]));
		for (const m of markers) ys.push(m.v);
		let y0 = ys.length ? Math.min(...ys) : 0;
		let y1 = ys.length ? Math.max(...ys) : 1;
		const span = y1 - y0 || 1;
		// Head-room for the stacked value labels above peaks / below valleys.
		y0 -= span * (markers.some((m) => m.side < 0) ? 0.22 : 0.06);
		y1 += span * (markers.some((m) => m.side > 0) ? 0.28 : 0.06);
		const sy = (v: number) => pad.top + (1 - (v - y0) / (y1 - y0)) * innerH;
		return { H, innerW, innerH, x0, x1, sx, sy, y0, y1 };
	});

	function path(values: (number | null)[]): string {
		const { sx, sy } = geo;
		let d = '';
		let pen = false;
		values.forEach((v, i) => {
			if (v == null || !Number.isFinite(v)) {
				pen = false;
				return;
			}
			d += `${pen ? 'L' : 'M'}${sx(x[i]).toFixed(1)},${sy(v).toFixed(1)}`;
			pen = true;
		});
		return d;
	}

	const bandPath = $derived.by(() => {
		if (!band) return '';
		const { sx, sy } = geo;
		const up = band.mu.map((m, i) => `${sx(x[i]).toFixed(1)},${sy(m + band.k * band.sd[i]).toFixed(1)}`);
		const dn = band.mu.map((m, i) => `${sx(x[i]).toFixed(1)},${sy(m - band.k * band.sd[i]).toFixed(1)}`).reverse();
		return `M${up.join('L')}L${dn.join('L')}Z`;
	});

	const xTicks = $derived.by(() => {
		const { x0, x1 } = geo;
		if (xLog) return [100, 200, 500, 1000, 2000, 5000, 10000].filter((v) => v >= x0 && v <= x1);
		const out: number[] = [];
		for (let v = Math.ceil(x0 / tickS) * tickS; v <= x1; v += tickS) out.push(v);
		return out;
	});

	const yTicks = $derived.by(() => {
		const { y0, y1 } = geo;
		const raw = (y1 - y0) / 5;
		const mag = 10 ** Math.floor(Math.log10(raw));
		const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
		const out: number[] = [];
		for (let v = Math.ceil(y0 / step) * step; v <= y1; v += step) out.push(Math.round(v * 1000) / 1000);
		return out;
	});

	/** Stack labels that would collide (same side, close in x and y) further out. */
	const placed = $derived.by(() => {
		const { sx, sy, innerH } = geo;
		const done: { px: number; py: number; side: number; level: number }[] = [];
		return [...markers]
			.sort((a, b) => a.x - b.x)
			.map((m) => {
				const px = sx(m.x);
				const py = sy(m.v);
				const lines = m.text.split('\n');
				let level = 0;
				while (done.some((d) => Math.abs(d.px - px) < 70 && d.side === m.side && Math.abs(d.py - py) < innerH * 0.3 && d.level === level)) level++;
				done.push({ px, py, side: m.side, level });
				const step = 14 + 11 * (lines.length - 1);
				const off = m.side * (14 + step * level);
				const boxH = 11 * lines.length + 4;
				const ty = m.side > 0 ? py - off - boxH : py - off;
				return { ...m, px, py, lines, level, ty, boxH, boxW: Math.max(...lines.map((l) => l.length)) * 6.2 + 8 };
			});
	});
</script>

<div class="w-full">
	{#if title}<div class="tron-text-primary mb-1 text-sm font-semibold">{title}</div>{/if}
	<div class="w-full overflow-x-auto">
		<svg viewBox="0 0 {W} {geo.H}" class="w-full rounded bg-[var(--color-tron-bg-tertiary)]" style="min-width: 640px" preserveAspectRatio="xMidYMid meet" role="img" aria-label={title || yLabel}>
			<!-- running stretches -->
			{#each shade as [a, b], i (i)}
				<rect x={geo.sx(a)} y={pad.top} width={Math.max(geo.sx(b) - geo.sx(a), 1)} height={geo.innerH} fill="var(--color-tron-text-secondary)" opacity="0.08" />
			{/each}
			<!-- grid -->
			{#each xTicks as v (v)}
				<line x1={geo.sx(v)} x2={geo.sx(v)} y1={pad.top} y2={pad.top + geo.innerH} stroke="var(--color-tron-border)" stroke-width="1" opacity="0.6" />
				<text x={geo.sx(v)} y={geo.H - pad.bottom + 15} text-anchor="middle" font-size="11" fill="var(--color-tron-text-secondary)">{xLog ? (v >= 1000 ? `${v / 1000}k` : v) : v}</text>
			{/each}
			{#each yTicks as v (v)}
				<line x1={pad.left} x2={W - pad.right} y1={geo.sy(v)} y2={geo.sy(v)} stroke="var(--color-tron-border)" stroke-dasharray="2,3" opacity="0.5" />
				<text x={pad.left - 6} y={geo.sy(v)} text-anchor="end" dominant-baseline="middle" font-size="11" fill="var(--color-tron-text-secondary)">{v}</text>
			{/each}
			<!-- section labels -->
			{#each sections as s (s.name)}
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
			{#each series as s, i (i)}
				<path d={path(s.values)} fill="none" stroke={s.color} stroke-width={s.width ?? 1.8} stroke-dasharray={s.dashed ? '6,4' : undefined} stroke-linejoin="round" />
			{/each}
			<!-- markers + labels -->
			{#each placed as m, i (i)}
				{#if m.level > 0}
					<line x1={m.px} y1={m.py} x2={m.px} y2={m.side > 0 ? m.ty + m.boxH : m.ty} stroke={m.color} stroke-width="0.8" />
				{/if}
				<path d={m.side > 0 ? `M${m.px - 6},${m.py + 5}L${m.px + 6},${m.py + 5}L${m.px},${m.py - 6}Z` : `M${m.px - 6},${m.py - 5}L${m.px + 6},${m.py - 5}L${m.px},${m.py + 6}Z`} fill={m.color} stroke="black" stroke-width="0.6" />
				<rect x={m.px - m.boxW / 2} y={m.ty} width={m.boxW} height={m.boxH} rx="3" fill="var(--color-tron-bg-primary)" stroke={m.color} stroke-width="0.8" opacity="0.92" />
				{#each m.lines as line, j (j)}
					<text x={m.px} y={m.ty + 12 + 11 * j} text-anchor="middle" font-size="10.5" font-weight="bold" fill={m.color}>{line}</text>
				{/each}
			{/each}
		</svg>
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
