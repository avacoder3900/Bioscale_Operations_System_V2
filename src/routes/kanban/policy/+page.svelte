<script lang="ts">
	import { enhance } from '$app/forms';
	import TronButton from '$lib/components/ui/TronButton.svelte';
	import TronInput from '$lib/components/ui/TronInput.svelte';
	import KanbanModal from '$lib/components/kanban/KanbanModal.svelte';

	let { data, form } = $props();

	type TargetRow = (typeof data.targets)[number];

	let errorMsg = $state('');
	let savedMsg = $state('');
	let submitting = $state(false);
	let targetModal = $state<null | { target: TargetRow | null }>(null); // null target = create

	$effect(() => {
		if ((form as any)?.error) errorMsg = (form as any).error;
	});

	let p = $derived(data.policy);
	let recalPastDue = $derived(
		!!p.recalibrateAfter && new Date(p.recalibrateAfter).getTime() < Date.now()
	);
	let recalValue = $derived(
		p.recalibrateAfter ? new Date(p.recalibrateAfter).toISOString().slice(0, 10) : ''
	);

	function submitEnhance() {
		submitting = true;
		return async ({ result, update }: { result: any; update: (opts?: any) => Promise<void> }) => {
			submitting = false;
			if (result.type === 'failure') {
				errorMsg = result.data?.error ?? 'Save failed';
				savedMsg = '';
				await update({ reset: false });
			} else {
				if (result.type === 'success') {
					errorMsg = '';
					savedMsg = 'Saved.';
					targetModal = null;
				}
				await update({ reset: false });
			}
		};
	}
</script>

