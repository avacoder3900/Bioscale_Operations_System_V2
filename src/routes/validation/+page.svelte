<script lang="ts">
	import { TronCard, TronBadge } from '$lib/components/ui';

	let { data } = $props();

	let expanded = $state<string | null>(null);

	function badgeVariant(status: string): 'success' | 'error' | 'warning' | 'neutral' {
		if (status === 'passed' || status === 'overridden') return 'success';
		if (status === 'failed') return 'error';
		return 'neutral';
	}

	function fmtRatio(r: number | null): string {
		return r == null ? '—' : r.toFixed(2);
	}

	const LAUNCHERS = [
		{ href: '/validation/magnetometer', label: 'Magnetometer', desc: 'Read gauss values from a device' },
		{ href: '/validation/thermocouple', label: 'Thermocouple', desc: 'Upload a temperature dataset + verdict' },
		{ href: '/validation/optical-confirmation', label: 'Optical Confirmation', desc: 'Assign + analyze optics cartridges' },
		{ href: '/validation/runs', label: 'Validation Runs', desc: 'Multi-unit validation checklists' }
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

	<!-- Metric tiles -->
	<div class="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
		<TronCard>
			<div class="text-center">
				<div class="tron-text-primary font-mono text-3xl font-bold">{data.metrics.activeUnits}</div>
				<div class="tron-text-muted text-sm">Active Units</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="font-mono text-3xl font-bold text-[var(--color-tron-green)]">{data.metrics.fullyValidated}</div>
				<div class="tron-text-muted text-sm">Fully Validated</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="font-mono text-3xl font-bold text-[var(--color-tron-yellow,#fbbf24)]">{data.metrics.inValidating}</div>
				<div class="tron-text-muted text-sm">In Validating</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="font-mono text-3xl font-bold text-[var(--color-tron-red,#ef4444)]">{data.metrics.anyFailed}</div>
				<div class="tron-text-muted text-sm">Any Modality Failed</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="tron-text-primary font-mono text-3xl font-bold">{data.metrics.sessions7d}</div>
				<div class="tron-text-muted text-sm">Sessions (7d)</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="text-center">
				<div class="tron-text-primary font-mono text-3xl font-bold">{data.metrics.runsOpen}</div>
				<div class="tron-text-muted text-sm">Open Runs</div>
			</div>
		</TronCard>
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
			Retired units are hidden.
		</p>
		<div class="overflow-x-auto">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-[var(--color-tron-border)] text-left">
						<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">Unit</th>
						<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">Lifecycle</th>
						<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">Magnetometer (gauss)</th>
						<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">Optics ratio A / B / C</th>
						<th class="py-2 pr-4 text-xs uppercase text-[var(--color-tron-text-secondary)]">Thermo mode</th>
						<th class="py-2 text-xs uppercase text-[var(--color-tron-text-secondary)]">Overall</th>
					</tr>
				</thead>
				<tbody>
					{#each data.rows as r (r.id)}
						<tr class="border-b border-[var(--color-tron-border)] last:border-0">
							<td class="py-2.5 pr-4 whitespace-nowrap">
								<a href="/spu/{r.id}" class="font-mono font-bold text-[var(--color-tron-cyan)] hover:underline">{r.udi}</a>
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
									<span class="ml-2">{fmtRatio(r.optics.ratios.A)} / {fmtRatio(r.optics.ratios.B)} / {fmtRatio(r.optics.ratios.C)}</span>
								{:else}
									<TronBadge variant={badgeVariant(r.optics.status)}>{r.optics.status}</TronBadge>
									<span class="tron-text-muted ml-2">—</span>
								{/if}
							</td>
							<td class="py-2.5 pr-4 font-mono whitespace-nowrap">
								{#if r.thermo.mode != null}
									<TronBadge variant={badgeVariant(r.thermo.status)}>{r.thermo.status}</TronBadge>
									<span class="ml-2">{r.thermo.mode}°C</span>
								{:else}
									<TronBadge variant={badgeVariant(r.thermo.status)}>{r.thermo.status}</TronBadge>
									<span class="tron-text-muted ml-2">—</span>
								{/if}
							</td>
							<td class="py-2.5">
								<TronBadge variant={badgeVariant(r.overall)}>{r.overall}</TronBadge>
							</td>
						</tr>
						{#if expanded === r.id && r.mag.wells}
							<tr class="border-b border-[var(--color-tron-border)]">
								<td colspan="6" class="bg-[var(--color-tron-bg-secondary)]/40 px-4 py-3">
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
						<tr><td colspan="6" class="tron-text-muted py-8 text-center">No active units.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</TronCard>
</div>
