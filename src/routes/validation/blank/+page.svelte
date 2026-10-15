<script lang="ts">
	type Band = 'f1' | 'f2' | 'f3' | 'f4' | 'f5' | 'f6' | 'f7' | 'f8' | 'clear' | 'nir';
	type Verdict = 'pass' | 'fail' | 'incomplete';
	interface Channel { channel: 'A' | 'B' | 'C'; n: number; sums: Record<Band, number>; laserOutput: number | null }
	interface Run {
		id: string; spuUdi: string; barcode: string | null; receivedAt: string | null;
		durationS: number | null; numberOfReadings: number; partial: boolean; channels: Channel[];
		verdict: Verdict; reasons: string[];
	}
	interface Props {
		data: {
			devices: Array<{ udi: string; spuId: string | null; runs: Run[]; complete: number; latest: string | null; verdict: Verdict; reasons: string[] }>;
			total: number;
			bands: Band[];
			fullScanReadings: number;
			criteria: { fullScanReadings: number; readingsPerChannel: number; laserOutputMin: number };
		};
	}
	let { data }: Props = $props();
	const BAND_LABEL: Record<Band, string> = { f1: 'F1 415', f2: 'F2 445', f3: 'F3 480', f4: 'F4 515', f5: 'F5 555', f6: 'F6 590', f7: 'F7 630', f8: 'F8 680', clear: 'Clear', nir: 'NIR' };
	const CH_COLOR: Record<string, string> = { A: 'var(--color-tron-cyan)', B: 'var(--color-tron-orange)', C: 'var(--color-tron-purple)' };
	const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
	const num = (v: number) => v.toLocaleString();
	let open = $state<string | null>(null);
	let failedOnly = $state(false);
	const shown = $derived(failedOnly ? data.devices.filter((d) => d.verdict !== 'pass') : data.devices);
	const failing = $derived(data.devices.filter((d) => d.verdict !== 'pass').length);
	const VERDICT_STYLE: Record<Verdict, string> = {
		pass: 'color: var(--color-tron-green); background: rgba(0,255,100,0.12);',
		fail: 'color: var(--color-tron-red); background: rgba(255,0,0,0.12);',
		incomplete: 'color: var(--color-tron-orange); background: rgba(255,160,0,0.12);'
	};
</script>

