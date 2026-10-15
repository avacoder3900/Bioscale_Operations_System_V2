<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard, TronBadge, TronButton } from '$lib/components/ui';

	let { data, form } = $props();

	/** Row whose Release is in flight. */
	let releasing = $state<string | null>(null);
	function releaseHandler({ formData }: { formData: FormData }) {
		releasing = formData.get('spuId')?.toString() ?? null;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			releasing = null;
		};
	}
	function releaseBlockedReason(r: { status: string; passedCount: number; total: number }): string {
		if (r.status !== 'validating') return `Only a validating unit can be released (this one is ${r.status})`;
		return `${r.passedCount}/${r.total} validations passed this cycle — all ${r.total} must pass first`;
	}

	let expanded = $state<string | null>(null);
	let search = $state('');

	// Rows arrive sorted most-recently-tested first, and that stays the default.
	// Clicking a sortable header switches to it, matching how the SPU Inventory
	// table toggles direction and shows an arrow.
	type SortKey = 'lastTest' | 'unit';
	let sortKey = $state<SortKey>('lastTest');
	let sortDir = $state<'asc' | 'desc'>('desc');

	function toggleSort(key: SortKey) {
		if (sortKey === key) {
			sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		} else {
			sortKey = key;
			// Units read naturally A->Z; dates read newest-first.
			sortDir = key === 'unit' ? 'asc' : 'desc';
		}
	}

	// Rows stay loosely typed here, as they were before: the table reads many more
	// fields off each row than the sort does, and naming a narrow type would hide
	// them from the markup.
	const filteredRows = $derived.by(() => {
		const q = search.trim().toLowerCase();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const rows: any[] = q
			? data.rows.filter(
					(r: { udi: string; status: string }) =>
						r.udi.toLowerCase().includes(q) || r.status.toLowerCase().includes(q)
				)
			: data.rows;

		// The server already returns most-recently-tested first, so leave that
		// order exactly as-is when it is what was asked for.
		if (sortKey === 'lastTest' && sortDir === 'desc') return rows;

		const dir = sortDir === 'asc' ? 1 : -1;
		return [...rows].sort((a: any, b: any) => {
			if (sortKey === 'unit') {
				// numeric so BT-M01-0000-0099 sorts before -0100, not after.
				return a.udi.localeCompare(b.udi, undefined, { numeric: true }) * dir;
			}
			const at = a.lastTestAt ? new Date(a.lastTestAt).getTime() : null;
			const bt = b.lastTestAt ? new Date(b.lastTestAt).getTime() : null;
			// Never-tested units sink to the bottom in both directions rather than
			// pretending to a date they do not have.
			if (at === null && bt === null) return 0;
			if (at === null) return 1;
			if (bt === null) return -1;
			return (at - bt) * dir;
		});
	});

	function fmtLastTest(d: string | null): string {
		if (!d) return '—';
		return new Date(d).toLocaleString(undefined, {
			month: 'numeric',
			day: 'numeric',
			year: '2-digit',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	function badgeVariant(status: string): 'success' | 'error' | 'warning' | 'neutral' {
		if (status === 'passed' || status === 'overridden') return 'success';
		if (status === 'failed') return 'error';
		return 'neutral';
	}

	// Validation = how many of the graded instruments (mag + thermo) have passed
	// in the CURRENT cycle, rendered exactly like the inventory's pill. The cycle
	// resets to 0 when a unit enters servicing (spu-validation-cycle.ts).

	/** Bench / blank auto-check cell: PASS / FAIL / INCOMPLETE, reasons on hover. */
	function autoVariant(v: string | undefined): 'success' | 'error' | 'warning' | 'neutral' {
		if (v === 'pass') return 'success';
		if (v === 'fail') return 'error';
		if (v === 'incomplete') return 'warning';
		return 'neutral';
	}
	function fmtRatio(r: number | null): string {
		return r == null ? '—' : r.toFixed(2);
	}
	function fmtBi(r: number | null): string {
		return r == null ? '—' : r.toFixed(2);
	}

	// The validation workflow, in order (2026-10-06, screen + assay run added
	// 2026-10-13): cheapest, broadest checks first so a bad unit is weeded out
	// before the slower fixture tests. Screen, magnetometer, thermocouple and
	// assay run gate release; bench, sonic and blank are checks on the way.
	const LAUNCHERS = [
		{ href: '/validation/screen', label: 'Screen', desc: 'One button, no cartridge: self-test suite, laser blast, assay motion ×3 with the stage check (firmware v102).' },
		{ href: '/validation/bench', label: 'Optical Bench', desc: 'Empty slot, one click. Fails on a dead/weak laser, a dead sensor band, or light in the dark read.' },
		{ href: '/validation/sonic', label: 'Sonic Fingerprint', desc: 'Phone recording of the motion assay. Fleet check: loudness against the fleet.' },
		{ href: '/validation/blank', label: 'Blank Cartridge', desc: 'One reusable blank cart. Fails on a short run, a missing channel, or a laser that never came on.' },
		{ href: '/validation/magnetometer', label: 'Magnetometer', desc: 'Fixture cartridge. Z (gauss) per well against the criteria range; peaks sweep gradient.' },
		{ href: '/validation/thermocouple', label: 'Thermocouple', desc: 'Instrumented cartridge + logger. Upload the dataset for a verdict.' },
		{ href: '/validation/assay-run', label: 'Assay Run', desc: 'A group of real cartridges on the unit — bead index, CV, stage check. Replaces optical confirmation.' },
		{ href: '/validation/optical-confirmation', label: 'Optical Confirmation (R&D)', desc: 'No longer a gate — optics R&D only.' }
	];
</script>

<div class="space-y-6">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="text-xl font-bold text-[var(--color-tron-cyan)]">SPU Validation</h1>
			<p class="tron-text-muted text-sm">
				Fleet-wide validation status. Each instrument has its own page — this is where the whole
				picture lives.
			</p>
		</div>
	</div>

	<!-- Launchers, in workflow order. A unit that fails a step is fixed and
	     re-run at that step (back to step 1 if it was opened up). -->
	<div>
		<div class="tron-text-muted mb-2 text-xs uppercase">Validation workflow — easiest first</div>
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
			{#each LAUNCHERS as l, i (l.href)}
				<a href={l.href} class="block">
					<TronCard interactive>
						<div class="font-medium text-[var(--color-tron-cyan)]">
							<span class="tron-text-muted mr-1 font-mono text-xs">{i + 1}</span>{l.label} →
						</div>
						<div class="tron-text-muted mt-1 text-xs">{l.desc}</div>
					</TronCard>
				</a>
			{/each}
		</div>
	</div>

	<!-- Fleet matrix -->
	<TronCard>
		<h3 class="tron-text-primary mb-3 text-lg font-medium">Fleet Matrix</h3>
		<p class="tron-text-muted mb-4 text-xs">
			Screen shows the latest screen's pass / fail / warn counts. Bench and Blank are checked
			automatically from the latest run — hover a FAIL for the reason. Magnetometer shows the Z
			(gauss) range — expand a row for every point — and the minimum sweep gradient when a sweep
			exists. Thermocouple shows the mode of the temperature plot. Assay run shows the latest
			group's bead index per lane and its CV. Release needs screen, magnetometer, thermocouple and
			assay run passed. Only the current validation cycle counts — it resets to 0/4 when a unit
			enters servicing. Most recently tested first. Retired units are hidden.
		</p>
		{#if form?.error}
			<p class="mb-3 text-sm text-[var(--color-tron-red)]">{form.error}</p>
		{:else if form?.released}
			<p class="mb-3 text-sm text-[var(--color-tron-cyan)]">{form.udi} released.</p>
		{/if}
		<input
			type="text"
			class="tron-input mb-4 w-full"
			placeholder="Search by SPU UDI or lifecycle status..."
			bind:value={search}
			style="min-height: 44px;"
		/>
		<div class="overflow-x-auto">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-[var(--color-tron-border)] text-left">
						<th
							class="py-0 pr-4"
							aria-sort={sortKey === 'unit' ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
						>
							<button
								type="button"
								class="flex items-center gap-1 py-2 text-xs uppercase transition-colors hover:text-[var(--color-tron-cyan)] {sortKey === 'unit' ? 'text-[var(--color-tron-cyan)]' : 'text-[var(--color-tron-text-secondary)]'}"
								onclick={() => toggleSort('unit')}
							>
								Unit
								{#if sortKey === 'unit'}
									<span aria-hidden="true">{sortDir === 'asc' ? '▲' : '▼'}</span>
								{/if}
							</button>
						</th>
						<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">Validation</th>
						<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">Lifecycle</th>
						<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">Screen</th>
						<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">Bench</th>
						<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">Blank</th>
						<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">Magnetometer (gauss)</th>
						<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">Thermo mode</th>
						<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">Assay run — bead index A / B / C</th>
						<th
							class="py-0 pr-4"
							aria-sort={sortKey === 'lastTest' ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
						>
							<button
								type="button"
								class="flex items-center gap-1 py-2 text-xs uppercase transition-colors hover:text-[var(--color-tron-cyan)] {sortKey === 'lastTest' ? 'text-[var(--color-tron-cyan)]' : 'text-[var(--color-tron-text-secondary)]'}"
								onclick={() => toggleSort('lastTest')}
							>
								Last test
								{#if sortKey === 'lastTest'}
									<span aria-hidden="true">{sortDir === 'asc' ? '▲' : '▼'}</span>
								{/if}
							</button>
						</th>
						<th class="py-2 text-xs uppercase text-[var(--color-tron-text-secondary)]">Release</th>
					</tr>
				</thead>
				<tbody>
					{#each filteredRows as r (r.id)}
						<tr class="border-b border-[var(--color-tron-border)] last:border-0">
							<td class="py-2.5 pr-4 whitespace-nowrap">
								<a href="/spu/{r.id}" class="font-mono font-bold text-[var(--color-tron-cyan)] hover:underline">{r.udi}</a>
							</td>
							<td class="py-2.5 pr-4 whitespace-nowrap">
								<span
									class="inline-block rounded-full px-2 py-0.5 text-xs font-bold whitespace-nowrap"
									style="color: {r.passedCount >= r.total ? 'var(--color-tron-green)' : 'var(--color-tron-red)'}; background: {r.passedCount >= r.total ? 'rgba(0,255,100,0.15)' : 'rgba(255,0,0,0.15)'};"
									title="Validations passed this cycle"
								>
									{r.passedCount}/{r.total}
								</span>
							</td>
							<td class="py-2.5 pr-4">
								<TronBadge variant="neutral">{r.status}</TronBadge>
							</td>
							<td class="py-2.5 pr-4 font-mono text-xs whitespace-nowrap">
								<TronBadge variant={badgeVariant(r.screen.status)}>{r.screen.running ? 'running' : r.screen.status}</TronBadge>
								{#if r.screen.counts}
									<a href="/validation/screen/{r.screen.sessionId}" class="ml-2 text-[var(--color-tron-cyan)] hover:underline" title="Open the latest screen">{r.screen.counts.pass}P / <span class={r.screen.counts.fail ? 'text-[var(--color-tron-red)]' : ''}>{r.screen.counts.fail}F</span> / {r.screen.counts.warn}W</a>
								{:else if r.screen.sessionId}
									<a href="/validation/screen/{r.screen.sessionId}" class="ml-2 text-[var(--color-tron-cyan)] hover:underline">open</a>
								{:else}
									<span class="tron-text-muted ml-2">—</span>
								{/if}
							</td>
							{#each [r.bench, r.blank] as c, ci (ci)}
								<td class="py-2.5 pr-4 whitespace-nowrap">
									{#if c}
										<span title={c.reasons.length ? c.reasons.join('\n') : 'All channels read'}>
											<TronBadge variant={autoVariant(c.verdict)}>{c.verdict}</TronBadge>
										</span>
										{#if c.reasons.length}
											<div class="mt-0.5 max-w-[14rem] truncate text-[10px] text-[var(--color-tron-red)]" title={c.reasons.join('\n')}>{c.reasons[0]}</div>
										{/if}
									{:else}
										<span class="tron-text-muted text-xs">not run</span>
									{/if}
								</td>
							{/each}
							<td class="py-2.5 pr-4 whitespace-nowrap">
								<TronBadge variant={badgeVariant(r.mag.status)}>{r.mag.status}</TronBadge>
								{#if r.mag.zRange}
									<button
										type="button"
										class="ml-2 font-mono text-xs text-[var(--color-tron-cyan)] hover:underline"
										onclick={() => (expanded = expanded === r.id ? null : r.id)}
										title="Show gauss readings at all points"
									>
										{r.mag.zRange} {expanded === r.id ? '▴' : '▾'}
									</button>
									{#if r.mag.fromSession}
										<span class="tron-text-muted ml-1 text-[10px]" title="From the latest session — no rollup on the unit record yet">session</span>
									{/if}
								{:else}
									<span class="tron-text-muted ml-2 text-xs">no readings</span>
								{/if}
								{#if r.mag.minGradient}
									<a href="/validation/magnetometer/{r.mag.sweepSessionId}" class="ml-2 font-mono text-[10px] text-[var(--color-tron-cyan)] hover:underline" title="Minimum sweep gradient (dBz/dz) across wells and lanes — the bead-delivery proxy">∇ {r.mag.minGradient.value} @ {r.mag.minGradient.well}{r.mag.minGradient.channel}</a>
								{/if}
							</td>
							<td class="py-2.5 font-mono whitespace-nowrap">
								{#if r.thermo.mode != null}
									<TronBadge variant={badgeVariant(r.thermo.status)}>{r.thermo.status}</TronBadge>
									{#if r.thermo.sessionId}
									<a
										href="/validation/thermocouple/{r.thermo.sessionId}"
										class="ml-2 text-[var(--color-tron-cyan)] hover:underline"
										title="Open this unit's thermocouple test results"
									>{r.thermo.mode}°C</a>
								{:else}
									<span class="ml-2">{r.thermo.mode}°C</span>
								{/if}
								{:else}
									<TronBadge variant={badgeVariant(r.thermo.status)}>{r.thermo.status}</TronBadge>
									<span class="tron-text-muted ml-2">—</span>
								{/if}
							</td>
							<td class="py-2.5 pr-4 font-mono text-xs whitespace-nowrap">
								<TronBadge variant={badgeVariant(r.assayRun.status)}>{r.assayRun.status}</TronBadge>
								{#if r.assayRun.beadIndex}
									<a href="/validation/assay-run/{r.assayRun.groupId}" class="ml-2 text-[var(--color-tron-cyan)] hover:underline" title="{r.assayRun.groupName ?? 'group'} — {r.assayRun.nValid}/{r.assayRun.n} valid{r.assayRun.stageMaxErr != null ? `, stage max |err| ${r.assayRun.stageMaxErr} µm` : ''}">{fmtBi(r.assayRun.beadIndex.A)} / {fmtBi(r.assayRun.beadIndex.B)} / {fmtBi(r.assayRun.beadIndex.C)}</a>
									{#if r.assayRun.beadIndexCv != null}<span class="tron-text-muted ml-1">CV {r.assayRun.beadIndexCv.toFixed(1)}%</span>{/if}
								{:else if r.assayRun.groupId}
									<a href="/validation/assay-run/{r.assayRun.groupId}" class="ml-2 text-[var(--color-tron-cyan)] hover:underline">{r.assayRun.groupName ?? 'group'}</a>
								{:else}
									<span class="tron-text-muted ml-2">—</span>
								{/if}
							</td>
							<td class="py-2.5 pr-4 text-xs whitespace-nowrap {r.lastTestAt ? '' : 'tron-text-muted'}">
								{fmtLastTest(r.lastTestAt)}
							</td>
							<td class="py-2.5 whitespace-nowrap">
								{#if r.status === 'released'}
									<span class="tron-text-muted text-xs">released</span>
								{:else}
									<form method="POST" action="?/release" use:enhance={releaseHandler} class="inline">
										<input type="hidden" name="spuId" value={r.id} />
										<span title={r.canRelease ? 'Move this unit to released' : releaseBlockedReason(r)}>
											<TronButton type="submit" size="sm" variant="primary" disabled={!r.canRelease || releasing === r.id}>
												{releasing === r.id ? 'Releasing…' : 'Release'}
											</TronButton>
										</span>
									</form>
								{/if}
							</td>
						</tr>
						{#if expanded === r.id && r.mag.wells}
							<tr class="border-b border-[var(--color-tron-border)]">
								<td colspan="9" class="bg-[var(--color-tron-bg-secondary)]/40 px-4 py-3">
									<span class="tron-text-muted mb-2 block text-xs uppercase">Gauss (Z) at all points — {r.udi}</span>
									<table class="text-xs">
										<thead>
											<tr class="text-left">
												<th class="pr-4 text-[var(--color-tron-text-secondary)]">Well</th>
												<th class="pr-4 text-[var(--color-tron-text-secondary)]">Ch A</th>
												<th class="pr-4 text-[var(--color-tron-text-secondary)]">Ch B</th>
												<th class="pr-4 text-[var(--color-tron-text-secondary)]">Ch C</th>
											</tr>
										</thead>
										<tbody class="font-mono">
											{#each r.mag.wells as w (w.well)}
												<tr>
													<td class="pr-4">{w.well}</td>
													<td class="pr-4">{w.A ?? '—'}</td>
													<td class="pr-4">{w.B ?? '—'}</td>
													<td class="pr-4">{w.C ?? '—'}</td>
												</tr>
											{/each}
										</tbody>
									</table>
									{#if r.mag.failureReasons.length}
										<p class="mt-2 text-xs text-[var(--color-tron-red,#ef4444)]">{r.mag.failureReasons.join('; ')}</p>
									{/if}
									{#if r.screen.failureReasons.length}
										<p class="mt-2 text-xs text-[var(--color-tron-red,#ef4444)]">Screen: {r.screen.failureReasons.join('; ')}</p>
									{/if}
									{#if r.assayRun.failureReasons.length}
										<p class="mt-2 text-xs text-[var(--color-tron-red,#ef4444)]">Assay run: {r.assayRun.failureReasons.join('; ')}</p>
									{/if}
									{#if r.legacyOptics.ratios}
										<p class="tron-text-muted mt-2 text-xs">Legacy optics (no longer a gate): F7/F3 {fmtRatio(r.legacyOptics.ratios.A)} / {fmtRatio(r.legacyOptics.ratios.B)} / {fmtRatio(r.legacyOptics.ratios.C)} — {r.legacyOptics.status}</p>
									{/if}
								</td>
							</tr>
						{/if}
					{:else}
						<tr><td colspan="9" class="tron-text-muted py-8 text-center">No units{search.trim() ? ` match “${search}”` : ''}.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</TronCard>
</div>
