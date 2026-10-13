<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { TronCard, TronBadge, TronButton } from '$lib/components/ui';

	let { data, form } = $props();

	let spuId = $state('');
	let name = $state('');
	let scanned = $state('');
	let showCriteria = $state(false);
	let expanded = $state<string | null>(null);
	let compareA = $state('');
	let compareB = $state('');

	const selectedUdi = $derived(data.spus.find((s: any) => s.id === spuId)?.udi ?? null);
	const pickable = $derived(data.recent.filter((c: any) => !selectedUdi || c.spuUdi === selectedUdi));
	const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
	const n = (v: number | null | undefined, d = 2) => (v == null ? '—' : Number(v).toFixed(d));
	function statusOf(g: any): { text: string; v: 'success' | 'error' | 'warning' | 'neutral' } {
		if (g.override?.status === 'overridden') return { text: 'OVERRIDDEN → pass', v: 'success' };
		if (g.override?.status === 'failed') return { text: 'OVERRIDDEN → fail', v: 'error' };
		const p = g.evaluation?.passed;
		if (p == null) return { text: g.evaluation ? `${g.evaluation.members?.filter((m: any) => m.complete).length ?? 0}/${g.evaluation.criteriaUsed?.minRuns ?? '?'} run` : 'pending', v: 'warning' };
		return p ? { text: 'PASS', v: 'success' } : { text: 'FAIL', v: 'error' };
	}
	function setUnitFilter(udi: string) {
		const u = new URL(location.href);
		if (udi) u.searchParams.set('udi', udi);
		else u.searchParams.delete('udi');
		goto(u.toString(), { keepFocus: true, noScroll: true });
	}
	const COLOR: Record<string, string> = { cyan: 'var(--color-tron-cyan)', green: 'var(--color-tron-green)', purple: 'var(--color-tron-purple)', yellow: '#eab308', orange: 'var(--color-tron-orange)', blue: '#3b82f6' };
</script>

