<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import GroupPill from '$lib/components/validation/optical/GroupPill.svelte';
	import OutlierMark from '$lib/components/validation/optical/OutlierMark.svelte';

	// Mirrors the reportGroup contract from $lib/server/optical-analysis, kept inline
	// so this client component never imports a server-only module. Same convention as
	// the analyze page.
	type Chan = 'A' | 'B' | 'C';

	interface RobustStat {
		n: number;
		mean: number | null;
		sd: number | null;
		cv: number | null;
		median: number | null;
		mad: number | null;
		madScaled: number | null;
		q1: number | null;
		q3: number | null;
		min: number | null;
		max: number | null;
		scale: number | null;
		scaleEstimator: 'mad' | 'iqr' | 'sd' | 'none';
		robustCv: number | null;
		robustLow: number | null;
		robustHigh: number | null;
		degenerate: boolean;
	}
	interface ReportRow {
		id: string;
		label: string;
		spuUdi: string | null;
		ratioByChannel: Record<Chan, number | null>;
		overallRatio: number | null;
		wellsUsed: number;
		hasReadings: boolean;
		cartridgeWarning: boolean;
		outlierChannels: Chan[];
		outlierReasons: Record<Chan, string | null>;
	}
	interface Report {
		groupId: string;
		groupName: string;
		n: number;
		windowK: number;
		overall: RobustStat;
		wells: Array<{ channel: Chan } & RobustStat>;
		rows: ReportRow[];
		excluded: Array<{ id: string; label: string; groupName: string; reason: string }>;
		flags: string[];
	}

	interface Props {
		data: {
			group: {
				_id: string;
				name: string;
				description: string | null;
				color: string;
				createdAt: string | null;
				memberCount: number;
			};
			report: Report;
			runDates: Record<string, string | null>;
			missingIds: string[];
			truncated: boolean;
			cap: number;
		};
	}
	let { data }: Props = $props();

	const CHANNELS: Chan[] = ['A', 'B', 'C'];
	const report = $derived(data.report);
	const rows = $derived(report.rows);
	const totals = $derived(report.overall);

	// ---- replicates stacked per device (2026-09-10, per Jacob) -----------------
	// A fleet batch runs N carts on every unit; reading them as one flat list hides
	// the question that matters — do a unit's replicates agree? Rows are grouped
	// under one header per SPU with the device's replicate mean per channel, the
	// overall mean, and the replicate spread (max − min of the overall ratios).
	interface DeviceBlock {
		udi: string | null;
		rows: ReportRow[];
		n: number;
		meanByChannel: Record<Chan, number | null>;
		mean: number | null;
		spread: number | null;
	}
	function meanOf(vals: Array<number | null | undefined>): number | null {
		const xs = vals.filter((v): v is number => v != null && Number.isFinite(v));
		return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
	}
	const blocks = $derived.by((): DeviceBlock[] => {
		const byUdi = new Map<string | null, ReportRow[]>();
		for (const r of rows) {
			const k = r.spuUdi ?? null;
			if (!byUdi.has(k)) byUdi.set(k, []);
			byUdi.get(k)!.push(r);
		}
		const out: DeviceBlock[] = [];
		for (const [udi, rs] of byUdi) {
			rs.sort((a, b) => (data.runDates[a.id] ?? '').localeCompare(data.runDates[b.id] ?? ''));
			const overalls = rs.map((r) => r.overallRatio).filter((v): v is number => v != null);
			out.push({
				udi,
				rows: rs,
				n: overalls.length,
				meanByChannel: {
					A: meanOf(rs.map((r) => r.ratioByChannel.A)),
					B: meanOf(rs.map((r) => r.ratioByChannel.B)),
					C: meanOf(rs.map((r) => r.ratioByChannel.C))
				},
				mean: meanOf(overalls),
				spread: overalls.length >= 2 ? Math.max(...overalls) - Math.min(...overalls) : null
			});
		}
		// By unit number; cartridges that never ran (no device) sink to the bottom.
		out.sort((a, b) => (a.udi ?? '\uffff').localeCompare(b.udi ?? '\uffff'));
		return out;
	});

	// ---- view controls ---------------------------------------------------------
	/** Show the individual replicate rows under each device header, or just the device averages. */
	let showReplicates = $state(true);

	// Devices excluded from the device-level fit below. Non-destructive: the group
	// itself is untouched (use Remove on a cartridge row for that). Remembered per
	// group in this browser so a curated view survives a reload.
	const EXCL_KEY = $derived(`optical-group-excluded:${data.group._id}`);
	let excluded = $state<string[]>([]);
	$effect(() => {
		excluded = readExcluded(EXCL_KEY);
	});
	function readExcluded(key: string): string[] {
		try {
			const raw = localStorage.getItem(key);
			const arr = raw ? JSON.parse(raw) : [];
			return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
		} catch {
			return [];
		}
	}
	function toggleExcluded(udi: string) {
		excluded = excluded.includes(udi) ? excluded.filter((u) => u !== udi) : [...excluded, udi];
		try {
			localStorage.setItem(EXCL_KEY, JSON.stringify(excluded));
		} catch {
			// Session-only if storage is unavailable.
		}
	}
	const isExcluded = (udi: string | null) => udi != null && excluded.includes(udi);

	// ---- device-level Gaussian fit (2026-09-10, per Jacob) ------------------------
	// Each included device contributes three independent points: its replicate-mean
	// A, B and C. A normal distribution is fitted to those points (sample mean and
	// sd) and drawn with its ±1σ/±2σ/±3σ cutoffs, so the acceptance bounds the data
	// itself implies are visible. Recomputed on every exclusion click.
	interface FitPoint {
		udi: string;
		channel: Chan;
		value: number;
		z: number;
	}
	const CHANNEL_COLOR: Record<Chan, string> = {
		A: 'var(--color-tron-cyan)',
		B: 'var(--color-tron-orange)',
		C: 'var(--color-tron-purple)'
	};
	const includedBlocks = $derived(blocks.filter((b) => b.udi && !isExcluded(b.udi)));
	const fit = $derived.by(() => {
		const raw: Array<{ udi: string; channel: Chan; value: number }> = [];
		for (const b of includedBlocks) {
			for (const c of CHANNELS) {
				const v = b.meanByChannel[c];
				if (v != null && Number.isFinite(v)) raw.push({ udi: b.udi!, channel: c, value: v });
			}
		}
		const n = raw.length;
		const mean = n ? raw.reduce((a, p) => a + p.value, 0) / n : null;
		const sd =
			n >= 2 && mean != null
				? Math.sqrt(raw.reduce((a, p) => a + (p.value - mean) ** 2, 0) / (n - 1))
				: null;
		const points: FitPoint[] = raw.map((p) => ({
			...p,
			z: mean != null && sd ? (p.value - mean) / sd : 0
		}));
		const byChannel = Object.fromEntries(
			CHANNELS.map((c) => {
				const xs = raw.filter((p) => p.channel === c).map((p) => p.value);
				const m = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
				const s =
					xs.length >= 2 && m != null
						? Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
						: null;
				return [c, { n: xs.length, mean: m, sd: s }];
			})
		) as Record<Chan, { n: number; mean: number | null; sd: number | null }>;
		return {
			n,
			devices: includedBlocks.length,
			mean,
			sd,
			cv: mean && sd ? (sd / mean) * 100 : null,
			points,
			byChannel,
			outside2: points.filter((p) => Math.abs(p.z) > 2).sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
		};
	});

	// ---- chart geometry (inline SVG, no library) ----------------------------------
	const CW = 760;
	const CH = 300;
	const PAD = { l: 44, r: 20, t: 34, b: 40 };
	const PW = CW - PAD.l - PAD.r;
	const PH = CH - PAD.t - PAD.b;
	const chart = $derived.by(() => {
		const { mean, sd, points } = fit;
		if (mean == null || !sd || points.length < 3) return null;
		const vals = points.map((p) => p.value);
		const rawLo = Math.min(mean - 3.5 * sd, ...vals);
		const rawHi = Math.max(mean + 3.5 * sd, ...vals);
		const padding = (rawHi - rawLo || 1) * 0.04;
		const lo = rawLo - padding;
		const hi = rawHi + padding;
		const span = hi - lo || 1;
		const x = (v: number) => PAD.l + ((v - lo) / span) * PW;
		const pdf = (v: number) => Math.exp(-0.5 * ((v - mean) / sd) ** 2) / (sd * Math.sqrt(2 * Math.PI));
		const peak = pdf(mean);
		const y = (d: number) => PAD.t + PH - (d / peak) * PH;
		const curve: string[] = [];
		for (let i = 0; i <= 120; i++) {
			const v = lo + (span * i) / 120;
			curve.push(`${x(v).toFixed(1)},${y(pdf(v)).toFixed(1)}`);
		}
		const sigmaLines = [-3, -2, -1, 0, 1, 2, 3].map((k) => ({
			k,
			v: mean + k * sd,
			x: x(mean + k * sd)
		})).filter((l) => l.v >= lo && l.v <= hi);
		const ticks = Array.from({ length: 6 }, (_, i) => lo + (span * i) / 5).map((v) => ({ v, x: x(v) }));
		return {
			lo,
			hi,
			curve: curve.join(' '),
			sigmaLines,
			ticks,
			dots: points.map((p) => ({ ...p, cx: x(p.value), cy: y(pdf(p.value)) }))
		};
	});
	let hovered = $state<FitPoint | null>(null);

	// The shipped cvThreshold default. Classic CV is outlier-sensitive and this view
	// leads with it deliberately — the median column beside it is the skew check.
	const CV_WARN = 15;

	// ---- formatting ----------------------------------------------------------
	function fmt(v: number | null | undefined, dp = 2): string {
		return v == null ? '—' : v.toFixed(dp);
	}
	function pct(v: number | null | undefined, dp = 1): string {
		return v == null ? '—' : `${v.toFixed(dp)}%`;
	}
	function shortDate(iso: string | null | undefined): string {
		return iso ? new Date(iso).toLocaleDateString() : '—';
	}

	// ---- remove from group (VALIDATION-06-S6) --------------------------------
	// Posts to the shipped action on the log route rather than re-implementing it, so
	// the $pull and its AuditLog row keep exactly one implementation.
	let removingId = $state<string | null>(null);
	let removeError = $state<string | null>(null);
	let removedNote = $state<string | null>(null);
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<a
			href="/validation/optical-confirmation/groups"
			class="text-sm text-[var(--color-tron-cyan)] hover:underline"
		>
			← Back to Groups
		</a>
		<div class="mt-1 flex flex-wrap items-center gap-3">
			<h1 class="tron-heading text-2xl font-bold">{data.group.name}</h1>
			<GroupPill name={data.group.name} color={data.group.color} count={data.group.memberCount} />
		</div>
		{#if data.group.description}
			<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">{data.group.description}</p>
		{/if}
		<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
			Created {shortDate(data.group.createdAt)} ·
			<a
				href={'/validation/optical-confirmation/analyze?groups=' + data.group._id}
				class="text-[var(--color-tron-cyan)] hover:underline"
			>
				Open in group comparison
			</a>
		</p>
	</div>

	{#if data.truncated}
		<div
			class="rounded-lg bg-[var(--color-tron-orange)]/10 p-3 text-sm text-[var(--color-tron-orange)]"
		>
			⚠ This group holds {data.group.memberCount} cartridges, above the {data.cap}-cartridge analysis
			cap, so only the first {data.cap} were analyzed. Every number below describes that subset, not
			the whole group.
		</div>
	{/if}

	<!-- Raw values: context, not a warning -->
	<div
		class="rounded-lg border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/5 p-3 text-sm text-[var(--color-tron-text-secondary)]"
	>
		Every number on this page is <span class="tron-text-primary font-semibold">raw F7/F3</span>
		(F7 630 nm signal ÷ F3 480 nm reference). No calibration factor is applied anywhere.
	</div>

	{#each report.flags as flag}
		<p class="text-sm text-amber-400">⚠ {flag}</p>
	{/each}

	<!-- Totals -->
	<div class="tron-card p-4">
		<h2 class="tron-heading mb-3 text-sm font-semibold uppercase tracking-wide">Group totals</h2>
		<div class="overflow-x-auto">
			<table class="w-full min-w-[42rem] text-left text-sm">
				<thead class="text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]">
					<tr class="border-b border-[var(--color-tron-border)]">
						<th class="py-2 pr-4 font-medium">n</th>
						<th class="py-2 pr-4 font-medium">Avg F7/F3</th>
						<th class="py-2 pr-4 font-medium">Stdev</th>
						<th class="py-2 pr-4 font-medium">CV %</th>
						<th class="py-2 font-medium">Median</th>
					</tr>
				</thead>
				<tbody class="font-mono">
					<tr>
						<td
							class="py-2 pr-4 text-[var(--color-tron-text-secondary)]"
							title={`${totals.n} of the ${report.n} cartridges analyzed produced an overall F7/F3. The rest are listed as excluded.`}
						>
							{totals.n} / {report.n}
						</td>
						<td class="py-2 pr-4 text-lg font-semibold text-[var(--color-tron-green)]">
							{fmt(totals.mean, 3)}
						</td>
						<td class="py-2 pr-4 text-[var(--color-tron-text-primary)]">{fmt(totals.sd, 3)}</td>
						<td
							class="py-2 pr-4 font-semibold {totals.cv != null && totals.cv > CV_WARN
								? 'text-amber-400'
								: 'text-[var(--color-tron-text-primary)]'}"
							title={`Classic CV = stdev / avg. Above ${CV_WARN}% the spread is worth reading against the median beside it — CV is outlier-sensitive.`}
						>
							{pct(totals.cv)}
						</td>
						<td
							class="py-2 text-[var(--color-tron-cyan)]"
							title="Median of the per-cartridge overall F7/F3. Shown beside the average as a skew check: a large gap between the two means one cartridge is pulling the average."
						>
							{fmt(totals.median, 3)}
						</td>
					</tr>
				</tbody>
			</table>
		</div>
		<p class="mt-3 text-xs text-[var(--color-tron-text-secondary)]">
			Over each cartridge's overall F7/F3 — the mean of its available wells (A/B/C), missing wells
			skipped rather than counted as zero. Endpoint window = the last {report.windowK} readings per
			well.
		</p>
	</div>

	{#if removeError}
		<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-3 text-sm text-[var(--color-tron-red)]">
			{removeError}
		</div>
	{/if}
	{#if removedNote}
		<div
			class="rounded-lg bg-[var(--color-tron-green)]/10 p-3 text-sm text-[var(--color-tron-green)]"
		>
			{removedNote}
		</div>
	{/if}

	<!-- Device-level fit: each device = 3 points (replicate-mean A, B, C) -->
	<div class="tron-card p-4">
		<div class="mb-3 flex flex-wrap items-start justify-between gap-3">
			<div>
				<h2 class="tron-heading text-sm font-semibold uppercase tracking-wide">Device-level fit</h2>
				<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
					One point per channel per device (its replicate mean), a normal distribution fitted to
					those points, and the cutoffs it implies. Excluding a device below recomputes everything here;
					the group totals above are cartridge-level and unaffected.
				</p>
			</div>
			{#if excluded.length}
				<button
					type="button"
					class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text-primary)]"
					onclick={() => { excluded = []; try { localStorage.removeItem(EXCL_KEY); } catch {} }}
				>
					Re-include all ({excluded.length} excluded)
				</button>
			{/if}
		</div>

		<div class="grid gap-3 sm:grid-cols-6">
			<div class="rounded border border-[var(--color-tron-border)] p-2">
				<div class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">Devices</div>
				<div class="font-mono text-lg tron-text-primary">{fit.devices}<span class="text-xs text-[var(--color-tron-text-secondary)]"> / {blocks.filter((b) => b.udi).length}</span></div>
			</div>
			<div class="rounded border border-[var(--color-tron-border)] p-2">
				<div class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">Points</div>
				<div class="font-mono text-lg tron-text-primary">{fit.n}</div>
			</div>
			<div class="rounded border border-[var(--color-tron-border)] p-2">
				<div class="text-[10px] text-[var(--color-tron-text-secondary)]">MEAN μ</div>
				<div class="font-mono text-lg text-[var(--color-tron-green)]">{fmt(fit.mean, 3)}</div>
			</div>
			<div class="rounded border border-[var(--color-tron-border)] p-2">
				<div class="text-[10px] text-[var(--color-tron-text-secondary)]">SD σ</div>
				<div class="font-mono text-lg tron-text-primary">{fmt(fit.sd, 3)}</div>
			</div>
			<div class="rounded border border-[var(--color-tron-border)] p-2">
				<div class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">CV</div>
				<div class="font-mono text-lg {fit.cv != null && fit.cv > CV_WARN ? 'text-amber-400' : 'tron-text-primary'}">{pct(fit.cv)}</div>
			</div>
			<div class="rounded border border-[var(--color-tron-border)] p-2">
				<div class="text-[10px] text-[var(--color-tron-text-secondary)]">OUTSIDE ±2σ</div>
				<div class="font-mono text-lg {fit.outside2.length ? 'text-[var(--color-tron-red)]' : 'tron-text-primary'}">{fit.outside2.length}</div>
			</div>
		</div>

		{#if fit.mean != null && fit.sd}
			<div class="mt-3 grid gap-3 sm:grid-cols-2">
				<table class="text-xs">
					<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
						<tr><th class="pr-4 text-left font-medium">Cutoff</th><th class="pr-4 text-left font-medium">Low</th><th class="text-left font-medium">High</th></tr>
					</thead>
					<tbody class="font-mono tron-text-primary">
						{#each [1, 2, 3] as k}
							<tr>
								<td class="pr-4 text-[var(--color-tron-text-secondary)]">μ ± {k}σ</td>
								<td class="pr-4">{fmt(fit.mean - k * fit.sd, 3)}</td>
								<td>{fmt(fit.mean + k * fit.sd, 3)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<table class="text-xs">
					<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
						<tr><th class="pr-4 text-left font-medium">Channel</th><th class="pr-4 text-left font-medium">n</th><th class="pr-4 text-left font-medium">Mean</th><th class="text-left font-medium">SD</th></tr>
					</thead>
					<tbody class="font-mono tron-text-primary">
						{#each CHANNELS as c}
							<tr>
								<td class="pr-4"><span class="mr-1 inline-block h-2 w-2 rounded-full" style="background: {CHANNEL_COLOR[c]}"></span>{c}</td>
								<td class="pr-4">{fit.byChannel[c].n}</td>
								<td class="pr-4">{fmt(fit.byChannel[c].mean, 3)}</td>
								<td>{fmt(fit.byChannel[c].sd, 3)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		{#if chart}
			<div class="mt-4 overflow-x-auto">
				<svg viewBox="0 0 {CW} {CH}" class="w-full min-w-[40rem]" role="img" aria-label="Fitted normal distribution of device channel means with ±1σ, ±2σ and ±3σ cutoffs">
					<!-- baseline + ticks -->
					<line x1={PAD.l} x2={PAD.l + PW} y1={PAD.t + PH} y2={PAD.t + PH} stroke="var(--color-tron-border)" />
					{#each chart.ticks as t}
						<line x1={t.x} x2={t.x} y1={PAD.t + PH} y2={PAD.t + PH + 4} stroke="var(--color-tron-text-secondary)" />
						<text x={t.x} y={PAD.t + PH + 16} text-anchor="middle" font-size="10" fill="var(--color-tron-text-secondary)" font-family="monospace">{t.v.toFixed(2)}</text>
					{/each}
					<text x={PAD.l + PW / 2} y={CH - 4} text-anchor="middle" font-size="10" fill="var(--color-tron-text-secondary)">Replicate-mean F7/F3 per channel</text>
					<!-- sigma cutoffs -->
					{#each chart.sigmaLines as l}
						<line x1={l.x} x2={l.x} y1={PAD.t} y2={PAD.t + PH}
							stroke={l.k === 0 ? 'var(--color-tron-green)' : Math.abs(l.k) === 2 ? 'var(--color-tron-red)' : 'var(--color-tron-text-secondary)'}
							stroke-width={l.k === 0 ? 1.5 : 1}
							stroke-dasharray={l.k === 0 ? '' : Math.abs(l.k) === 3 ? '2 3' : '5 4'}
							opacity={Math.abs(l.k) === 1 ? 0.35 : 0.8} />
						<text x={l.x} y={PAD.t - 20} text-anchor="middle" font-size="10" fill="var(--color-tron-text-secondary)">{l.k === 0 ? 'μ' : `${l.k > 0 ? '+' : ''}${l.k}σ`}</text>
						<text x={l.x} y={PAD.t - 8} text-anchor="middle" font-size="9" font-family="monospace" fill="var(--color-tron-text-secondary)">{l.v.toFixed(3)}</text>
					{/each}
					<!-- fitted curve -->
					<polyline points={chart.curve} fill="none" stroke="var(--color-tron-text-primary)" stroke-width="2" opacity="0.9" />
					<!-- rug -->
					{#each chart.dots as d}
						<line x1={d.cx} x2={d.cx} y1={PAD.t + PH - 6} y2={PAD.t + PH} stroke={CHANNEL_COLOR[d.channel]} opacity="0.7" />
					{/each}
					<!-- points on the curve: circle=A, square=B, triangle=C; red ring = outside ±2σ -->
					{#each chart.dots as d}
						<g
							role="button"
							tabindex="0"
							onmouseenter={() => (hovered = d)}
							onmouseleave={() => (hovered = null)}
							onfocus={() => (hovered = d)}
							onblur={() => (hovered = null)}
							style="cursor: pointer"
						>
							<circle cx={d.cx} cy={d.cy} r="9" fill="transparent" />
							{#if Math.abs(d.z) > 2}
								<circle cx={d.cx} cy={d.cy} r="8" fill="none" stroke="var(--color-tron-red)" stroke-width="1.5" />
							{/if}
							{#if d.channel === 'A'}
								<circle cx={d.cx} cy={d.cy} r="4.5" fill={CHANNEL_COLOR.A} stroke="var(--color-tron-bg-card)" stroke-width="1.5" />
							{:else if d.channel === 'B'}
								<rect x={d.cx - 4} y={d.cy - 4} width="8" height="8" fill={CHANNEL_COLOR.B} stroke="var(--color-tron-bg-card)" stroke-width="1.5" />
							{:else}
								<polygon points="{d.cx},{d.cy - 5.5} {d.cx + 5},{d.cy + 4} {d.cx - 5},{d.cy + 4}" fill={CHANNEL_COLOR.C} stroke="var(--color-tron-bg-card)" stroke-width="1.5" />
							{/if}
							<title>{d.udi} · {d.channel} · {d.value.toFixed(3)} · z = {d.z.toFixed(2)}</title>
						</g>
					{/each}
				</svg>
			</div>
			<div class="mt-2 flex flex-wrap items-center gap-4 text-xs text-[var(--color-tron-text-secondary)]">
				<span><span class="mr-1 inline-block h-2.5 w-2.5 rounded-full align-middle" style="background: {CHANNEL_COLOR.A}"></span>A (circle)</span>
				<span><span class="mr-1 inline-block h-2.5 w-2.5 align-middle" style="background: {CHANNEL_COLOR.B}"></span>B (square)</span>
				<span><span class="mr-1 inline-block align-middle" style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:9px solid {CHANNEL_COLOR.C}"></span>C (triangle)</span>
				<span><span class="mr-1 inline-block h-2.5 w-2.5 rounded-full border align-middle" style="border-color: var(--color-tron-red)"></span>outside ±2σ</span>
				<span class="font-mono tron-text-primary">
					{#if hovered}{hovered.udi} · {hovered.channel} · {hovered.value.toFixed(3)} · z = {hovered.z.toFixed(2)}{:else}hover a point{/if}
				</span>
			</div>
			{#if fit.outside2.length}
				<div class="mt-3 text-xs">
					<div class="mb-1 text-[10px] text-[var(--color-tron-text-secondary)]">OUTSIDE ±2σ</div>
					<ul class="grid gap-x-6 gap-y-0.5 font-mono sm:grid-cols-2 lg:grid-cols-3">
						{#each fit.outside2 as o (o.udi + o.channel)}
							<li>
								<button type="button" class="text-[var(--color-tron-cyan)] hover:underline" onclick={() => toggleExcluded(o.udi)} title="Exclude this device from the fit">{o.udi}</button>
								<span class="text-[var(--color-tron-text-secondary)]"> {o.channel}</span> {o.value.toFixed(3)}
								<span class="text-[var(--color-tron-red)]"> z {o.z > 0 ? '+' : ''}{o.z.toFixed(2)}</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		{:else}
			<p class="mt-3 text-xs text-[var(--color-tron-text-secondary)]">
				Need at least three channel points across included devices, with some spread, to fit a distribution.
			</p>
		{/if}
	</div>

	<!-- Cartridges -->
	<div class="tron-card p-4">
		<div class="mb-3 flex flex-wrap items-center justify-between gap-3">
			<h2 class="tron-heading text-sm font-semibold uppercase tracking-wide">
				Cartridges ({rows.length}) · {blocks.filter((b) => b.udi).length} devices
			</h2>
			<label class="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-tron-text-secondary)]">
				<span>{showReplicates ? 'Showing replicates' : 'Device averages only'}</span>
				<button
					type="button"
					role="switch"
					aria-checked={showReplicates}
					onclick={() => (showReplicates = !showReplicates)}
					class="relative h-5 w-9 rounded-full transition-colors"
					style="background: {showReplicates ? 'var(--color-tron-cyan)' : 'var(--color-tron-bg-tertiary)'}; border: 1px solid var(--color-tron-border);"
					title="Toggle the individual replicate rows under each device"
				>
					<span class="absolute top-0.5 h-3.5 w-3.5 rounded-full bg-[var(--color-tron-bg-primary)] transition-all" style="left: {showReplicates ? '18px' : '2px'}"></span>
				</button>
			</label>
		</div>

		{#if rows.length === 0}
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				This group has no cartridge records to analyze. Add cartridges from the
				<a
					href="/validation/optical-confirmation"
					class="text-[var(--color-tron-cyan)] hover:underline">optical log</a
				>.
			</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full min-w-[56rem] text-left text-sm">
					<thead class="text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]">
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="py-2 pr-2 font-medium" title="Exclude a device from the device-level fit above (non-destructive)">Excl.</th>
							<th class="py-2 pr-4 font-medium">Barcode</th>
							<th class="py-2 pr-4 font-medium">A</th>
							<th class="py-2 pr-4 font-medium">B</th>
							<th class="py-2 pr-4 font-medium">C</th>
							<th class="py-2 pr-4 font-medium">Overall</th>
							<th class="py-2 pr-4 font-medium">Flags</th>
							<th class="py-2 font-medium"><span class="sr-only">Actions</span></th>
						</tr>
					</thead>
					<tbody class="font-mono">
						{#each blocks as blk (blk.udi ?? '__none__')}
							<!-- Device header: one line per SPU with its replicate means and spread. -->
							<tr class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]/60 {isExcluded(blk.udi) ? 'opacity-40' : ''}">
								<td class="py-2 pr-2 font-sans">
									{#if blk.udi}
										<input
											type="checkbox"
											class="h-4 w-4 cursor-pointer accent-[var(--color-tron-red)]"
											checked={isExcluded(blk.udi)}
											onchange={() => toggleExcluded(blk.udi!)}
											title={isExcluded(blk.udi) ? 'Excluded from the fit — click to re-include' : 'Exclude this device from the fit'}
										/>
									{/if}
								</td>
								<td class="py-2 pr-4 font-sans">
									<span class="font-mono text-sm font-bold text-[var(--color-tron-cyan)]">{blk.udi ?? 'No device (never ran)'}</span>
									<span class="ml-2 text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
										{blk.rows.length} replicate{blk.rows.length === 1 ? '' : 's'}
									</span>
								</td>
								{#each CHANNELS as c}
									<td class="py-2 pr-4 text-xs text-[var(--color-tron-text-secondary)]" title={`Mean ${c} across this unit's replicates`}>
										{fmt(blk.meanByChannel[c])}
									</td>
								{/each}
								<td class="py-2 pr-4 text-sm font-semibold text-[var(--color-tron-green)]" title="Mean of this unit's replicate overall F7/F3">
									{fmt(blk.mean, 3)}
								</td>
								<td class="py-2 pr-4 font-sans text-xs text-[var(--color-tron-text-secondary)]" colspan="2" title="Replicate spread: max − min of the overall F7/F3 across this unit's cartridges">
									{#if blk.spread != null}Δ {fmt(blk.spread, 3)}{:else}—{/if}
								</td>
							</tr>
							{#each showReplicates ? blk.rows : [] as r (r.id)}
							<tr
								class="border-b border-[var(--color-tron-border)]/50 {r.hasReadings
									? ''
									: 'opacity-60'} {isExcluded(blk.udi) ? 'opacity-40' : ''}"
							>
								<td class="py-2 pr-2"></td>
								<td class="py-2 pr-4 pl-6 text-xs">
									<a
										href={'/validation/optical-confirmation/' + r.id}
										class="text-[var(--color-tron-cyan)] hover:underline">{r.label}</a
									>
									<span class="ml-1 text-[10px] text-[var(--color-tron-text-secondary)]">
										{shortDate(data.runDates[r.id])}
									</span>
								</td>
								{#each CHANNELS as c}
									{@const outlier = r.outlierChannels.includes(c)}
									<td
										class="py-2 pr-4 {outlier
											? 'text-amber-400'
											: 'text-[var(--color-tron-text-primary)]'}"
									>
										{fmt(r.ratioByChannel[c])}
										<OutlierMark reason={outlier ? r.outlierReasons[c] : null} />
									</td>
								{/each}
								<td
									class="py-2 pr-4 font-semibold text-[var(--color-tron-green)]"
									title={r.overallRatio == null
										? 'No well on this cartridge produced a usable F7/F3, so it contributes nothing to the totals.'
										: `Mean of ${r.wellsUsed} well${r.wellsUsed === 1 ? '' : 's'} (A/B/C). Wells with no usable ratio are skipped, not counted as zero.`}
								>
									{fmt(r.overallRatio, 3)}
									{#if r.overallRatio != null && r.wellsUsed < 3}
										<span class="ml-1 text-[10px] font-normal text-amber-400">
											{r.wellsUsed} well{r.wellsUsed === 1 ? '' : 's'}
										</span>
									{/if}
								</td>
								<td class="py-2 pr-4 font-sans text-xs">
									{#if !r.hasReadings}
										<span
											class="rounded border border-[var(--color-tron-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)]"
											title="This cartridge has no optical readings — it is listed for completeness but is excluded from every statistic on this page."
											>NO READINGS</span
										>
									{:else if r.cartridgeWarning}
										<span
											class="rounded border border-[var(--color-tron-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)]"
											title="This cartridge's own readings were noisy within the endpoint window. Separate from being an outlier against the group — the ⚠ glyph means that."
										>
											OWN READINGS NOISY
										</span>
									{:else}
										<span class="text-[var(--color-tron-text-secondary)]">—</span>
									{/if}
								</td>
								<td class="py-2 text-right font-sans">
									<form
										method="POST"
										action="/validation/optical-confirmation?/removeFromGroup"
										use:enhance={({ cancel }) => {
											if (
												!confirm(
													`Remove ${r.label} from "${data.group.name}"? The cartridge record itself is untouched.`
												)
											) {
												cancel();
												return;
											}
											removeError = null;
											removedNote = null;
											removingId = r.id;
											return async ({ result }) => {
												removingId = null;
												if (result.type === 'success') {
													removedNote = `Removed ${r.label} from "${data.group.name}".`;
													await invalidateAll();
												} else if (result.type === 'failure') {
													removeError =
														(result.data as { groupError?: string } | undefined)?.groupError ??
														'Could not remove that cartridge.';
												} else if (result.type === 'error') {
													removeError = result.error?.message ?? 'Could not remove that cartridge.';
												}
											};
										}}
									>
										<input type="hidden" name="groupId" value={data.group._id} />
										<input type="hidden" name="cartridgeIds" value={r.id} />
										<button
											type="submit"
											disabled={removingId === r.id}
											class="rounded border border-[var(--color-tron-border)] px-2 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-red)]/60 hover:text-[var(--color-tron-red)] disabled:opacity-50"
											title="Remove this cartridge from the group. The cartridge record is not modified."
										>
											{removingId === r.id ? 'Removing…' : 'Remove'}
										</button>
									</form>
								</td>
							</tr>
							{/each}
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>

	<!-- Excluded -->
	{#if report.excluded.length > 0 || data.missingIds.length > 0}
		<div class="tron-card p-4">
			<h2 class="tron-heading mb-2 text-sm font-semibold uppercase tracking-wide">
				Excluded from the totals ({report.excluded.length + data.missingIds.length})
			</h2>
			<ul class="space-y-1 text-xs text-[var(--color-tron-text-secondary)]">
				{#each report.excluded as e (e.id)}
					<li><span class="font-mono">{e.label}</span> — {e.reason}</li>
				{/each}
				{#each data.missingIds as id (id)}
					<li>
						<span class="font-mono">{id}</span> — no cartridge record exists with this barcode, so it
						could not be analyzed at all.
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	<!-- Legend -->
	<div class="tron-card p-4 text-xs text-[var(--color-tron-text-secondary)]">
		<p class="mb-1">
			<span class="font-semibold text-[var(--color-tron-text-primary)]">Overall</span> is the mean of
			a cartridge's available well ratios (A/B/C). A well with no usable F7/F3 is skipped, never counted
			as zero, so a one-well overall is labelled as such rather than passed off as a three-well number.
		</p>
		<p class="mb-1">
			<span class="text-amber-400">⚠</span> marks a well that is an outlier against this group, with
			the reason on hover. Flagging is disabled below 5 contributing cartridges — a spread estimate
			on 3–4 points is noise, not a spread.
		</p>
		<p>
			All values are raw F7/F3 with no calibration applied, computed over the last {report.windowK} readings
			of each well. Descriptive only — no statistical test is performed.
		</p>
	</div>
</div>
