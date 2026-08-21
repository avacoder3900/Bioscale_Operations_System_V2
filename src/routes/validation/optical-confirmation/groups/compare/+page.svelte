<script lang="ts">
	import GroupPill from '$lib/components/validation/optical/GroupPill.svelte';
	import { toCsv, downloadCsv, todayStamp } from '$lib/components/validation/optical/csv';

	// Mirrors the diffGroups contract from $lib/server/optical-analysis, kept inline so
	// this client component never imports a server-only module. Same convention as the
	// analyze page.
	type Chan = 'A' | 'B' | 'C';

	interface RobustStat {
		n: number;
		mean: number | null;
		sd: number | null;
		cv: number | null;
		bandLow: number | null;
		bandHigh: number | null;
		mode: number | null;
		median: number | null;
		mad: number | null;
		madScaled: number | null;
		q1: number | null;
		q3: number | null;
		iqr: number | null;
		min: number | null;
		max: number | null;
		scale: number | null;
		scaleEstimator: 'mad' | 'iqr' | 'sd' | 'none';
		robustCv: number | null;
		robustLow: number | null;
		robustHigh: number | null;
		degenerate: boolean;
	}

	interface StatDiff {
		a: RobustStat | null;
		b: RobustStat | null;
		avgDiff: number | null;
		avgPctDiff: number | null;
		sdDiff: number | null;
		/** CV minus CV — PERCENTAGE POINTS, never a percentage. */
		cvDiffPp: number | null;
		medianDiff: number | null;
		medianPctDiff: number | null;
		underpowered: boolean;
	}

	interface ExcludedCartridge {
		id: string;
		label: string;
		groupId: string;
		groupName: string;
		reason: string;
	}

	interface GroupReport {
		groupId: string;
		groupName: string;
		/** Every member, including those that contributed nothing. */
		n: number;
		windowK: number;
		overall: RobustStat;
		wells: Array<{ channel: Chan } & RobustStat>;
		rows: Array<{ id: string; label: string; overallRatio: number | null; wellsUsed: number }>;
		excluded: ExcludedCartridge[];
		flags: string[];
	}

	interface GroupDiffReport {
		computedAt: string;
		windowK: number;
		config: { madThreshold: number; minGroupN: number; robustCvThreshold: number };
		a: GroupReport;
		b: GroupReport;
		overall: StatDiff;
		wells: Array<{ channel: Chan } & StatDiff>;
		notes: string[];
	}

	interface CompareSide {
		groupId: string;
		groupName: string;
		color: string;
		description: string | null;
		memberCount: number;
		truncated: number;
		missingRecords: number;
	}

	interface Props {
		data: {
			diff: GroupDiffReport | null;
			sides: { a: CompareSide; b: CompareSide } | null;
			problem: string | null;
		};
	}
	let { data }: Props = $props();

	const diff = $derived(data.diff);
	const sides = $derived(data.sides);

	// Per PRD 8.3 the channel rows are COLLAPSED by default: the question this page
	// answers is "did these two groups differ overall", and three extra rows of the
	// same five statistics buries it.
	let showChannels = $state(false);

	interface MetricRow {
		key: string;
		label: string;
		/** What this metric's stats were computed over — rendered as the row's subtitle. */
		basis: string;
		stat: StatDiff;
	}

	const metricRows = $derived.by<MetricRow[]>(() => {
		if (!diff) return [];
		const rows: MetricRow[] = [
			{
				key: 'overall',
				label: 'Overall F7/F3',
				basis: 'mean of each cartridge’s available wells',
				stat: diff.overall
			}
		];
		for (const w of diff.wells) {
			// `{ channel } & StatDiff` is already a StatDiff; the extra tag is harmless.
			rows.push({
				key: `well-${w.channel}`,
				label: `Well ${w.channel}`,
				basis: `well ${w.channel} only`,
				stat: w
			});
		}
		return rows;
	});

	const visibleRows = $derived(showChannels ? metricRows : metricRows.slice(0, 1));

	// ---- formatting ----------------------------------------------------------
	// Ratios at 3dp: these differences are often in the second decimal, and 2dp
	// rounds a real difference into a visible zero.
	function fmt(v: number | null | undefined, dp = 3): string {
		return v == null ? '—' : v.toFixed(dp);
	}
	/** Signed absolute difference, in raw F7/F3 ratio units. */
	function signed(v: number | null | undefined, dp = 3): string {
		return v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(dp)}`;
	}
	/** A true percentage — a difference expressed relative to Group B. */
	function pct(v: number | null | undefined, dp = 1): string {
		return v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(dp)}%`;
	}
	/**
	 * PERCENTAGE POINTS. CV is already a percentage, so a CV minus a CV is pp — calling
	 * it "%" would read as a relative change and be wrong by an order of magnitude on
	 * small CVs. The unit is rendered, never assumed.
	 */
	function pp(v: number | null | undefined, dp = 1): string {
		return v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(dp)} pp`;
	}
	function cvPct(v: number | null | undefined, dp = 1): string {
		return v == null ? '—' : `${v.toFixed(dp)}%`;
	}

	function memberNote(side: CompareSide | undefined, stat: RobustStat | null): string {
		if (!side) return '';
		const contributed = stat?.n ?? 0;
		return (
			`${contributed} of the ${side.memberCount} cartridge${side.memberCount === 1 ? '' : 's'} ` +
			`in “${side.groupName}” produced a usable value for this metric.`
		);
	}

	// ---- CSV -----------------------------------------------------------------
	// One row per metric (overall + the three wells) carrying both groups' stats and
	// every difference. toCsv quotes and defuses formula injection — a group name with
	// a comma in it is the normal case here, not an edge case.
	function exportCsv() {
		if (!diff) return;
		const header = [
			'metric',
			'metric_basis',
			'group_a_name',
			'group_a_id',
			'group_a_n_contributing',
			'group_a_avg_f7_f3',
			'group_a_stdev',
			'group_a_cv_pct',
			'group_a_median',
			'group_b_name',
			'group_b_id',
			'group_b_n_contributing',
			'group_b_avg_f7_f3',
			'group_b_stdev',
			'group_b_cv_pct',
			'group_b_median',
			'delta_avg',
			'delta_avg_pct',
			'delta_stdev',
			// Named pp in the file for the same reason it is labelled pp on screen.
			'delta_cv_pp',
			'delta_median',
			'delta_median_pct',
			'underpowered',
			'group_a_members',
			'group_b_members',
			'window_k',
			'min_group_n',
			'exported_at'
		];
		const stamp = new Date().toISOString();
		const rows: Array<Array<unknown>> = metricRows.map((m) => [
			m.label,
			m.basis,
			diff.a.groupName,
			diff.a.groupId,
			m.stat.a?.n ?? 0,
			m.stat.a?.mean ?? null,
			m.stat.a?.sd ?? null,
			m.stat.a?.cv ?? null,
			m.stat.a?.median ?? null,
			diff.b.groupName,
			diff.b.groupId,
			m.stat.b?.n ?? 0,
			m.stat.b?.mean ?? null,
			m.stat.b?.sd ?? null,
			m.stat.b?.cv ?? null,
			m.stat.b?.median ?? null,
			m.stat.avgDiff,
			m.stat.avgPctDiff,
			m.stat.sdDiff,
			m.stat.cvDiffPp,
			m.stat.medianDiff,
			m.stat.medianPctDiff,
			m.stat.underpowered ? 'yes' : 'no',
			diff.a.n,
			diff.b.n,
			diff.windowK,
			diff.config.minGroupN,
			stamp
		]);
		// The engine's caveats travel with the numbers. A CSV that drops them is the
		// exact artefact that gets pasted into a slide deck as a result.
		for (const note of diff.notes) {
			rows.push(['NOTE', note, ...new Array(header.length - 2).fill('')]);
		}
		downloadCsv(`optical-group-compare-${todayStamp()}.csv`, toCsv(header, rows));
	}
</script>

{#snippet statBlock(s: RobustStat | null, title: string)}
	<div class="space-y-0.5 text-xs" {title}>
		<div class="flex justify-between gap-3">
			<span class="text-[var(--color-tron-text-secondary)]">n</span>
			<span class="font-mono text-[var(--color-tron-text-primary)]">{s?.n ?? 0}</span>
		</div>
		<div class="flex justify-between gap-3">
			<span class="text-[var(--color-tron-text-secondary)]">avg</span>
			<span class="font-mono font-semibold text-[var(--color-tron-green)]">{fmt(s?.mean)}</span>
		</div>
		<div class="flex justify-between gap-3">
			<span class="text-[var(--color-tron-text-secondary)]">stdev</span>
			<span class="font-mono text-[var(--color-tron-text-primary)]">{fmt(s?.sd)}</span>
		</div>
		<div class="flex justify-between gap-3">
			<span class="text-[var(--color-tron-text-secondary)]">CV</span>
			<span class="font-mono text-[var(--color-tron-text-primary)]">{cvPct(s?.cv)}</span>
		</div>
		<div class="flex justify-between gap-3">
			<span class="text-[var(--color-tron-text-secondary)]">median</span>
			<span class="font-mono text-[var(--color-tron-cyan)]">{fmt(s?.median)}</span>
		</div>
	</div>
{/snippet}

{#snippet diffBlock(s: StatDiff)}
	<div class="space-y-0.5 text-xs">
		<div class="flex justify-between gap-3">
			<span class="text-[var(--color-tron-text-secondary)]">Δ avg</span>
			<span class="font-mono text-[var(--color-tron-text-primary)]">
				{signed(s.avgDiff)}<span class="ml-1 text-[var(--color-tron-text-secondary)]"
					>({pct(s.avgPctDiff)})</span
				>
			</span>
		</div>
		<div class="flex justify-between gap-3">
			<span class="text-[var(--color-tron-text-secondary)]">Δ stdev</span>
			<span class="font-mono text-[var(--color-tron-text-primary)]">{signed(s.sdDiff)}</span>
		</div>
		<div class="flex justify-between gap-3">
			<span
				class="text-[var(--color-tron-text-secondary)]"
				title="CV is already a percentage, so the difference of two CVs is in percentage POINTS — not a percentage change."
			>
				Δ CV (pp)
			</span>
			<span class="font-mono text-[var(--color-tron-text-primary)]">{pp(s.cvDiffPp)}</span>
		</div>
		<div class="flex justify-between gap-3">
			<span class="text-[var(--color-tron-text-secondary)]">Δ median</span>
			<span class="font-mono text-[var(--color-tron-text-primary)]">
				{signed(s.medianDiff)}<span class="ml-1 text-[var(--color-tron-text-secondary)]"
					>({pct(s.medianPctDiff)})</span
				>
			</span>
		</div>
		{#if s.underpowered}
			<div
				class="mt-1 inline-block rounded border border-amber-500/60 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-400"
				title={`One or both groups have fewer than ${diff?.config.minGroupN ?? 5} cartridges contributing to this metric. A difference between two tiny groups is not a result — read it as a prompt to run more, not as a finding.`}
			>
				UNDERPOWERED
			</div>
		{/if}
	</div>
{/snippet}

<div class="space-y-6">
	<!-- Header -->
	<div>
		<a
			href="/validation/optical-confirmation/groups"
			class="text-sm text-[var(--color-tron-cyan)] hover:underline"
		>
			← Back to Groups
		</a>
		<h1 class="tron-heading mt-1 text-2xl font-bold">Compare Groups</h1>
		{#if sides && diff}
			<div class="mt-2 flex flex-wrap items-center gap-2">
				<GroupPill
					name={sides.a.groupName}
					color={sides.a.color}
					count={diff.a.n}
					title={`Group A — ${diff.a.n} cartridge${diff.a.n === 1 ? '' : 's'} in the group.`}
				/>
				<span class="text-sm text-[var(--color-tron-text-secondary)]">vs</span>
				<GroupPill
					name={sides.b.groupName}
					color={sides.b.color}
					count={diff.b.n}
					title={`Group B — ${diff.b.n} cartridge${diff.b.n === 1 ? '' : 's'} in the group.`}
				/>
			</div>
		{/if}
	</div>

	{#if !diff || !sides}
		<div class="tron-card p-4">
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				{data.problem ?? 'Nothing to compare.'}
			</p>
			<a
				href="/validation/optical-confirmation/groups"
				class="mt-3 inline-block rounded-lg border border-[var(--color-tron-cyan)]/50 px-3 py-2 text-sm font-semibold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10"
			>
				Open the Groups workspace
			</a>
		</div>
	{:else}
		<!-- Raw values: context, not a warning. Same wording as the analyze page. -->
		<div
			class="rounded-lg border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/5 p-3 text-sm text-[var(--color-tron-text-secondary)]"
		>
			Every number on this page is <span class="tron-text-primary font-semibold">raw F7/F3</span>
			(F7 630 nm signal ÷ F3 480 nm reference). No calibration factor is applied. Differences read
			<span class="tron-text-primary font-semibold">Group A − Group B</span>.
		</div>

		{#each [sides.a, sides.b] as s (s.groupId)}
			{#if s.truncated > 0}
				<div
					class="rounded-lg bg-[var(--color-tron-orange)]/10 p-3 text-sm text-[var(--color-tron-orange)]"
				>
					⚠ “{s.groupName}” exceeded the comparison cap, so {s.truncated} cartridge{s.truncated ===
					1
						? ' was'
						: 's were'} left out of these numbers.
				</div>
			{/if}
			{#if s.missingRecords > 0}
				<p class="text-xs text-[var(--color-tron-text-secondary)]">
					· {s.missingRecords} member{s.missingRecords === 1 ? '' : 's'} of “{s.groupName}”
					{s.missingRecords === 1 ? 'has' : 'have'} no cartridge record and could not be read at all.
				</p>
			{/if}
		{/each}

		<!-- Main table -->
		<div class="tron-card p-4">
			<div class="mb-3 flex flex-wrap items-center justify-between gap-3">
				<h2 class="tron-heading text-sm font-semibold uppercase tracking-wide">
					Group totals and difference
				</h2>
				<div class="flex gap-2">
					<button
						type="button"
						onclick={() => (showChannels = !showChannels)}
						aria-expanded={showChannels}
						class="rounded-lg border border-[var(--color-tron-border)] px-3 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]"
					>
						{showChannels ? '▾ Hide channels' : '▸ Show channels'}
					</button>
					<button
						type="button"
						onclick={exportCsv}
						class="rounded-lg border border-[var(--color-tron-cyan)]/50 px-3 py-2 text-sm font-semibold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10"
					>
						Download CSV
					</button>
				</div>
			</div>

			<div class="overflow-x-auto">
				<table class="w-full min-w-[52rem] text-left text-sm">
					<thead class="text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]">
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="w-48 py-2 pr-4 font-medium">Metric</th>
							<th class="py-2 pr-4 font-medium">
								<div class="mb-1">Group A</div>
								<GroupPill name={sides.a.groupName} color={sides.a.color} count={diff.a.n} />
							</th>
							<th class="py-2 pr-4 font-medium">
								<div class="mb-1">Group B</div>
								<GroupPill name={sides.b.groupName} color={sides.b.color} count={diff.b.n} />
							</th>
							<th class="py-2 font-medium">
								<div class="mb-1">Difference</div>
								<span class="font-mono text-[10px] normal-case tracking-normal">A − B</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{#each visibleRows as m (m.key)}
							<tr class="border-b border-[var(--color-tron-border)]/50">
								<td class="py-3 pr-4 align-top">
									<div class="font-semibold text-[var(--color-tron-text-primary)]">{m.label}</div>
									<div class="mt-0.5 text-[10px] text-[var(--color-tron-text-secondary)]">
										{m.basis}
									</div>
								</td>
								<td class="w-56 py-3 pr-4 align-top">
									{@render statBlock(m.stat.a, memberNote(sides.a, m.stat.a))}
								</td>
								<td class="w-56 py-3 pr-4 align-top">
									{@render statBlock(m.stat.b, memberNote(sides.b, m.stat.b))}
								</td>
								<td class="w-64 py-3 align-top">
									{@render diffBlock(m.stat)}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<p class="mt-3 text-xs text-[var(--color-tron-text-secondary)]">
				n counts the cartridges that produced a usable value for that metric, which can be fewer
				than the group's membership. Endpoint window: last {diff.windowK} readings per channel.
				Δ CV is in <span class="font-semibold">percentage points</span> — CV is already a percentage,
				so subtracting two of them cannot yield a percentage.
			</p>

			<!-- The engine's caveats, verbatim, directly beneath the numbers. -->
			{#each diff.notes as note}
				<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">· {note}</p>
			{/each}
		</div>

		<!-- Anything that contributed nothing is named, never silently absent. -->
		{#if diff.a.excluded.length > 0 || diff.b.excluded.length > 0}
			<div class="tron-card p-4">
				<h2 class="tron-heading mb-2 text-sm font-semibold uppercase tracking-wide">
					Excluded from these statistics ({diff.a.excluded.length + diff.b.excluded.length})
				</h2>
				<ul class="space-y-1 text-xs text-[var(--color-tron-text-secondary)]">
					{#each [...diff.a.excluded, ...diff.b.excluded] as e (e.groupId + ':' + e.id)}
						<li>
							<span class="font-mono">{e.label}</span>
							<span class="opacity-70">({e.groupName})</span> — {e.reason}
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	{/if}
</div>
