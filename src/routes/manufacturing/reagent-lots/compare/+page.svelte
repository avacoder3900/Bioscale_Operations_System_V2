<script lang="ts">
	import type { PageData } from './$types';

	interface Props { data: PageData }
	let { data }: Props = $props();

	function elapsedHours(start: string | Date | null, end: string | Date | null): string {
		if (!start || !end) return '—';
		const ms = new Date(end).getTime() - new Date(start).getTime();
		return (ms / 3_600_000).toFixed(2) + ' h';
	}

	function readingFor(lot: any, stepKey: string, checkpointKey: string): { value: any; flag: string } {
		const entry = lot.stepEntries?.find((e: any) => e.stepKey === stepKey);
		const r = entry?.qcReadings?.find((q: any) => q.checkpointKey === checkpointKey);
		return { value: r?.value ?? '', flag: r?.flag ?? 'unmeasured' };
	}

	function postReadingFor(lot: any, assayKey: string, readingKey: string): { value: any; flag: string } {
		const r = lot.postProtocolReadings?.find((q: any) => q.checkpointKey === readingKey);
		return { value: r?.value ?? '', flag: r?.flag ?? 'unmeasured' };
	}

	function paramFor(lot: any, key: string): any {
		return lot.parameterValues?.find((p: any) => p.key === key)?.value ?? '';
	}

	function obsFor(lot: any, stepKey: string, promptKey: string): string {
		const entry = lot.stepEntries?.find((e: any) => e.stepKey === stepKey);
		const o = entry?.observations?.find((o: any) => o.promptKey === promptKey);
		return o?.body ?? '';
	}

	function flagCellClass(flag: string): string {
		if (flag === 'out-of-range') return 'bg-amber-500/10 text-amber-300';
		if (flag === 'in-range') return 'bg-emerald-500/5 text-emerald-300';
		return '';
	}

	function toCSV(): string {
		if (!data.template || !data.selectedLots.length) return '';
		const tpl = data.template;
		const lots = data.selectedLots;
		const rows: string[][] = [];
		// Header
		rows.push(['Field', ...lots.map((l: any) => l.lotBarcode)]);
		rows.push(['Operator', ...lots.map((l: any) => l.operator?.username ?? '')]);
		rows.push(['Status', ...lots.map((l: any) => l.status)]);
		rows.push(['Started', ...lots.map((l: any) => l.startedAt ?? '')]);
		rows.push(['Finalized', ...lots.map((l: any) => l.finalizedAt ?? '')]);
		rows.push(['Elapsed', ...lots.map((l: any) => elapsedHours(l.startedAt, l.finalizedAt))]);
		rows.push(['Flags', ...lots.map((l: any) => String(l.flags?.length ?? 0))]);
		rows.push([]);
		rows.push(['— Parameters —']);
		for (const p of tpl.parameters ?? []) {
			rows.push([`${p.label} (${p.unit ?? ''})`, ...lots.map((l: any) => String(paramFor(l, p.key)))]);
		}
		rows.push([]);
		rows.push(['— QC Readings —']);
		for (const s of tpl.steps ?? []) {
			for (const c of s.qcCheckpoints ?? []) {
				rows.push([
					`Step ${s.number} · ${c.label} (${c.unit ?? ''})`,
					...lots.map((l: any) => String(readingFor(l, s.key, c.key).value))
				]);
			}
		}
		rows.push([]);
		rows.push(['— Post-Protocol Assays —']);
		for (const a of tpl.postProtocolAssays ?? []) {
			for (const r of a.readings ?? []) {
				rows.push([
					`${a.label} · ${r.label} (${r.unit ?? ''})`,
					...lots.map((l: any) => String(postReadingFor(l, a.key, r.key).value))
				]);
			}
		}
		rows.push([]);
		rows.push(['— Final Outputs —']);
		rows.push(['Concentration', ...lots.map((l: any) => `${l.finalOutputs?.concentration ?? ''} ${l.finalOutputs?.concentrationUnit ?? ''}`.trim())]);
		rows.push(['Volume', ...lots.map((l: any) => `${l.finalOutputs?.volume ?? ''} ${l.finalOutputs?.volumeUnit ?? ''}`.trim())]);
		rows.push(['Output Notes', ...lots.map((l: any) => (l.finalOutputs?.notes ?? '').replace(/\n/g, ' '))]);
		rows.push(['Final Observations', ...lots.map((l: any) => (l.finalObservations ?? '').replace(/\n/g, ' '))]);

		return rows.map((row) => row.map((c) => `"${(c ?? '').toString().replace(/"/g, '""')}"`).join(',')).join('\n');
	}

	function downloadCSV() {
		const csv = toCSV();
		const blob = new Blob([csv], { type: 'text/csv' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `reagent-lots-compare-${data.template?.slug ?? 'lots'}.csv`;
		a.click();
		URL.revokeObjectURL(url);
	}

	let selectedIds = $state<string[]>(data.filters.lotIds);

	function rebuildUrl(): string {
		const params = new URLSearchParams();
		if (data.filters.slug) params.set('template', data.filters.slug);
		if (selectedIds.length) params.set('lots', selectedIds.join(','));
		return '?' + params.toString();
	}
</script>

<div class="space-y-4">
	<div>
		<a href="/manufacturing/reagent-lots" class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">
			← Back to all lots
		</a>
		<h1 class="text-xl font-semibold text-[var(--color-tron-text)]">Compare Reagent Lots</h1>
		<p class="text-sm text-[var(--color-tron-text-secondary)]">
			Pick a protocol, then 2 or more lots to put side by side. CSV export uses the same shape.
		</p>
	</div>

	<form method="GET" class="flex flex-wrap items-end gap-3 rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-3">
		<div>
			<label class="block text-xs text-[var(--color-tron-text-secondary)]" for="cmp-template">Protocol</label>
			<select id="cmp-template" name="template" value={data.filters.slug}
				class="rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]">
				<option value="">— pick a protocol —</option>
				{#each data.templates as t}
					<option value={t.slug}>{t.name} (v{t.version})</option>
				{/each}
			</select>
		</div>
		<button type="submit" class="rounded-md bg-[var(--color-tron-cyan)]/20 px-3 py-1 text-sm text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/30">
			Load Lots
		</button>
	</form>

	{#if data.template}
		<div class="rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-3 space-y-2">
			<h2 class="text-sm font-semibold text-[var(--color-tron-text)]">
				Pick lots to compare — {data.template.name}
			</h2>
			<div class="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
				{#each data.candidateLots as c}
					<label class="flex items-center gap-2 rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-2 py-1 text-xs text-[var(--color-tron-text)]">
						<input type="checkbox" bind:group={selectedIds} value={c._id} />
						<span class="font-mono">{c.lotBarcode}</span>
						<span class="text-[var(--color-tron-text-secondary)]">v{c.templateVersion} · {c.operator?.username ?? '—'} · {c.status}</span>
					</label>
				{:else}
					<p class="text-xs text-[var(--color-tron-text-secondary)]">No lots exist for this protocol yet.</p>
				{/each}
			</div>
			<div class="flex justify-end">
				<a href={rebuildUrl()}
					class="rounded-md bg-[var(--color-tron-cyan)]/20 px-3 py-1.5 text-sm text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/30">
					Compare ({selectedIds.length})
				</a>
			</div>
		</div>
	{/if}

	{#if data.selectedLots.length && data.template}
		{@const tpl = data.template}
		{@const lots = data.selectedLots}
		<div class="flex justify-end">
			<button onclick={downloadCSV}
				class="rounded-md border border-[var(--color-tron-border)] px-3 py-1.5 text-sm text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-surface)] hover:text-[var(--color-tron-text)]">
				⤓ Download CSV
			</button>
		</div>

		<div class="overflow-x-auto rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)]">
			<table class="min-w-full text-sm">
				<thead class="bg-[var(--color-tron-surface)] text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]">
					<tr>
						<th class="px-2 py-1 text-left">Field</th>
						{#each lots as l}
							<th class="px-2 py-1 text-left">
								<a href={`/manufacturing/reagent-lots/${l._id}`} class="font-mono text-[var(--color-tron-cyan)] hover:underline">{l.lotBarcode}</a>
								<div class="text-[var(--color-tron-text-secondary)] normal-case font-normal">
									{l.operator?.username ?? '—'} · {l.status}
								</div>
							</th>
						{/each}
					</tr>
				</thead>
				<tbody class="divide-y divide-[var(--color-tron-border)] text-[var(--color-tron-text)]">
					<tr><th class="px-2 py-1 text-left text-xs uppercase text-[var(--color-tron-text-secondary)]" colspan={lots.length + 1}>Run Metadata</th></tr>
					<tr>
						<th class="px-2 py-1 text-left text-xs text-[var(--color-tron-text-secondary)]">Started</th>
						{#each lots as l}<td class="px-2 py-1 text-xs">{l.startedAt ? new Date(l.startedAt).toLocaleString() : '—'}</td>{/each}
					</tr>
					<tr>
						<th class="px-2 py-1 text-left text-xs text-[var(--color-tron-text-secondary)]">Finalized</th>
						{#each lots as l}<td class="px-2 py-1 text-xs">{l.finalizedAt ? new Date(l.finalizedAt).toLocaleString() : '—'}</td>{/each}
					</tr>
					<tr>
						<th class="px-2 py-1 text-left text-xs text-[var(--color-tron-text-secondary)]">Elapsed</th>
						{#each lots as l}<td class="px-2 py-1 text-xs">{elapsedHours(l.startedAt, l.finalizedAt)}</td>{/each}
					</tr>
					<tr>
						<th class="px-2 py-1 text-left text-xs text-[var(--color-tron-text-secondary)]">Flags</th>
						{#each lots as l}
							<td class="px-2 py-1 text-xs {(l.flags?.length ?? 0) > 0 ? 'text-amber-300' : ''}">{l.flags?.length ?? 0}</td>
						{/each}
					</tr>

					<tr><th class="bg-[var(--color-tron-surface)] px-2 py-1 text-left text-xs uppercase text-[var(--color-tron-text-secondary)]" colspan={lots.length + 1}>Parameters</th></tr>
					{#each tpl.parameters as p}
						<tr>
							<th class="px-2 py-1 text-left text-xs text-[var(--color-tron-text-secondary)]">{p.label} <span class="text-[10px]">({p.unit ?? ''})</span></th>
							{#each lots as l}<td class="px-2 py-1 font-mono text-xs">{paramFor(l, p.key)}</td>{/each}
						</tr>
					{/each}

					<tr><th class="bg-[var(--color-tron-surface)] px-2 py-1 text-left text-xs uppercase text-[var(--color-tron-text-secondary)]" colspan={lots.length + 1}>QC Readings</th></tr>
					{#each tpl.steps as s}
						{#each s.qcCheckpoints ?? [] as c}
							<tr>
								<th class="px-2 py-1 text-left text-xs text-[var(--color-tron-text-secondary)]">
									<span class="text-[10px] opacity-60">Step {s.number}</span> · {c.label}
								</th>
								{#each lots as l}
									{@const v = readingFor(l, s.key, c.key)}
									<td class="px-2 py-1 font-mono text-xs {flagCellClass(v.flag)}">
										{v.value !== '' ? v.value : '—'}
										{#if c.unit}<span class="text-[10px] opacity-60">{c.unit}</span>{/if}
									</td>
								{/each}
							</tr>
						{/each}
						{#each s.observationPrompts ?? [] as p}
							<tr>
								<th class="px-2 py-1 text-left text-xs text-[var(--color-tron-text-secondary)]">
									<span class="text-[10px] opacity-60">Step {s.number}</span> · {p.label}
								</th>
								{#each lots as l}
									<td class="px-2 py-1 text-xs italic text-[var(--color-tron-text-secondary)]">{obsFor(l, s.key, p.key) || '—'}</td>
								{/each}
							</tr>
						{/each}
					{/each}

					{#if tpl.postProtocolAssays?.length}
						<tr><th class="bg-[var(--color-tron-surface)] px-2 py-1 text-left text-xs uppercase text-[var(--color-tron-text-secondary)]" colspan={lots.length + 1}>Post-Protocol Assays</th></tr>
						{#each tpl.postProtocolAssays as a}
							{#each a.readings ?? [] as r}
								<tr>
									<th class="px-2 py-1 text-left text-xs text-[var(--color-tron-text-secondary)]">
										<span class="text-[10px] opacity-60">{a.label}</span> · {r.label}
									</th>
									{#each lots as l}
										{@const v = postReadingFor(l, a.key, r.key)}
										<td class="px-2 py-1 font-mono text-xs {flagCellClass(v.flag)}">{v.value !== '' ? v.value : '—'} {r.unit ?? ''}</td>
									{/each}
								</tr>
							{/each}
						{/each}
					{/if}

					<tr><th class="bg-[var(--color-tron-surface)] px-2 py-1 text-left text-xs uppercase text-[var(--color-tron-text-secondary)]" colspan={lots.length + 1}>Final Outputs</th></tr>
					<tr>
						<th class="px-2 py-1 text-left text-xs text-[var(--color-tron-text-secondary)]">Concentration</th>
						{#each lots as l}<td class="px-2 py-1 font-mono text-xs">{l.finalOutputs?.concentration ?? '—'} {l.finalOutputs?.concentrationUnit ?? ''}</td>{/each}
					</tr>
					<tr>
						<th class="px-2 py-1 text-left text-xs text-[var(--color-tron-text-secondary)]">Volume</th>
						{#each lots as l}<td class="px-2 py-1 font-mono text-xs">{l.finalOutputs?.volume ?? '—'} {l.finalOutputs?.volumeUnit ?? ''}</td>{/each}
					</tr>
					<tr>
						<th class="px-2 py-1 text-left text-xs text-[var(--color-tron-text-secondary)]">Final Observations</th>
						{#each lots as l}<td class="px-2 py-1 text-xs italic text-[var(--color-tron-text-secondary)]">{l.finalObservations || '—'}</td>{/each}
					</tr>
				</tbody>
			</table>
		</div>
	{:else if data.template}
		<p class="text-sm text-[var(--color-tron-text-secondary)]">Select 2+ lots above and click Compare.</p>
	{/if}
</div>