{#snippet knob(label: string, name: string, value: number | null, explanation: string)}
	<div>
		<label for="knob-{name}" class="tron-label">{label}</label>
		<input id="knob-{name}" {name} type="number" step="any" class="tron-input w-full" value={value ?? ''} />
		<p class="tron-text-muted mt-1 text-[11px]">{explanation}</p>
	</div>
{/snippet}

<div class="space-y-6">
	<div>
		<h2 class="tron-text-primary text-2xl font-bold">Policy</h2>
		<p class="tron-text-muted text-sm">
			Every tunable of the two-tier system. Enforced invariants read at runtime — no deploy needed.
			Current numbers are seeds to be recomputed from measured flow.
		</p>
	</div>

	{#if !data.canAdmin}
		<div class="rounded border border-[rgba(245,158,11,0.4)] bg-[rgba(245,158,11,0.08)] px-4 py-3 text-sm" style="color: #f59e0b;">
			Read-only: editing policy requires <code>kanban:admin</code>.
		</div>
	{/if}

	{#if recalPastDue}
		<div class="rounded border border-[rgba(255,51,102,0.4)] bg-[rgba(255,51,102,0.08)] px-4 py-3 text-sm font-bold" style="color: var(--color-tron-red);">
			Recalibration is past due ({new Date(p.recalibrateAfter).toLocaleDateString()}). The seed numbers below
			must be recomputed from measured flow (throughput, arrival rates, cycle-time percentiles).
		</div>
	{/if}

	{#if errorMsg}
		<div class="flex items-start justify-between gap-3 rounded border border-[rgba(255,51,102,0.3)] bg-[rgba(255,51,102,0.1)] px-4 py-3 text-sm" style="color: var(--color-tron-red);">
			<span>{errorMsg}</span>
			<button type="button" class="shrink-0 font-bold" onclick={() => (errorMsg = '')} aria-label="Dismiss">✕</button>
		</div>
	{/if}
	{#if savedMsg}
		<div class="rounded border border-[rgba(0,255,136,0.3)] bg-[rgba(0,255,136,0.1)] px-4 py-3 text-sm" style="color: var(--color-tron-green);">{savedMsg}</div>
	{/if}

	<form method="POST" action="?/savePolicy" use:enhance={submitEnhance}>
		<fieldset disabled={!data.canAdmin} class="space-y-6">
			<!-- Boards -->
			<section class="tron-card !p-4">
				<h3 class="tron-text-primary mb-3 text-sm font-bold uppercase tracking-wide">Per-board queue limits</h3>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					{@render knob('Ops — ready cap', 'ops_readyCap', p.boards?.ops?.readyCap ?? 8, 'Maximum items in the ops ready queue. Rule of thumb: throughput × replenishment interval + buffer.')}
					{@render knob('Ops — minimum order point', 'ops_minOrderPoint', p.boards?.ops?.minOrderPoint ?? 3, 'Below this many ready items, a replenishment-needed signal is raised.')}
					{@render knob('Software — ready cap', 'software_readyCap', p.boards?.software?.readyCap ?? 8, 'Maximum items in the software ready queue.')}
					{@render knob('Software — minimum order point', 'software_minOrderPoint', p.boards?.software?.minOrderPoint ?? 3, 'Below this, replenish the software queue.')}
				</div>
			</section>

			<!-- WIP + pull -->
			<section class="tron-card !p-4">
				<h3 class="tron-text-primary mb-3 text-sm font-bold uppercase tracking-wide">WIP and pull discipline</h3>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
					{@render knob('WIP per person', 'wipPerPerson', p.wipPerPerson ?? 2, 'Concurrent wip items per person across BOTH boards combined. A limit, not a score.')}
					{@render knob('Chore max per person', 'wipChoreMax', p.wipChoreMax ?? 1, 'Of the personal WIP, at most this many chores — rationed so small work cannot eat the week.')}
					{@render knob('Pull window', 'pullWindow', p.pullWindow ?? 3, 'Pull only from the top N of the global ready order — bounded choice, no cherry-picking from the tail.')}
				</div>
			</section>

			<!-- Expedite -->
			<section class="tron-card !p-4">
				<h3 class="tron-text-primary mb-3 text-sm font-bold uppercase tracking-wide">Expedite</h3>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					{@render knob('System-wide concurrent max', 'expedite_systemMax', p.expedite?.systemMax ?? 1, 'Hard cap on concurrently committed expedite items across the whole system. The emergency lane only works if it is empty.')}
					{@render knob('Alert threshold (% of committed, rolling 30d)', 'expedite_alertPct', p.expedite?.alertPctRolling30d ?? 5, 'Above this share, an alert fires — a rising expedite rate is an upstream-planning signal.')}
				</div>
			</section>

			<!-- Allocation -->
			<section class="tron-card !p-4">
				<h3 class="tron-text-primary mb-1 text-sm font-bold uppercase tracking-wide">Capacity allocation (% of committed WIP)</h3>
				<p class="tron-text-muted mb-3 text-xs">
					Advisory at replenish time for standard and fixed date. <span class="font-bold">Chore is the exception: its
					number is a floor AND a ceiling</span> — promotions beyond the ceiling are rejected, and a share below the
					floor is surfaced as a signal (the floor is what guarantees small work happens on the board instead of off it).
				</p>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
					{@render knob('Standard %', 'allocation_standard', p.allocation?.standard ?? 60, 'Target share of the main value stream.')}
					{@render knob('Fixed date %', 'allocation_fixed_date', p.allocation?.fixed_date ?? 25, 'Target share for real external deadlines.')}
					{@render knob('Chore % (floor AND ceiling)', 'allocation_chore', p.allocation?.chore ?? 15, 'Enforced ceiling at replenish; under-floor is surfaced as a signal.')}
				</div>
			</section>

			<!-- Size class definitions -->
			<section class="tron-card !p-4">
				<h3 class="tron-text-primary mb-3 text-sm font-bold uppercase tracking-wide">Size class definitions</h3>
				<p class="tron-text-muted mb-3 text-xs">Shown in the processing modal — the shared yardstick for whoever is sizing.</p>
				<div class="space-y-3">
					<div>
						<label for="sc-short" class="tron-label">Short</label>
						<textarea id="sc-short" name="sizeClass_short" class="tron-input w-full" rows="2">{p.sizeClassDefinitions?.short ?? ''}</textarea>
					</div>
					<div>
						<label for="sc-medium" class="tron-label">Medium</label>
						<textarea id="sc-medium" name="sizeClass_medium" class="tron-input w-full" rows="2">{p.sizeClassDefinitions?.medium ?? ''}</textarea>
					</div>
					<div>
						<label for="sc-long" class="tron-label">Long</label>
						<textarea id="sc-long" name="sizeClass_long" class="tron-input w-full" rows="2">{p.sizeClassDefinitions?.long ?? ''}</textarea>
					</div>
				</div>
			</section>

			<!-- SLE -->
			<section class="tron-card !p-4">
				<h3 class="tron-text-primary mb-3 text-sm font-bold uppercase tracking-wide">Service Level Expectation</h3>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-4">
					{@render knob('Percentile', 'sle_percentile', p.sle?.percentile ?? 85, '"N% of items finish within D days." 85 is the default confidence level.')}
					{@render knob('Short seed (days)', 'sle_short', p.sle?.perSizeClassDays?.short ?? null, 'Seed until enough measured samples exist. Empty = no seed (shows "insufficient data").')}
					{@render knob('Medium seed (days)', 'sle_medium', p.sle?.perSizeClassDays?.medium ?? null, 'Seeded from 19 historical samples (p85 ≈ 20d).')}
					{@render knob('Long seed (days)', 'sle_long', p.sle?.perSizeClassDays?.long ?? null, 'Empty = no seed.')}
				</div>
				<div class="mt-4 max-w-xs">
					<TronInput label="Recalibrate after" name="recalibrateAfter" type="date" value={recalValue} />
					<p class="tron-text-muted mt-1 text-[11px]">When this date passes, the page nags: seeds must be replaced by measured demand.</p>
				</div>
			</section>

			<div class="flex justify-end">
				<TronButton type="submit" variant="primary" disabled={submitting || !data.canAdmin}>
					{submitting ? 'Saving…' : 'Save Policy'}
				</TronButton>
			</div>
		</fieldset>
	</form>

	<!-- Standing targets (KB2-10) -->
	<section class="tron-card !p-4">
		<div class="mb-3 flex items-center justify-between">
			<h3 class="tron-text-primary text-sm font-bold uppercase tracking-wide">Standing supply targets</h3>
			{#if data.canAdmin}
				<TronButton variant="primary" onclick={() => (targetModal = { target: null })}>New Target</TronButton>
			{/if}
		</div>
		<p class="tron-text-muted mb-3 text-xs">
			Standing work ("always have N on hand") is a supply signal, not a flow item. Below the reorder
			point, exactly one build option is spawned into Tier 1 and flows through the normal commitment point.
		</p>
		{#if data.targets.length === 0}
			<p class="tron-text-muted text-xs">No standing targets yet.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="tron-text-muted text-left text-xs uppercase">
							<th class="pb-2 pr-3">Name</th>
							<th class="pb-2 pr-3">Metric</th>
							<th class="pb-2 pr-3 text-right">Target</th>
							<th class="pb-2 pr-3 text-right">Reorder at</th>
							<th class="pb-2 pr-3 text-right">Batch</th>
							<th class="pb-2 pr-3">Spawns</th>
							<th class="pb-2 pr-3">Active</th>
							<th class="pb-2"></th>
						</tr>
					</thead>
					<tbody>
						{#each data.targets as t (t.id)}
							<tr class="border-t border-[var(--color-tron-border)] {t.active ? '' : 'opacity-50'}">
								<td class="tron-text-primary py-2 pr-3">{t.name}</td>
								<td class="tron-text-muted py-2 pr-3 text-xs">{t.metricKind}</td>
								<td class="tron-text-primary py-2 pr-3 text-right">{t.target}</td>
								<td class="tron-text-primary py-2 pr-3 text-right">{t.reorderPoint}</td>
								<td class="tron-text-primary py-2 pr-3 text-right">{t.batchSize}</td>
								<td class="tron-text-muted py-2 pr-3 text-xs">{t.spawnItemType}</td>
								<td class="py-2 pr-3 text-xs font-bold" style="color: {t.active ? 'var(--color-tron-green, #10b981)' : 'var(--color-tron-text-secondary)'};">
									{t.active ? 'yes' : 'no'}
								</td>
								<td class="py-2">
									{#if data.canAdmin}
										<div class="flex items-center justify-end gap-2">
											<TronButton onclick={() => (targetModal = { target: t })}>Edit</TronButton>
											<form method="POST" action="?/toggleTarget" use:enhance={submitEnhance}>
												<input type="hidden" name="targetId" value={t.id} />
												<TronButton type="submit" variant={t.active ? 'danger' : 'default'} disabled={submitting}>
													{t.active ? 'Deactivate' : 'Reactivate'}
												</TronButton>
											</form>
										</div>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</div>

<!-- Standing target create/edit modal -->
{#if targetModal}
	{@const t = targetModal.target}
	<KanbanModal title={t ? `Edit target: ${t.name}` : 'New standing target'} onclose={() => (targetModal = null)} maxWidth="max-w-xl">
		<form method="POST" action={t ? '?/updateTarget' : '?/createTarget'} use:enhance={submitEnhance}>
			{#if t}
				<input type="hidden" name="targetId" value={t.id} />
			{/if}
			<div class="mb-4">
				<TronInput label="Name" name="name" value={t?.name ?? ''} required placeholder="Filled cartridges on hand" />
			</div>
			<div class="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div>
					<label for="st-kind" class="tron-label">Metric kind</label>
					<select id="st-kind" name="metricKind" class="tron-select w-full" value={t?.metricKind ?? 'cartridge_phase_count'}>
						<option value="cartridge_phase_count">Cartridge phase count</option>
						<option value="part_stock">Part stock</option>
						<option value="manual">Manual value</option>
					</select>
				</div>
				<div>
					<label for="st-board" class="tron-label">Board</label>
					<select id="st-board" name="board" class="tron-select w-full" value={t?.board ?? 'ops'}>
						<option value="ops">ops</option>
						<option value="software">software</option>
					</select>
				</div>
			</div>
			<div class="mb-4">
				<label for="st-params" class="tron-label">Metric params (JSON)</label>
				<textarea id="st-params" name="metricParams" class="tron-input w-full font-mono text-xs" rows="3">{t?.metricParams ?? '{"statuses": []}'}</textarea>
				<p class="tron-text-muted mt-1 text-[11px]">
					cartridge_phase_count: {'{'}"statuses": [...], "skus": [...]{'}'} · part_stock: {'{'}"partId": "..."{'}'} · manual: {'{'}"value": 12{'}'}
				</p>
			</div>
			<div class="mb-4 grid grid-cols-3 gap-4">
				<TronInput label="Target" name="target" type="number" value={t?.target ?? ''} required />
				<TronInput label="Reorder point" name="reorderPoint" type="number" value={t?.reorderPoint ?? ''} required />
				<TronInput label="Batch size" name="batchSize" type="number" value={t?.batchSize ?? ''} required />
			</div>
			<div class="mb-4">
				<label for="st-spawn" class="tron-label">Spawned option type</label>
				<select id="st-spawn" name="spawnItemType" class="tron-select w-full" value={t?.spawnItemType ?? 'deliverable'}>
					<option value="deliverable">Deliverable</option>
					<option value="chore">Chore</option>
				</select>
			</div>
			<div class="mb-4">
				<label for="st-notes" class="tron-label">Notes</label>
				<textarea id="st-notes" name="notes" class="tron-input w-full" rows="2">{t?.notes ?? ''}</textarea>
			</div>
			<div class="flex justify-end gap-3">
				<TronButton onclick={() => (targetModal = null)}>Cancel</TronButton>
				<TronButton type="submit" variant="primary" disabled={submitting}>{t ? 'Save Target' : 'Create Target'}</TronButton>
			</div>
		</form>
	</KanbanModal>
{/if}
