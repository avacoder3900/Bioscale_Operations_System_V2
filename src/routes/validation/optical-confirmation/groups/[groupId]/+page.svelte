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

	<!-- Cartridges -->
	<div class="tron-card p-4">
		<h2 class="tron-heading mb-3 text-sm font-semibold uppercase tracking-wide">
			Cartridges ({rows.length})
		</h2>

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
							<th class="py-2 pr-4 font-medium">Barcode</th>
							<th class="py-2 pr-4 font-medium">SPU</th>
							<th class="py-2 pr-4 font-medium">A</th>
							<th class="py-2 pr-4 font-medium">B</th>
							<th class="py-2 pr-4 font-medium">C</th>
							<th class="py-2 pr-4 font-medium">Overall</th>
							<th class="py-2 pr-4 font-medium">Flags</th>
							<th class="py-2 font-medium"><span class="sr-only">Actions</span></th>
						</tr>
					</thead>
					<tbody class="font-mono">
						{#each rows as r (r.id)}
							<tr
								class="border-b border-[var(--color-tron-border)]/50 {r.hasReadings
									? ''
									: 'opacity-60'}"
							>
								<td class="py-2 pr-4 text-xs">
									<a
										href={'/validation/optical-confirmation/' + r.id}
										class="text-[var(--color-tron-cyan)] hover:underline">{r.label}</a
									>
									<span class="ml-1 text-[10px] text-[var(--color-tron-text-secondary)]">
										{shortDate(data.runDates[r.id])}
									</span>
								</td>
								<td class="py-2 pr-4 text-xs text-[var(--color-tron-text-secondary)]">
									{r.spuUdi ?? '—'}
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
