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
		return `${r.passedCount}/${r.total} validations passed this cycle — all three must pass first`;
	}

	let expanded = $state<string | null>(null);
	let search = $state('');

	// Rows arrive sorted most-recently-tested first; search filters within that.
	const filteredRows = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return data.rows;
		return data.rows.filter(
			(r: { udi: string; status: string }) =>
				r.udi.toLowerCase().includes(q) || r.status.toLowerCase().includes(q)
		);
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

	// Overall = the three instrument statuses for the CURRENT validation cycle
	// folded together: all passed → "Complete", any failed → "failed", else
	// "pending"; the n/3 beside it is how many have passed. The cycle resets
	// to 0/3 when a unit enters servicing (spu-validation-cycle.ts).
	// Cyan (info) rather than green keeps the per-modality green as the signal
	// that an individual test passed.
	function overallVariant(status: string): 'info' | 'error' | 'neutral' {
		if (status === 'passed' || status === 'overridden') return 'info';
		if (status === 'failed') return 'error';
		return 'neutral';
	}
	function overallLabel(status: string): string {
		return status === 'passed' || status === 'overridden' ? 'Complete' : status;
	}

	function fmtRatio(r: number | null): string {
		return r == null ? '—' : r.toFixed(2);
	}

	const LAUNCHERS = [
		{ href: '/validation/magnetometer', label: 'Magnetometer', desc: 'Read gauss values from a device' },
		{ href: '/validation/thermocouple', label: 'Thermocouple', desc: 'Upload a temperature dataset + verdict' },
		{ href: '/validation/optical-confirmation', label: 'Optical Confirmation', desc: 'Assign + analyze optics cartridges' }
	];
</script>

<div class="space-y-6">
	<div>
		<h1 class="text-xl font-bold text-[var(--color-tron-cyan)]">SPU Validation</h1>
		<p class="tron-text-muted text-sm">
			Fleet-wide validation status. Each instrument has its own page — this is where the whole
			picture lives.
		</p>
	</div>

	<!-- Launchers -->
	<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
		{#each LAUNCHERS as l (l.href)}
			<a href={l.href} class="block">
				<TronCard interactive>
					<div class="font-medium text-[var(--color-tron-cyan)]">{l.label} →</div>
					<div class="tron-text-muted mt-1 text-xs">{l.desc}</div>
				</TronCard>
			</a>
		{/each}
	</div>

	<!-- Fleet matrix -->
	<TronCard>
		<h3 class="tron-text-primary mb-3 text-lg font-medium">Fleet Matrix</h3>
		<p class="tron-text-muted mb-4 text-xs">
			Magnetometer shows the Z (gauss) range — expand a row for every point. Optics shows the
			average F7/F3 ratio per channel. Thermocouple shows the mode of the temperature plot.
			Only the current validation cycle counts — it resets to 0/3 when a unit enters servicing.
			Most recently tested first. Retired units are hidden.
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
						<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">Unit</th>
						<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">Overall</th>
						<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">Lifecycle</th>
						<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">Magnetometer (gauss)</th>
						<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">Optics ratio A / B / C</th>
						<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">Thermo mode</th>
						<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">Last test ▾</th>
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
								<TronBadge variant={overallVariant(r.overall)}>{overallLabel(r.overall)}</TronBadge>
								<span class="tron-text-muted ml-2 font-mono text-xs" title="Validations passed this cycle">{r.passedCount}/{r.total}</span>
							</td>
							<td class="py-2.5 pr-4">
								<TronBadge variant="neutral">{r.status}</TronBadge>
							</td>
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
							</td>
							<td class="py-2.5 pr-4 font-mono text-xs whitespace-nowrap">
								{#if r.optics.ratios}
									<TronBadge variant={badgeVariant(r.optics.status)}>{r.optics.status}</TronBadge>
									{#if r.optics.cartridgeBarcode}
									<a
										href="/validation/optical-confirmation/{r.optics.cartridgeBarcode}"
										class="ml-2 text-[var(--color-tron-cyan)] hover:underline"
										title="Open this cartridge's optical test results"
									>{fmtRatio(r.optics.ratios.A)} / {fmtRatio(r.optics.ratios.B)} / {fmtRatio(r.optics.ratios.C)}</a>
								{:else}
									<span class="ml-2">{fmtRatio(r.optics.ratios.A)} / {fmtRatio(r.optics.ratios.B)} / {fmtRatio(r.optics.ratios.C)}</span>
								{/if}
								{:else}
									<TronBadge variant={badgeVariant(r.optics.status)}>{r.optics.status}</TronBadge>
									<span class="tron-text-muted ml-2">—</span>
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
								<td colspan="8" class="bg-[var(--color-tron-bg-secondary)]/40 px-4 py-3">
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
								</td>
							</tr>
						{/if}
					{:else}
						<tr><td colspan="8" class="tron-text-muted py-8 text-center">No units{search.trim() ? ` match “${search}”` : ''}.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</TronCard>
</div>