<div class="space-y-6">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Assay Run</h1>
			<p class="tron-text-muted mt-1 max-w-3xl text-sm">
				Validation test #4: several real cartridges run together on one unit, linked as a group and judged as a
				group — bead index per lane (mean, CV), result CV at one concentration, every run's stage check, lane C
				as the validity control. The group writes the unit's Assay Run validation. Cartridges that land later
				under the group's barcodes count the next time the group is refreshed. Replaces the optical
				confirmation gate.
			</p>
		</div>
		<div class="flex gap-3 text-sm">
			<button type="button" class="text-[var(--color-tron-cyan)] hover:underline" onclick={() => (showCriteria = !showCriteria)}>{showCriteria ? 'Hide criteria' : 'Criteria'}</button>
			{#if compareA && compareB}<a href="/validation/assay-run/compare?a={compareA}&b={compareB}" class="text-[var(--color-tron-cyan)] hover:underline">Compare →</a>{/if}
		</div>
	</div>

	{#if form?.error}
		<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-sm text-[var(--color-tron-red)]">{form.error}</div>
	{:else if form?.created}
		<div class="rounded-lg bg-[var(--color-tron-cyan)]/10 p-4 text-sm text-[var(--color-tron-cyan)]">Group “{form.name}” created with {form.count} cartridge{form.count === 1 ? '' : 's'} and evaluated.</div>
	{:else if form?.criteriaSaved}
		<div class="rounded-lg bg-[var(--color-tron-cyan)]/10 p-4 text-sm text-[var(--color-tron-cyan)]">Criteria saved. Refresh a group to re-judge it.</div>
	{/if}

	{#if showCriteria}
		<form method="POST" action="?/saveCriteria" use:enhance class="tron-card space-y-3 p-4">
			<h2 class="tron-heading text-sm font-semibold uppercase tracking-wide">Assay-run criteria</h2>
			<div class="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
				{#each [['minRuns', 'Cartridges required'], ['beadIndexMin', 'Bead index min'], ['beadIndexMax', 'Bead index max'], ['beadIndexCvMax', 'Bead index CV max %'], ['resultCvMax', 'Result CV max %'], ['stageErrorMaxUm', 'Stage error max µm'], ['stageHitsMax', 'Limit hits max'], ['laneCToleranceFrac', 'Lane C tolerance (0–1)']] as [k, label] (k)}
					<div><label for="c-{k}" class="tron-label">{label}</label><input id="c-{k}" name={k} type="number" step="any" value={(data.criteria as any)[k] ?? ''} class="tron-input w-full" /></div>
				{/each}
				<div><label for="c-num" class="tron-label">Bead index = metric</label><input id="c-num" name="beadIndexNum" value={data.criteria.beadIndexNum} class="tron-input w-full font-mono" /></div>
				<div><label for="c-den" class="tron-label">÷ metric</label><input id="c-den" name="beadIndexDen" value={data.criteria.beadIndexDen} class="tron-input w-full font-mono" /></div>
				<div><label for="c-res" class="tron-label">Result expression</label><input id="c-res" name="resultExpression" value={data.criteria.resultExpression} class="tron-input w-full font-mono" /></div>
				<div><label for="c-lanes" class="tron-label">Sample lanes</label><input id="c-lanes" name="sampleLanes" value={data.criteria.sampleLanes.join(',')} class="tron-input w-full font-mono" /></div>
			</div>
			<p class="tron-text-muted text-xs">Metric names are the Lambda/research analysis block's (f3_w3pre, f3_w4pre, f3_baseline, f3_test, f7_…; expressions f7_over_f3_test). Default bead index = f3_baseline ÷ f3_w4pre (loaded F3 over the buffer-baseline pre-scan).</p>
			<TronButton type="submit" variant="primary" size="sm">Save criteria</TronButton>
		</form>
	{/if}

	<form method="POST" action="?/create" use:enhance class="tron-card space-y-4 p-6">
		<h2 class="tron-heading text-sm font-semibold uppercase tracking-wide">New group</h2>
		<div class="grid gap-4 md:grid-cols-3">
			<div>
				<label for="ar-spu" class="tron-label">Unit</label>
				<select id="ar-spu" name="spuId" bind:value={spuId} class="tron-select w-full" style="min-height: 44px;" required>
					<option value="" disabled>Choose a unit…</option>
					{#each data.spus as s (s.id)}<option value={s.id}>{s.udi} — {s.status}{s.assayRun !== 'pending' ? ` · assay run ${s.assayRun}` : ''}</option>{/each}
				</select>
			</div>
			<div><label for="ar-name" class="tron-label">Group name</label><input id="ar-name" name="name" bind:value={name} class="tron-input w-full" style="min-height: 44px;" placeholder="e.g. 0243 triplicate 10/14" required /></div>
			<div><label for="ar-lot" class="tron-label">Lot (optional)</label><input id="ar-lot" name="lot" class="tron-input w-full" style="min-height: 44px;" /></div>
			<div><label for="ar-assay" class="tron-label">Assay id (optional)</label><input id="ar-assay" name="assayId" class="tron-input w-full font-mono" placeholder="AE9DE09B" /></div>
			<div><label for="ar-conc" class="tron-label">Intended concentration</label><input id="ar-conc" name="intendedConcentration" type="number" step="any" class="tron-input w-full" /></div>
			<div><label for="ar-unit" class="tron-label">Unit</label><input id="ar-unit" name="intendedConcentrationUnit" class="tron-input w-full" placeholder="µg/dL" /></div>
		</div>
		<div>
			<label for="ar-scan" class="tron-label">Scan cartridge barcodes (one per line)</label>
			<textarea id="ar-scan" name="cartridgeIds" bind:value={scanned} rows="3" class="tron-input w-full font-mono text-xs" placeholder="scan here — a cartridge that has not run yet is fine, it attaches when its record lands"></textarea>
		</div>
		{#if pickable.length}
			<div>
				<span class="tron-label">…or pick recent runs{selectedUdi ? ` on ${selectedUdi}` : ''}</span>
				<div class="max-h-48 space-y-1 overflow-y-auto rounded border border-[var(--color-tron-border)] p-2 text-xs">
					{#each pickable.slice(0, 60) as c (c.id)}
						<label class="flex items-center gap-2 font-mono {c.inGroup ? 'tron-text-muted' : ''}">
							<input type="checkbox" name="pick" value={c.id} />
							<span>{c.id}</span>
							<span class="tron-text-muted">{c.assayId ?? ''} · {c.spuUdi ?? ''} · {when(c.runAt)}{c.inGroup ? ' · already in a group' : ''}</span>
						</label>
					{/each}
				</div>
			</div>
		{/if}
		<TronButton type="submit" variant="primary" disabled={!spuId || !name}>Create and evaluate</TronButton>
	</form>

	<TronCard>
		<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
			<h3 class="tron-text-primary text-lg font-medium">Groups ({data.groups.length})</h3>
			<select class="tron-select" style="min-height: 36px;" value={data.filterUdi ?? ''} onchange={(e) => setUnitFilter((e.currentTarget as HTMLSelectElement).value)}>
				<option value="">All units</option>
				{#each data.spus as s (s.id)}<option value={s.udi}>{s.udi}</option>{/each}
			</select>
		</div>
		{#if data.groups.length === 0}
			<p class="tron-text-muted text-sm">No assay-run groups yet.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-xs">
					<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="py-1 pr-3 text-left font-medium">Cmp</th>
							<th class="py-1 pr-3 text-left font-medium">Group</th>
							<th class="py-1 pr-3 text-left font-medium">Unit</th>
							<th class="py-1 pr-3 text-left font-medium">Verdict</th>
							<th class="py-1 pr-3 text-left font-medium">Valid / N</th>
							<th class="py-1 pr-3 text-left font-medium">Bead index A / B / C</th>
							<th class="py-1 pr-3 text-left font-medium">BI CV %</th>
							<th class="py-1 pr-3 text-left font-medium">Result CV %</th>
							<th class="py-1 pr-3 text-left font-medium">Stage max |err| / hits</th>
							<th class="py-1 pr-3 text-left font-medium">Evaluated</th>
							<th class="py-1 text-left font-medium"></th>
						</tr>
					</thead>
					<tbody class="font-mono tron-text-primary">
						{#each data.groups as g (g.id)}
							{@const ev = g.evaluation}
							{@const st = statusOf(g)}
							<tr class="border-b border-[var(--color-tron-border)]/50">
								<td class="py-1 pr-3">
									<label class="mr-1"><input type="radio" name="cmpA" value={g.id} bind:group={compareA} /> A</label>
									<label><input type="radio" name="cmpB" value={g.id} bind:group={compareB} /> B</label>
								</td>
								<td class="py-1 pr-3"><span class="mr-1 inline-block h-2.5 w-2.5 rounded-full align-middle" style="background: {COLOR[g.color] ?? COLOR.cyan}"></span><a href="/validation/assay-run/{g.id}" class="text-[var(--color-tron-cyan)] hover:underline">{g.name}</a></td>
								<td class="py-1 pr-3"><a href={g.spuId ? `/spu/${g.spuId}` : '#'} class="text-[var(--color-tron-cyan)] hover:underline">{g.spuUdi ?? '—'}</a></td>
								<td class="py-1 pr-3"><TronBadge variant={st.v}>{st.text}</TronBadge></td>
								<td class="py-1 pr-3">{ev ? `${ev.nValid} / ${ev.n}` : '—'}</td>
								<td class="py-1 pr-3">{ev ? `${n(ev.lanes?.A?.beadIndexMean)} / ${n(ev.lanes?.B?.beadIndexMean)} / ${n(ev.lanes?.C?.beadIndexMean)}` : '—'}</td>
								<td class="py-1 pr-3">{n(ev?.beadIndexCv, 1)}</td>
								<td class="py-1 pr-3">{n(ev?.resultCv, 1)}</td>
								<td class="py-1 pr-3">{ev?.stage ? `${ev.stage.maxAbsErrorUm ?? '—'} / ${ev.stage.totalHits}` : '—'}</td>
								<td class="py-1 pr-3">{when(g.evaluatedAt)}</td>
								<td class="py-1 whitespace-nowrap">
									<button type="button" class="text-[var(--color-tron-cyan)] hover:underline" onclick={() => (expanded = expanded === g.id ? null : g.id)}>{expanded === g.id ? 'hide' : 'members'}</button>
									<form method="POST" action="?/refresh" use:enhance class="ml-2 inline"><input type="hidden" name="groupId" value={g.id} /><button type="submit" class="text-[var(--color-tron-cyan)] hover:underline">refresh</button></form>
								</td>
							</tr>
							{#if expanded === g.id && ev}
								<tr class="border-b border-[var(--color-tron-border)]/50">
									<td colspan="11" class="bg-[var(--color-tron-bg-secondary)]/40 px-3 py-3">
										{#if ev.failureReasons?.length}<p class="mb-2 text-[var(--color-tron-red)]">{ev.failureReasons.join(' · ')}</p>{/if}
										<table class="text-xs">
											<thead class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]"><tr><th class="pr-3 text-left">Cartridge</th><th class="pr-3 text-left">Run</th><th class="pr-3 text-left">BI A / B / C</th><th class="pr-3 text-left">Result A / B / C</th><th class="pr-3 text-left">Stage err / hits</th><th class="pr-3 text-left">Valid</th><th class="text-left"></th></tr></thead>
											<tbody>
												{#each ev.members as m (m.cartridgeId)}
													<tr>
														<td class="pr-3">{m.cartridgeId}</td>
														<td class="pr-3">{m.complete ? when(m.runAt) : 'not run'}</td>
														<td class="pr-3">{n(m.lanes?.A?.beadIndex)} / {n(m.lanes?.B?.beadIndex)} / {n(m.lanes?.C?.beadIndex)}</td>
														<td class="pr-3">{n(m.lanes?.A?.result, 3)} / {n(m.lanes?.B?.result, 3)} / {n(m.lanes?.C?.result, 3)}</td>
														<td class="pr-3">{m.stageCheck ? `${m.stageCheck.endErrorUm} / ${m.stageCheck.limitHits}` : '—'}</td>
														<td class="pr-3 {m.valid ? 'text-[var(--color-tron-green)]' : 'text-[var(--color-tron-red)]'}">{m.valid ? 'yes' : m.invalidReasons.join('; ')}</td>
														<td><form method="POST" action="?/removeCartridge" use:enhance class="inline"><input type="hidden" name="groupId" value={g.id} /><input type="hidden" name="cartridgeId" value={m.cartridgeId} /><button type="submit" class="tron-text-muted hover:text-[var(--color-tron-red)]">remove</button></form></td>
													</tr>
												{/each}
											</tbody>
										</table>
										<div class="mt-3 flex flex-wrap gap-4">
											<form method="POST" action="?/addCartridges" use:enhance class="flex gap-2"><input type="hidden" name="groupId" value={g.id} /><input name="cartridgeIds" class="tron-input w-64 font-mono text-xs" placeholder="add barcodes" /><TronButton type="submit" size="sm" variant="ghost">Add</TronButton></form>
											<form method="POST" action="?/override" use:enhance class="flex gap-2"><input type="hidden" name="groupId" value={g.id} /><select name="status" class="tron-select text-xs"><option value="">clear override</option><option value="overridden">override → pass</option><option value="failed">override → fail</option></select><input name="reason" class="tron-input w-56 text-xs" placeholder="reason (required)" /><TronButton type="submit" size="sm" variant="ghost">Apply</TronButton></form>
											<form method="POST" action="?/archive" use:enhance><input type="hidden" name="groupId" value={g.id} /><button type="submit" class="tron-text-muted text-xs hover:text-[var(--color-tron-red)]">archive group</button></form>
										</div>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</TronCard>
</div>
