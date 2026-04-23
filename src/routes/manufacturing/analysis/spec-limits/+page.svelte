<script lang="ts">
	let { data, form } = $props();

	let editing = $state<string | null>(null);
	let draft = $state({
		id: '',
		processType: 'wax',
		metric: 'cycleTime',
		metricLabel: 'Cycle Time',
		unit: 'min',
		LSL: '',
		USL: '',
		target: '',
		cpkMin: 1.33,
		rationale: ''
	});

	function edit(s: any) {
		editing = s.id;
		draft = {
			id: s.id,
			processType: s.processType,
			metric: s.metric,
			metricLabel: s.metricLabel,
			unit: s.unit ?? '',
			LSL: s.LSL ?? '',
			USL: s.USL ?? '',
			target: s.target ?? '',
			cpkMin: s.cpkMin ?? 1.33,
			rationale: s.rationale ?? ''
		};
	}

	function reset() {
		editing = null;
		draft = { id: '', processType: 'wax', metric: 'cycleTime', metricLabel: 'Cycle Time', unit: 'min', LSL: '', USL: '', target: '', cpkMin: 1.33, rationale: '' };
	}
</script>

<div class="mx-auto max-w-5xl space-y-5 p-4">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Spec Limits</h1>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
				Per-process per-metric specification limits. Capability analysis (Cp, Cpk) only runs on metrics with active limits. Leave LSL or USL blank for one-sided specs.
			</p>
		</div>
		<a href="/manufacturing/analysis" class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs hover:border-[var(--color-tron-cyan)]" style="color: var(--color-tron-text)">← Back to Analysis</a>
	</div>

	{#if form?.success}
		<div class="rounded border border-green-500/50 bg-green-900/10 p-2 text-xs text-green-300">Saved.</div>
	{/if}
	{#if form?.error}
		<div class="rounded border border-red-500/50 bg-red-900/10 p-2 text-xs text-red-300">{form.error}</div>
	{/if}

	<section class="rounded-lg border border-[var(--color-tron-border)] p-4">
		<h2 class="mb-3 text-sm font-semibold" style="color: var(--color-tron-text)">{editing ? 'Edit' : 'New'} Spec Limit</h2>
		<form method="POST" action="?/save" class="grid gap-3 md:grid-cols-3">
			{#if editing}<input type="hidden" name="id" value={draft.id} />{/if}
			<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Process</label>
				<select name="processType" bind:value={draft.processType} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs">
					{#each data.processes as p}<option value={p.id}>{p.label}</option>{/each}
				</select></div>
			<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Metric *</label>
				<input name="metric" required bind:value={draft.metric} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs font-mono" placeholder="cycleTime, fpy, rejectionRate, …" /></div>
			<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Label</label>
				<input name="metricLabel" bind:value={draft.metricLabel} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" /></div>
			<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Unit</label>
				<input name="unit" bind:value={draft.unit} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs" /></div>
			<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">LSL (optional)</label>
				<input type="number" step="any" name="LSL" bind:value={draft.LSL} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs font-mono" /></div>
			<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">USL (optional)</label>
				<input type="number" step="any" name="USL" bind:value={draft.USL} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs font-mono" /></div>
			<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Target</label>
				<input type="number" step="any" name="target" bind:value={draft.target} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs font-mono" /></div>
			<div><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Cpk min (alert if below)</label>
				<input type="number" step="0.01" name="cpkMin" bind:value={draft.cpkMin} class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs font-mono" /></div>
			<div class="md:col-span-3"><label class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Rationale * (regulatory traceability — why these limits?)</label>
				<textarea name="rationale" required bind:value={draft.rationale} rows="3" class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs"></textarea></div>
			<div class="md:col-span-3 flex gap-2">
				<button type="submit" class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-2 text-xs font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20">{editing ? 'Update' : 'Create'}</button>
				{#if editing}<button type="button" onclick={reset} class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-xs">New entry</button>{/if}
			</div>
		</form>
	</section>

	<section class="rounded-lg border border-[var(--color-tron-border)] p-4">
		<h2 class="mb-3 text-sm font-semibold" style="color: var(--color-tron-text)">Current Spec Limits</h2>
		{#if data.specLimits.length === 0}
			<p class="text-xs" style="color: var(--color-tron-text-secondary)">No spec limits defined yet. Capability analysis (Cp/Cpk) stays off until limits are set.</p>
		{:else}
			<table class="w-full text-xs">
				<thead><tr class="border-b border-[var(--color-tron-border)] text-left" style="color: var(--color-tron-text-secondary)">
					<th class="px-2 py-1">Process</th><th class="px-2 py-1">Metric</th><th class="px-2 py-1">Unit</th>
					<th class="px-2 py-1">LSL</th><th class="px-2 py-1">Target</th><th class="px-2 py-1">USL</th>
					<th class="px-2 py-1">Cpk min</th><th class="px-2 py-1">Approver</th><th class="px-2 py-1">Status</th><th></th>
				</tr></thead>
				<tbody>
					{#each data.specLimits as s}
						<tr class="border-b border-[var(--color-tron-border)]/50">
							<td class="px-2 py-1">{s.processLabel}</td>
							<td class="px-2 py-1 font-mono">{s.metric}</td>
							<td class="px-2 py-1">{s.unit}</td>
							<td class="px-2 py-1 font-mono">{s.LSL ?? '—'}</td>
							<td class="px-2 py-1 font-mono">{s.target ?? '—'}</td>
							<td class="px-2 py-1 font-mono">{s.USL ?? '—'}</td>
							<td class="px-2 py-1 font-mono">{s.cpkMin}</td>
							<td class="px-2 py-1">{s.approvedBy ?? '—'}</td>
							<td class="px-2 py-1">{s.active ? 'active' : 'retired'}</td>
							<td class="px-2 py-1 whitespace-nowrap">
								<button onclick={() => edit(s)} class="rounded border border-[var(--color-tron-border)] px-2 py-0.5 text-[10px] hover:border-[var(--color-tron-cyan)]">Edit</button>
								{#if s.active}
									<form method="POST" action="?/retire" class="inline">
										<input type="hidden" name="id" value={s.id} />
										<button class="rounded border border-[var(--color-tron-border)] px-2 py-0.5 text-[10px] hover:border-red-500 hover:text-red-400">Retire</button>
									</form>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>
</div>
