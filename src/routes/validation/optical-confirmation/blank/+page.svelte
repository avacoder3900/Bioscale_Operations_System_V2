<script lang="ts">
	type Band = 'f1' | 'f2' | 'f3' | 'f4' | 'f5' | 'f6' | 'f7' | 'f8' | 'clear' | 'nir';
	interface Channel { channel: 'A' | 'B' | 'C'; n: number; sums: Record<Band, number>; ratio: number | null; ratioN: number }
	interface Run {
		id: string; spuUdi: string; barcode: string | null; receivedAt: string | null;
		durationS: number | null; numberOfReadings: number; partial: boolean; channels: Channel[];
	}
	interface Props {
		data: {
			devices: Array<{ udi: string; spuId: string | null; runs: Run[]; complete: number; latest: string | null }>;
			total: number;
			bands: Band[];
			fullScanReadings: number;
		};
	}
	let { data }: Props = $props();
	const BAND_LABEL: Record<Band, string> = { f1: 'F1 415', f2: 'F2 445', f3: 'F3 480', f4: 'F4 515', f5: 'F5 555', f6: 'F6 590', f7: 'F7 630', f8: 'F8 680', clear: 'Clear', nir: 'NIR' };
	const CH_COLOR: Record<string, string> = { A: 'var(--color-tron-cyan)', B: 'var(--color-tron-orange)', C: 'var(--color-tron-purple)' };
	const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
	const num = (v: number) => v.toLocaleString();
	let open = $state<string | null>(null);
</script>

<div class="space-y-6">
	<div>
		<a href="/validation/optical-confirmation" class="text-sm text-[var(--color-tron-cyan)] hover:underline">← Optical Confirmation</a>
		<h1 class="tron-heading mt-1 text-2xl font-bold">Blank Cartridge Runs</h1>
		<p class="tron-text-muted mt-1 text-sm">
			One physical blank cartridge, scanned on unit after unit. The chemistry is held constant, so
			whatever differs between rows is the instrument. Runs arrive from the device over the Particle
			webhook (firmware v96, BLANK- barcode) — nothing to assign, link or re-arm. Each row is a
			channel's raw band totals: the sum of every band over that channel's 42 reads, no ratio.
			Nothing here is written back.
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
			<h2 class="tron-heading mb-3 text-sm font-semibold uppercase tracking-wide">Per device ({data.devices.length}) · {data.total} runs</h2>
			<div class="overflow-x-auto">
				<table class="w-full min-w-[40rem] text-sm">
					<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="py-2 pr-4 text-left font-medium">Unit</th>
							<th class="py-2 pr-4 text-left font-medium">Runs</th>
							<th class="py-2 pr-4 text-left font-medium" title="Runs with all {data.fullScanReadings} readings (42 positions × 3 channels)">Complete</th>
							<th class="py-2 text-left font-medium">Latest</th>
						</tr>
					</thead>
					<tbody class="font-mono">
						{#each data.devices as d (d.udi)}
							<tr class="border-b border-[var(--color-tron-border)]/50 cursor-pointer hover:bg-[var(--color-tron-bg-secondary)]/40" onclick={() => (open = open === d.udi ? null : d.udi)}>
								<td class="py-2 pr-4 font-bold text-[var(--color-tron-cyan)]">{d.udi} {open === d.udi ? '▴' : '▾'}</td>
								<td class="py-2 pr-4">{d.runs.length}</td>
								<td class="py-2 pr-4 {d.complete < d.runs.length ? 'text-amber-400' : ''}">{d.complete}</td>
								<td class="py-2 text-xs text-[var(--color-tron-text-secondary)]">{when(d.latest)}</td>
							</tr>
							{#if open === d.udi}
								<tr class="border-b border-[var(--color-tron-border)]">
									<td colspan="4" class="bg-[var(--color-tron-bg-secondary)]/40 px-4 py-3">
										<div class="overflow-x-auto">
											<table class="w-full min-w-[64rem] text-xs">
												<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
													<tr>
														<th class="pr-4 text-left font-medium">Received</th>
														<th class="pr-4 text-left font-medium">Blank code</th>
														<th class="pr-3 text-left font-medium">Ch</th>
														<th class="pr-3 text-right font-medium" title="Reads summed">n</th>
														{#each data.bands as b (b)}<th class="pr-3 text-right font-medium">{BAND_LABEL[b]}</th>{/each}
														<th
															class="pr-3 text-right font-medium text-[var(--color-tron-text-secondary)]"
															title="Mean of the per-reading F7/F3 for this channel — the metric the other optical assays report. Band totals above are the primary figure for blanks."
														>F7/F3</th>
													</tr>
												</thead>
												<tbody class="font-mono tron-text-primary">
													{#each d.runs as r (r.id)}
														{#if r.numberOfReadings === 0}
															<tr class="border-t border-[var(--color-tron-border)]/40">
																<td class="pr-4 py-1 text-[var(--color-tron-text-secondary)]">{when(r.receivedAt)}</td>
																<td class="pr-4 py-1">{r.barcode ?? '—'}</td>
																<td colspan={data.bands.length + 3} class="py-1 font-sans text-amber-400">No readings — the run was cancelled or cut short ({r.durationS ?? '?'} s).</td>
															</tr>
														{:else}
															{#each r.channels as c, i (c.channel)}
																<tr class={i === 0 ? 'border-t border-[var(--color-tron-border)]/40' : ''}>
																	{#if i === 0}
																		<td class="pr-4 py-0.5 align-top text-[var(--color-tron-text-secondary)]" rowspan="3">{when(r.receivedAt)}{#if r.partial}<span class="ml-1 text-amber-400" title="{r.numberOfReadings} of {data.fullScanReadings} readings">⚠ {r.numberOfReadings}</span>{/if}</td>
																		<td class="pr-4 py-0.5 align-top" rowspan="3">{r.barcode ?? '—'}</td>
																	{/if}
																	<td class="pr-3 py-0.5"><span class="mr-1 inline-block h-2 w-2 rounded-full align-middle" style="background: {CH_COLOR[c.channel]}"></span>{c.channel}</td>
																	<td class="pr-3 py-0.5 text-right text-[var(--color-tron-text-secondary)]">{c.n}</td>
																	{#each data.bands as b (b)}<td class="pr-3 py-0.5 text-right">{num(c.sums[b])}</td>{/each}
																	<td
																		class="pr-3 py-0.5 text-right text-[var(--color-tron-text-secondary)]"
																		title={c.ratio === null ? 'No reading had a positive F3' : `mean of ${c.ratioN} per-reading ratios`}
																	>{c.ratio === null ? '—' : c.ratio.toFixed(3)}</td>
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
