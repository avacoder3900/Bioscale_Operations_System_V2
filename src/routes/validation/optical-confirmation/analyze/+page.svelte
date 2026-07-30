<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import GroupPill from '$lib/components/validation/optical/GroupPill.svelte';
	import OutlierMark from '$lib/components/validation/optical/OutlierMark.svelte';
	import CalibrationPill from '$lib/components/validation/optical/CalibrationPill.svelte';
	import MethodLegend from '$lib/components/validation/optical/MethodLegend.svelte';
	import GroupStripPlot from '$lib/components/validation/optical/GroupStripPlot.svelte';
	import { toCsv, downloadCsv, todayStamp } from '$lib/components/validation/optical/csv';

	// Mirrors the compareGroups contract from $lib/server/optical-analysis, kept
	// inline so this client component never imports a server-only module.
	type Chan = 'A' | 'B' | 'C';
	interface ChannelStat {
		channel: Chan;
		n: number;
		nInGroup: number;
		mean: number | null;
		sd: number | null;
		cv: number | null;
		median: number | null;
		mad: number | null;
		madScaled: number | null;
		scale: number | null;
		scaleEstimator: 'mad' | 'iqr' | 'sd' | 'none';
		robustCv: number | null;
		robustLow: number | null;
		robustHigh: number | null;
		degenerate: boolean;
		flaggingEnabled: boolean;
		flaggingDisabledReason: string | null;
	}
	interface CartRow {
		id: string;
		label: string;
		spuUdi: string | null;
		ratioByChannel: Record<Chan, number | null>;
		robustZByChannel: Record<Chan, number | null>;
		outlierChannels: Chan[];
		outlierReasons: Record<Chan, string | null>;
		groupOutlier: boolean;
		cartridgeWarning: boolean;
		cartridgeFlags: string[];
		hasReadings: boolean;
		analysis: {
			crossWellCv: number | null;
			channels: Array<{ channel: Chan; n: number; ratioCv: number | null }>;
		} | null;
	}
	interface GroupResult {
		groupId: string;
		groupName: string;
		n: number;
		windowK: number;
		underpowered: boolean;
		channels: ChannelStat[];
		cartridges: CartRow[];
		flags: string[];
	}
	interface Delta {
		channel: Chan;
		aGroupId: string;
		bGroupId: string;
		medianDiff: number | null;
		medianPctDiff: number | null;
		bandsOverlap: boolean | null;
		separation: number | null;
		underpowered: boolean;
	}
	interface Comparison {
		computedAt: string;
		windowK: number;
		config: { madThreshold: number; minGroupN: number; robustCvThreshold: number };
		groups: GroupResult[];
		deltas: Delta[];
		excluded: Array<{ id: string; label: string; groupName: string; reason: string }>;
		notes: string[];
	}
	interface SpuCtx {
		spuUdi: string | null;
		spuId: string | null;
		deviceName: string | null;
		calibration: 'calibrated' | 'uncalibrated' | 'unknown';
		calibrationReason: string;
	}

	interface Props {
		data: {
			comparison: Comparison | null;
			spuContext: Record<string, SpuCtx>;
			groupColors: Record<string, string>;
			config: { madThreshold: number; windowK: number };
			truncated: boolean;
		};
	}
	let { data }: Props = $props();

	const CHANNELS: Chan[] = ['A', 'B', 'C'];
	const cmp = $derived(data.comparison);
	const groups = $derived(cmp?.groups ?? []);
	const hasData = $derived(groups.length > 0);

	const totalCartridges = $derived(groups.reduce((a, g) => a + g.n, 0));
	const withData = $derived(
		groups.reduce((a, g) => a + g.cartridges.filter((c) => c.hasReadings).length, 0)
	);

	function color(groupId: string): string {
		return data.groupColors[groupId] ?? 'cyan';
	}

	// ---- reference group -----------------------------------------------------
	// Purely client-side: compareGroups already returns every pairwise delta, so
	// switching the reference needs no server round trip. The THRESHOLD does, since
	// it changes the math — and the math has exactly one implementation, server-side.
	let refId = $state<string>('');
	const referenceId = $derived(refId || (groups[0]?.groupId ?? ''));

	function deltaFor(channel: Chan, groupId: string): Delta | null {
		if (!cmp || groupId === referenceId) return null;
		for (const d of cmp.deltas) {
			if (d.channel !== channel) continue;
			if (d.aGroupId === groupId && d.bGroupId === referenceId) return d;
			if (d.aGroupId === referenceId && d.bGroupId === groupId) {
				// Stored as reference - group; flip so it reads group - reference.
				return {
					...d,
					medianDiff: d.medianDiff == null ? null : -d.medianDiff,
					medianPctDiff: d.medianPctDiff == null ? null : -d.medianPctDiff
				};
			}
		}
		return null;
	}

	// ---- threshold -----------------------------------------------------------
	function setThreshold(v: string) {
		const url = new URL(page.url);
		url.searchParams.set('k', v);
		goto(url, { keepFocus: true, noScroll: true });
	}

	// ---- formatting ----------------------------------------------------------
	function fmt(v: number | null | undefined, dp = 2): string {
		return v == null ? '—' : v.toFixed(dp);
	}
	function pct(v: number | null | undefined, dp = 0): string {
		return v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(dp)}%`;
	}
	function range(lo: number | null, hi: number | null): string {
		return lo == null || hi == null ? '—' : `${lo.toFixed(2)}–${hi.toFixed(2)}`;
	}
	function robustCvClass(v: number | null): string {
		const limit = cmp?.config.robustCvThreshold ?? 15;
		return v != null && v > limit ? 'text-amber-400' : 'text-[var(--color-tron-text-primary)]';
	}
	function statOf(g: GroupResult, c: Chan): ChannelStat {
		return g.channels.find((x) => x.channel === c)!;
	}
	function outlierCount(g: GroupResult, c: Chan): number {
		return g.cartridges.filter((r) => r.outlierChannels.includes(c)).length;
	}
	function spu(id: string): SpuCtx | null {
		return data.spuContext[id] ?? null;
	}

	// ---- strip plot ----------------------------------------------------------
	// One shared x domain across all three wells so the panels compare directly.
	const domain = $derived.by(() => {
		const vals: number[] = [];
		for (const g of groups) {
			for (const r of g.cartridges) {
				for (const c of CHANNELS) {
					const v = r.ratioByChannel[c];
					if (v != null && Number.isFinite(v)) vals.push(v);
				}
			}
		}
		if (vals.length === 0) return { min: 0, max: 1 };
		const lo = Math.min(...vals);
		const hi = Math.max(...vals);
		const pad = (hi - lo || Math.abs(hi) || 1) * 0.08;
		return { min: lo - pad, max: hi + pad };
	});

	function lanesFor(c: Chan) {
		return groups.map((g) => {
			const s = statOf(g, c);
			return {
				groupId: g.groupId,
				groupName: g.groupName,
				color: color(g.groupId),
				median: s.median,
				low: s.flaggingEnabled ? s.robustLow : null,
				high: s.flaggingEnabled ? s.robustHigh : null,
				points: g.cartridges
					.filter((r) => r.ratioByChannel[c] != null)
					.map((r) => ({
						id: r.id,
						value: r.ratioByChannel[c] as number,
						outlier: r.outlierChannels.includes(c),
						spuUdi: spu(r.id)?.spuUdi ?? r.spuUdi,
						z: r.robustZByChannel[c]
					}))
			};
		});
	}

	// ---- CSV -----------------------------------------------------------------
	// Long format — one row per cartridge x well. This is what pastes into a stats
	// tool; a wide layout fights every grouping operation.
	function exportDataset() {
		if (!cmp) return;
		const header = [
			'group_name', 'group_id', 'barcode', 'spu_udi', 'spu_calibration_status', 'well',
			'f7_f3_ratio', 'robust_z', 'is_outlier', 'group_median', 'group_mad_scaled',
			'group_scale_estimator', 'group_robust_cv_pct', 'expected_low', 'expected_high',
			'cartridge_ratio_cv_pct', 'cross_well_cv_pct', 'threshold_k', 'window_k', 'exported_at'
		];
		const rows: Array<Array<unknown>> = [];
		const stamp = new Date().toISOString();
		for (const g of cmp.groups) {
			for (const r of g.cartridges) {
				for (const c of CHANNELS) {
					const s = statOf(g, c);
					const chan = r.analysis?.channels.find((x) => x.channel === c) ?? null;
					rows.push([
						g.groupName, g.groupId, r.id,
						spu(r.id)?.spuUdi ?? r.spuUdi ?? '',
						spu(r.id)?.calibration ?? 'unknown',
						c,
						r.ratioByChannel[c], r.robustZByChannel[c],
						r.outlierChannels.includes(c) ? 'yes' : 'no',
						s.median, s.madScaled, s.scaleEstimator, s.robustCv, s.robustLow, s.robustHigh,
						chan?.ratioCv ?? null, r.analysis?.crossWellCv ?? null,
						cmp.config.madThreshold, cmp.windowK, stamp
					]);
				}
			}
		}
		downloadCsv(`optical-groups-dataset-${todayStamp()}.csv`, toCsv(header, rows));
	}

	function exportSummary() {
		if (!cmp) return;
		const header = [
			'well', 'group_name', 'n_with_data', 'n_in_group', 'median', 'mad_scaled',
			'scale_estimator', 'robust_cv_pct', 'expected_low', 'expected_high',
			'classic_mean', 'classic_sd', 'classic_cv_pct',
			'delta_vs_reference', 'pct_delta_vs_reference', 'separation', 'bands_overlap',
			'outlier_count', 'flagging_enabled', 'reference_group', 'threshold_k', 'exported_at'
		];
		const rows: Array<Array<unknown>> = [];
		const stamp = new Date().toISOString();
		const refName = groups.find((g) => g.groupId === referenceId)?.groupName ?? '';
		for (const c of CHANNELS) {
			for (const g of cmp.groups) {
				const s = statOf(g, c);
				const d = deltaFor(c, g.groupId);
				rows.push([
					c, g.groupName, s.n, s.nInGroup, s.median, s.madScaled, s.scaleEstimator,
					s.robustCv, s.robustLow, s.robustHigh, s.mean, s.sd, s.cv,
					d?.medianDiff ?? null, d?.medianPctDiff ?? null, d?.separation ?? null,
					d?.bandsOverlap == null ? '' : d.bandsOverlap ? 'yes' : 'no',
					outlierCount(g, c), s.flaggingEnabled ? 'yes' : 'no',
					refName, cmp.config.madThreshold, stamp
				]);
			}
		}
		downloadCsv(`optical-groups-summary-${todayStamp()}.csv`, toCsv(header, rows));
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<a
			href="/validation/optical-confirmation"
			class="text-sm text-[var(--color-tron-cyan)] hover:underline"
		>
			← Back to Optical Confirmation
		</a>
		<h1 class="tron-heading mt-1 text-2xl font-bold">
			Group Comparison{#if hasData}
				— {groups.length} group{groups.length === 1 ? '' : 's'} · {totalCartridges} cartridge{totalCartridges ===
				1
					? ''
					: 's'} ({withData} with data){/if}
		</h1>
		{#if hasData}
			<div class="mt-2 flex flex-wrap gap-2">
				{#each groups as g (g.groupId)}
					<GroupPill name={g.groupName} color={color(g.groupId)} count={g.n} />
				{/each}
			</div>
		{/if}
	</div>

	{#if !hasData}
		<div class="tron-card p-4">
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				Nothing to compare. Pick cartridges on the optical log and choose “Analyze selected”, or
				select saved groups and choose “Compare groups”.
			</p>
		</div>
	{:else}
		{#if data.truncated}
			<div class="rounded-lg bg-[var(--color-tron-orange)]/10 p-3 text-sm text-[var(--color-tron-orange)]">
				⚠ This selection exceeded the comparison cap, so only the first cartridges were analyzed.
				Narrow the selection to be sure you are seeing everything.
			</div>
		{/if}

		<!-- Raw values: context, not a warning -->
		<div
			class="rounded-lg border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/5 p-3 text-sm text-[var(--color-tron-text-secondary)]"
		>
			Every number on this page is <span class="tron-text-primary font-semibold">raw F7/F3</span>
			(F7 630 nm signal ÷ F3 480 nm reference). No calibration factor is applied anywhere; per-SPU
			calibration status is shown for context only.
		</div>

		{#each cmp!.notes as note}
			<p class="text-xs text-[var(--color-tron-text-secondary)]">· {note}</p>
		{/each}

		<!-- Controls -->
		<div class="tron-card flex flex-wrap items-end gap-4 p-4">
			<div>
				<label for="refGroup" class="tron-text-muted mb-1 block text-xs font-medium">
					Compare against
				</label>
				<select id="refGroup" bind:value={refId} class="tron-input rounded-lg px-3 py-2 text-sm">
					{#each groups as g (g.groupId)}
						<option value={g.groupId}>{g.groupName}</option>
					{/each}
				</select>
			</div>
			<div>
				<label for="threshold" class="tron-text-muted mb-1 block text-xs font-medium">
					Flag beyond
				</label>
				<select
					id="threshold"
					value={String(cmp!.config.madThreshold)}
					onchange={(e) => setThreshold((e.currentTarget as HTMLSelectElement).value)}
					class="tron-input rounded-lg px-3 py-2 text-sm"
				>
					<option value="3.5">3.5 robust SD (default)</option>
					<option value="3">3.0 robust SD</option>
					<option value="2.5">2.5 robust SD</option>
					<option value="5">5.0 robust SD</option>
				</select>
			</div>
			<div class="ml-auto flex gap-2">
				<button
					type="button"
					onclick={exportDataset}
					class="rounded-lg border border-[var(--color-tron-cyan)]/50 px-3 py-2 text-sm font-semibold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10"
				>
					Download dataset CSV
				</button>
				<button
					type="button"
					onclick={exportSummary}
					class="rounded-lg border border-[var(--color-tron-border)] px-3 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]"
				>
					Summary CSV
				</button>
			</div>
		</div>

		<!-- Group spread flags -->
		{#each groups as g (g.groupId)}
			{#each g.flags as flag}
				<p class="text-sm text-amber-400">⚠ {g.groupName}: {flag}</p>
			{/each}
		{/each}

		<!-- Strip plots -->
		<div class="tron-card p-4">
			<h2 class="tron-heading mb-1 text-sm font-semibold uppercase tracking-wide">
				F7/F3 by cartridge
			</h2>
			<p class="mb-3 text-xs text-[var(--color-tron-text-secondary)]">
				One lane per group. The bar is the group median, the shaded band its expected range.
				Amber marks are outliers. Hover a point for detail; click to open the cartridge.
			</p>
			{#each CHANNELS as c}
				<GroupStripPlot channel={c} lanes={lanesFor(c)} xMin={domain.min} xMax={domain.max} />
			{/each}
		</div>

		<!-- Per-well group stats -->
		{#each CHANNELS as c}
			<div class="tron-card p-4">
				<h2 class="tron-heading mb-3 text-sm font-semibold uppercase tracking-wide">Well {c}</h2>
				<div class="overflow-x-auto">
					<table class="w-full min-w-[56rem] text-left text-sm">
						<thead class="text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]">
							<tr class="border-b border-[var(--color-tron-border)]">
								<th class="py-2 pr-4 font-medium">Group</th>
								<th class="py-2 pr-4 font-medium">Cartridges</th>
								<th class="py-2 pr-4 font-medium">Median F7/F3</th>
								<th class="py-2 pr-4 font-medium">MAD</th>
								<th class="py-2 pr-4 font-medium">Robust CV</th>
								<th class="py-2 pr-4 font-medium">Expected range</th>
								<th class="py-2 pr-4 font-medium">Δ vs ref</th>
								<th class="py-2 pr-4 font-medium">Δ %</th>
								<th class="py-2 pr-4 font-medium">Separation</th>
								<th class="py-2 font-medium">Outliers</th>
							</tr>
						</thead>
						<tbody class="font-mono">
							{#each groups as g (g.groupId)}
								{@const s = statOf(g, c)}
								{@const d = deltaFor(c, g.groupId)}
								{@const oc = outlierCount(g, c)}
								<tr class="border-b border-[var(--color-tron-border)]/50">
									<td class="py-2 pr-4 font-sans">
										<GroupPill name={g.groupName} color={color(g.groupId)} />
										{#if g.groupId === referenceId}
											<span class="ml-1 text-[10px] text-[var(--color-tron-text-secondary)]">
												(reference)
											</span>
										{/if}
									</td>
									<td
										class="py-2 pr-4 text-[var(--color-tron-text-secondary)]"
										title={`${s.n} of the ${s.nInGroup} cartridges in this group produced a usable F7/F3 on well ${c}.`}
									>
										{s.n} / {s.nInGroup}
									</td>
									<td class="py-2 pr-4 font-semibold text-[var(--color-tron-green)]">{fmt(s.median)}</td>
									<td
										class="py-2 pr-4 text-[var(--color-tron-text-secondary)]"
										title="Median absolute deviation, scaled x1.4826 so it reads on the same scale as a standard deviation."
									>
										{fmt(s.madScaled, 3)}
									</td>
									<td class="py-2 pr-4 {robustCvClass(s.robustCv)}">
										{s.robustCv == null ? '—' : `${s.robustCv.toFixed(0)}%`}
									</td>
									<td class="py-2 pr-4 text-[var(--color-tron-cyan)]">
										{s.flaggingEnabled ? range(s.robustLow, s.robustHigh) : '—'}
									</td>
									<td class="py-2 pr-4 text-[var(--color-tron-text-primary)]">
										{g.groupId === referenceId ? '—' : fmt(d?.medianDiff)}
									</td>
									<td class="py-2 pr-4 text-[var(--color-tron-text-primary)]">
										{g.groupId === referenceId ? '—' : pct(d?.medianPctDiff)}
									</td>
									<td
										class="py-2 pr-4 text-[var(--color-tron-text-secondary)]"
										title="How far apart the two group medians are relative to the groups' own scatter. Under 1 = they overlap; over 2 = clearly separated. A descriptive ratio, not a statistical test."
									>
										{g.groupId === referenceId
											? '—'
											: d?.separation == null
												? '—'
												: `${d.separation.toFixed(1)}×`}
									</td>
									<td class="py-2">
										{#if !s.flaggingEnabled}
											<span class="text-[var(--color-tron-text-secondary)]">n/a</span>
										{:else if oc > 0}
											<span class="text-amber-400">{oc} ⚠</span>
										{:else}
											<span class="text-[var(--color-tron-text-secondary)]">0</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				<!-- Why flagging is off, verbatim -->
				{#each groups as g (g.groupId)}
					{@const s = statOf(g, c)}
					{#if s.flaggingDisabledReason}
						<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">
							<span class="font-semibold">{g.groupName}:</span>
							{s.flaggingDisabledReason}
						</p>
					{/if}
					{#if s.flaggingEnabled && s.scaleEstimator !== 'mad'}
						<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">
							<span class="font-semibold">{g.groupName}:</span>
							spread estimated from {s.scaleEstimator.toUpperCase()} rather than MAD — more than
							half the cartridges share the same F7/F3 on this well.
						</p>
					{/if}
				{/each}
			</div>
		{/each}

		<!-- Dataset -->
		<div class="tron-card p-4">
			<h2 class="tron-heading mb-3 text-sm font-semibold uppercase tracking-wide">
				Per-cartridge dataset
			</h2>
			<div class="overflow-x-auto">
				<table class="w-full min-w-[54rem] text-left text-sm">
					<thead class="text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]">
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="py-2 pr-4 font-medium">Group</th>
							<th class="py-2 pr-4 font-medium">Barcode</th>
							<th class="py-2 pr-4 font-medium">SPU</th>
							<th class="py-2 pr-4 font-medium">Calib</th>
							<th class="py-2 pr-4 font-medium">A</th>
							<th class="py-2 pr-4 font-medium">B</th>
							<th class="py-2 pr-4 font-medium">C</th>
							<th class="py-2 font-medium">Flags</th>
						</tr>
					</thead>
					<tbody class="font-mono">
						{#each groups as g (g.groupId)}
							{#each g.cartridges as r (r.id)}
								{@const sc = spu(r.id)}
								<tr
									class="border-b border-[var(--color-tron-border)]/50 {r.hasReadings
										? ''
										: 'opacity-60'}"
								>
									<td class="py-2 pr-4 font-sans">
										<GroupPill name={g.groupName} color={color(g.groupId)} />
									</td>
									<td class="py-2 pr-4 text-xs">
										<a
											href={'/validation/optical-confirmation/' + r.id}
											class="text-[var(--color-tron-cyan)] hover:underline">{r.label}</a
										>
									</td>
									<td class="py-2 pr-4 text-xs text-[var(--color-tron-text-secondary)]">
										{#if sc?.spuUdi}
											<span title={sc.spuId ? undefined : 'Could not be matched to an SPU record.'}>
												{sc.spuUdi}
											</span>
										{:else}
											—
										{/if}
									</td>
									<td class="py-2 pr-4 font-sans">
										{#if sc}
											<CalibrationPill status={sc.calibration} reason={sc.calibrationReason} />
										{:else}
											<span class="text-[var(--color-tron-text-secondary)]">—</span>
										{/if}
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
									<td class="py-2 font-sans text-xs">
										{#if !r.hasReadings}
											<span
												class="rounded border border-[var(--color-tron-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)]"
												title="This cartridge has no optical readings — it is listed for completeness but is excluded from every statistic on this page."
											>NO READINGS</span>
										{:else if r.cartridgeWarning}
											<span
												class="rounded border border-[var(--color-tron-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)]"
												title={r.cartridgeFlags.join('\n')}
											>
												OWN READINGS NOISY
											</span>
										{:else}
											<span class="text-[var(--color-tron-text-secondary)]">—</span>
										{/if}
									</td>
								</tr>
							{/each}
						{/each}
					</tbody>
				</table>
			</div>
		</div>

		<!-- Excluded -->
		{#if cmp!.excluded.length > 0}
			<div class="tron-card p-4">
				<h2 class="tron-heading mb-2 text-sm font-semibold uppercase tracking-wide">
					Excluded from statistics ({cmp!.excluded.length})
				</h2>
				<ul class="space-y-1 text-xs text-[var(--color-tron-text-secondary)]">
					{#each cmp!.excluded as e}
						<li>
							<span class="font-mono">{e.label}</span>
							<span class="opacity-70">({e.groupName})</span> — {e.reason}
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<MethodLegend
			thresholdK={cmp!.config.madThreshold}
			windowK={cmp!.windowK}
			minGroupN={cmp!.config.minGroupN}
		/>
	{/if}
</div>