<div class="space-y-6">
	<div>
		<h1 class="tron-heading text-2xl font-bold">Blank Cartridge Runs</h1>
		<p class="tron-text-muted mt-1 text-sm">
			One physical blank cartridge, scanned on unit after unit. The chemistry is held constant, so
			whatever differs between rows is the instrument. Runs arrive from the device over the Particle
			webhook (firmware v96, BLANK- barcode) — nothing to assign, link or re-arm. Each row is a
			channel's raw band totals: the sum of every band over that channel's 42 reads, no ratio.
			Nothing here is written back.
		</p>
		<p class="tron-text-muted mt-2 text-xs">
			<span class="tron-text-primary font-medium">Auto-check</span> — a run FAILS if it has fewer than
			{data.criteria.fullScanReadings} readings, any channel misses positions, a channel's mean laser
			output is below {data.criteria.laserOutputMin} (the laser never came on), or any band is empty.
			A unit's verdict is its latest run.
		</p>
	</div>

	{#if data.total === 0}
		<div class="tron-card p-6 text-sm text-[var(--color-tron-text-secondary)]">
			<p class="tron-text-primary font-medium">No blank runs yet.</p>
			<ol class="mt-2 list-decimal space-y-1 pl-5">
				<li>Units need firmware v96 (BLANK- barcode type) and the blank assay A87934B1 loaded from the research app's Devices page.</li>
				<li>Label the blank cartridge with a BLANK-XXXXXXX code (13 characters, like a THERMO- label).</li>
				<li>The Particle Console webhook for event <span class="font-mono">blank-test</span> must point at <span class="font-mono">/api/particle/webhook</span> with the agent API key header.</li>
				<li>Scan the blank on a unit; the run shows up here when the device publishes it.</li>
			</ol>
		</div>
	{:else}
		<div class="tron-card p-4">
			<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
				<h2 class="tron-heading text-sm font-semibold uppercase tracking-wide">
					Per device ({data.devices.length}) · {data.total} runs ·
					<span class={failing ? 'text-[var(--color-tron-red)]' : 'text-[var(--color-tron-green)]'}>{failing} failing</span>
				</h2>
				<label class="flex items-center gap-2 text-xs text-[var(--color-tron-text-secondary)]">
					<input type="checkbox" bind:checked={failedOnly} /> Failing only
				</label>
			</div>
			<div class="overflow-x-auto">
				<table class="w-full min-w-[40rem] text-sm">
					<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="py-2 pr-4 text-left font-medium">Unit</th>
							<th class="py-2 pr-4 text-left font-medium">Check</th>
							<th class="py-2 pr-4 text-left font-medium">Runs</th>
							<th class="py-2 pr-4 text-left font-medium" title="Runs with all {data.fullScanReadings} readings (42 positions × 3 channels)">Complete</th>
							<th class="py-2 text-left font-medium">Latest</th>
						</tr>
					</thead>
					<tbody class="font-mono">
						{#each shown as d (d.udi)}
							<tr class="border-b border-[var(--color-tron-border)]/50 cursor-pointer hover:bg-[var(--color-tron-bg-secondary)]/40" onclick={() => (open = open === d.udi ? null : d.udi)}>
								<td class="py-2 pr-4 font-bold text-[var(--color-tron-cyan)]">{d.udi} {open === d.udi ? '▴' : '▾'}</td>
								<td class="py-2 pr-4 font-sans">
									<span class="rounded-full px-2 py-0.5 text-xs font-bold uppercase" style={VERDICT_STYLE[d.verdict]} title={d.reasons.join('\n') || 'All channels read, lasers on'}>{d.verdict}</span>
									{#if d.reasons.length}<span class="ml-2 text-xs text-[var(--color-tron-red)]">{d.reasons[0]}{d.reasons.length > 1 ? ` (+${d.reasons.length - 1})` : ''}</span>{/if}
								</td>
								<td class="py-2 pr-4">{d.runs.length}</td>
								<td class="py-2 pr-4 {d.complete < d.runs.length ? 'text-amber-400' : ''}">{d.complete}</td>
								<td class="py-2 text-xs text-[var(--color-tron-text-secondary)]">{when(d.latest)}</td>
							</tr>
							{#if open === d.udi}
								<tr class="border-b border-[var(--color-tron-border)]">
									<td colspan="5" class="bg-[var(--color-tron-bg-secondary)]/40 px-4 py-3">
										<div class="overflow-x-auto">
											<table class="w-full min-w-[64rem] text-xs">
												<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
													<tr>
														<th class="pr-4 text-left font-medium">Received</th>
														<th class="pr-4 text-left font-medium">Blank code</th>
														<th class="pr-3 text-left font-medium">Ch</th>
														<th class="pr-3 text-right font-medium" title="Reads summed">n</th>
														<th class="pr-3 text-right font-medium" title="Mean laser_output over the channel's reads — needs ≥ {data.criteria.laserOutputMin}">Laser</th>
														{#each data.bands as b (b)}<th class="pr-3 text-right font-medium">{BAND_LABEL[b]}</th>{/each}
													</tr>
												</thead>
												<tbody class="font-mono tron-text-primary">
													{#each d.runs as r (r.id)}
														{#if r.numberOfReadings === 0}
															<tr class="border-t border-[var(--color-tron-border)]/40">
																<td class="pr-4 py-1 text-[var(--color-tron-text-secondary)]">{when(r.receivedAt)}</td>
																<td class="pr-4 py-1">{r.barcode ?? '—'}</td>
																<td colspan={data.bands.length + 3} class="py-1 font-sans text-[var(--color-tron-red)]">FAIL — no readings, the run was cancelled or cut short ({r.durationS ?? '?'} s).</td>
															</tr>
														{:else}
															{#each r.channels as c, i (c.channel)}
																<tr class={i === 0 ? 'border-t border-[var(--color-tron-border)]/40' : ''}>
																	{#if i === 0}
																		<td class="pr-4 py-0.5 align-top text-[var(--color-tron-text-secondary)]" rowspan="3">
																			{when(r.receivedAt)}{#if r.partial}<span class="ml-1 text-amber-400" title="{r.numberOfReadings} of {data.fullScanReadings} readings">⚠ {r.numberOfReadings}</span>{/if}
																			<div class="mt-0.5 font-sans"><span class="rounded-full px-1.5 text-[10px] font-bold uppercase" style={VERDICT_STYLE[r.verdict]} title={r.reasons.join('\n')}>{r.verdict}</span></div>
																		</td>
																		<td class="pr-4 py-0.5 align-top" rowspan="3">{r.barcode ?? '—'}</td>
																	{/if}
																	<td class="pr-3 py-0.5"><span class="mr-1 inline-block h-2 w-2 rounded-full align-middle" style="background: {CH_COLOR[c.channel]}"></span>{c.channel}</td>
																	<td class="pr-3 py-0.5 text-right text-[var(--color-tron-text-secondary)]">{c.n}</td>
																	<td class="pr-3 py-0.5 text-right {c.laserOutput != null && c.laserOutput < data.criteria.laserOutputMin ? 'text-[var(--color-tron-red)]' : ''}">{c.laserOutput == null ? '—' : Math.round(c.laserOutput)}</td>
																	{#each data.bands as b (b)}<td class="pr-3 py-0.5 text-right">{num(c.sums[b])}</td>{/each}
																</tr>
															{/each}
														{/if}
													{/each}
												</tbody>
											</table>
										</div>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</div>
