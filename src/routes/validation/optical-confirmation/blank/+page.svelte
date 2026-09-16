<script lang="ts">
	interface Stat { mean: number | null; sd: number | null; cv: number | null; n: number }
	interface Run {
		id: string; spuUdi: string; barcode: string | null; startTime: string | null; receivedAt: string | null;
		numberOfReadings: number;
		ratio: { A: number | null; B: number | null; C: number | null };
		channelCv: { A: number | null; B: number | null; C: number | null };
		crossWellCv: number | null; warning: boolean; reasons: string[];
	}
	interface Props {
		data: {
			devices: Array<{ udi: string; spuId: string | null; runs: Run[]; A: Stat; B: Stat; C: Stat; latest: string | null }>;
			fleet: Array<{ channel: 'A' | 'B' | 'C'; n: number; mean: number | null; sd: number | null; cv: number | null }>;
			total: number;
		};
	}
	let { data }: Props = $props();
	const CH: Array<'A' | 'B' | 'C'> = ['A', 'B', 'C'];
	const fmt = (v: number | null | undefined, dp = 2) => (v == null ? '—' : v.toFixed(dp));
	const pct = (v: number | null | undefined, dp = 1) => (v == null ? '—' : `${v.toFixed(dp)}%`);
	const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
	let open = $state<string | null>(null);
</script>

<div class="space-y-6">
	<div>
		<a href="/validation/optical-confirmation" class="text-sm text-[var(--color-tron-cyan)] hover:underline">← Optical Confirmation</a>
		<h1 class="tron-heading mt-1 text-2xl font-bold">Blank Cartridge Runs</h1>
		<p class="tron-text-muted mt-1 text-sm">
			One physical blank cartridge, scanned on unit after unit. The chemistry is held constant, so
			whatever differs between rows is the instrument. Runs arrive from the device over the Particle
			webhook (firmware v95, BLANK- barcode) — nothing to assign, link or re-arm. Raw F7/F3 over all
			42 positions; nothing here is written back.
		</p>
	</div>

	{#if data.total === 0}
		<div class="tron-card p-6 text-sm text-[var(--color-tron-text-secondary)]">
			<p class="tron-text-primary font-medium">No blank runs yet.</p>
			<ol class="mt-2 list-decimal space-y-1 pl-5">
				<li>Units need firmware v95 (BLANK- barcode type) and the blank assay A87934B1 loaded from the research app's Devices page.</li>
				<li>Label the blank cartridge with a BLANK-XXXXXXX code (13 characters, like a THERMO- label).</li>
				<li>The Particle Console webhook for event <span class="font-mono">blank-test</span> must point at <span class="font-mono">/api/particle/webhook</span> with the agent API key header.</li>
				<li>Scan the blank on a unit; the run shows up here when the device publishes it.</li>
			</ol>
		</div>
	{:else}
		<div class="tron-card p-4">
			<h2 class="tron-heading mb-2 text-sm font-semibold uppercase tracking-wide">Across devices — latest run each</h2>
			<table class="text-sm">
				<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
					<tr><th class="pr-6 text-left font-medium">Channel</th><th class="pr-6 text-left font-medium">Devices</th><th class="pr-6 text-left font-medium">Mean</th><th class="pr-6 text-left font-medium">SD</th><th class="text-left font-medium">CV</th></tr>
				</thead>
				<tbody class="font-mono tron-text-primary">
					{#each data.fleet as f (f.channel)}
						<tr><td class="pr-6">{f.channel}</td><td class="pr-6">{f.n}</td><td class="pr-6">{fmt(f.mean, 3)}</td><td class="pr-6">{fmt(f.sd, 3)}</td><td class={f.cv != null && f.cv > 15 ? 'text-amber-400' : ''}>{pct(f.cv)}</td></tr>
					{/each}
				</tbody>
			</table>
			<p class="tron-text-muted mt-2 text-xs">Same cartridge everywhere, so this spread is device-to-device difference, not chemistry.</p>
		</div>

		<div class="tron-card p-4">
			<h2 class="tron-heading mb-3 text-sm font-semibold uppercase tracking-wide">Per device ({data.devices.length}) · {data.total} runs</h2>
			<div class="overflow-x-auto">
				<table class="w-full min-w-[56rem] text-sm">
					<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="py-2 pr-4 text-left font-medium">Unit</th>
							<th class="py-2 pr-4 text-left font-medium">Runs</th>
							<th class="py-2 pr-4 text-left font-medium">A</th>
							<th class="py-2 pr-4 text-left font-medium">B</th>
							<th class="py-2 pr-4 text-left font-medium">C</th>
							<th class="py-2 pr-4 text-left font-medium" title="Run-to-run CV of each channel on this unit">Repeatability A / B / C</th>
							<th class="py-2 text-left font-medium">Latest</th>
						</tr>
					</thead>
					<tbody class="font-mono">
						{#each data.devices as d (d.udi)}
							<tr class="border-b border-[var(--color-tron-border)]/50 cursor-pointer hover:bg-[var(--color-tron-bg-secondary)]/40" onclick={() => (open = open === d.udi ? null : d.udi)}>
								<td class="py-2 pr-4 font-bold text-[var(--color-tron-cyan)]">{d.spuId ? '' : ''}{d.udi} {open === d.udi ? '▴' : '▾'}</td>
								<td class="py-2 pr-4">{d.runs.length}</td>
								{#each CH as ch}
									<td class="py-2 pr-4 tron-text-primary">{fmt(d[ch].mean, 3)}</td>
								{/each}
								<td class="py-2 pr-4 text-xs">
									{#each CH as ch, i}
										<span class={d[ch].cv != null && d[ch].cv > 5 ? 'text-amber-400' : ''}>{pct(d[ch].cv)}</span>{i < 2 ? ' / ' : ''}
									{/each}
								</td>
								<td class="py-2 text-xs text-[var(--color-tron-text-secondary)]">{when(d.latest)}</td>
							</tr>
							{#if open === d.udi}
								<tr class="border-b border-[var(--color-tron-border)]">
									<td colspan="7" class="bg-[var(--color-tron-bg-secondary)]/40 px-4 py-3">
										<table class="w-full text-xs">
											<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
												<tr><th class="pr-4 text-left font-medium">When</th><th class="pr-4 text-left font-medium">Blank code</th><th class="pr-4 text-left font-medium">A</th><th class="pr-4 text-left font-medium">B</th><th class="pr-4 text-left font-medium">C</th><th class="pr-4 text-left font-medium" title="Within-scan CV per channel">Scan CV A / B / C</th><th class="pr-4 text-left font-medium">Cross-well</th><th class="text-left font-medium">Flags</th></tr>
											</thead>
											<tbody class="font-mono tron-text-primary">
												{#each d.runs as r (r.id)}
													<tr>
														<td class="pr-4 py-0.5">{when(r.startTime)}</td>
														<td class="pr-4 py-0.5">{r.barcode ?? '—'}</td>
														{#each CH as ch}<td class="pr-4 py-0.5">{fmt(r.ratio[ch], 3)}</td>{/each}
														<td class="pr-4 py-0.5">{pct(r.channelCv.A)} / {pct(r.channelCv.B)} / {pct(r.channelCv.C)}</td>
														<td class="pr-4 py-0.5 {r.crossWellCv != null && r.crossWellCv > 15 ? 'text-amber-400' : ''}">{pct(r.crossWellCv)}</td>
														<td class="py-0.5 font-sans text-[var(--color-tron-text-secondary)]" title={r.reasons.join('\n')}>{r.warning ? '⚠' : '—'}</td>
													</tr>
												{/each}
											</tbody>
										</table>
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
