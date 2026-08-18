<script lang="ts">
	import { enhance } from '$app/forms';
	import TronButton from '$lib/components/ui/TronButton.svelte';
	import TronInput from '$lib/components/ui/TronInput.svelte';
	import KanbanModal from '$lib/components/kanban/KanbanModal.svelte';

	let { data, form } = $props();

	type TargetRow = (typeof data.targets)[number];
	type TemplateRow = (typeof data.templates)[number];

	let errorMsg = $state('');
	let savedMsg = $state('');
	let submitting = $state(false);
	let targetModal = $state<null | { target: TargetRow | null }>(null); // null target = create
	let templateModal = $state<null | { template: TemplateRow | null }>(null); // null template = create

	function openTemplateModal(template: TemplateRow | null) {
		templateModal = { template };
	}

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
					templateModal = null;
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
				<h3 class="tron-text-primary mb-3 text-sm font-bold uppercase tracking-wide">Queue limits</h3>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					{@render knob('Ready cap', 'readyCap', p.readyCap ?? p.boards?.ops?.readyCap ?? 8, 'Maximum items in the ready queue. Rule of thumb: throughput × replenishment interval + buffer.')}
					{@render knob('Minimum order point', 'minOrderPoint', p.minOrderPoint ?? p.boards?.ops?.minOrderPoint ?? 3, 'Below this many ready items, a replenishment-needed signal is raised.')}
				</div>
			</section>

			<!-- WIP + pull -->
			<section class="tron-card !p-4">
				<h3 class="tron-text-primary mb-3 text-sm font-bold uppercase tracking-wide">WIP and pull discipline</h3>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					{@render knob('WIP per person', 'wipPerPerson', p.wipPerPerson ?? 2, 'Concurrent wip items per person. A limit, not a score.')}
					{@render knob('Chore max per person', 'wipChoreMax', p.wipChoreMax ?? 1, 'Of the personal WIP, at most this many chores — rationed so small work cannot eat the week.')}
				</div>
				<p class="tron-text-muted mt-3 text-xs">
					The pull window was removed — any ready task can be pulled regardless of rank. Rank still
					orders the queue as a recommendation.
				</p>
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
			point, exactly one supply card is spawned — auto-shaped and committed straight to the bottom of
			the ready queue (KB2-13 autopilot), unless the target opts out of auto-commit. Parts reordering
			needs no targets here: any active part at/below its minimum order qty spawns its own order card.
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
								<td class="tron-text-muted py-2 pr-3 text-xs">{t.spawnItemType}{t.autoCommit ? ' · auto→ready' : ' · captured'}</td>
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

	<!-- Workflow templates (KB2-11) -->
	<section class="tron-card !p-4">
		<div class="mb-3 flex items-center justify-between">
			<h3 class="tron-text-primary text-sm font-bold uppercase tracking-wide">Workflow templates</h3>
			{#if data.canAdmin}
				<TronButton variant="primary" onclick={() => openTemplateModal(null)}>New Template</TronButton>
			{/if}
		</div>
		<p class="tron-text-muted mb-3 text-xs">
			Ultra-defined recurring work ("Build &amp; validate an SPU") captured once as an SOP shape.
			Capturing from a template lands the item already processed and DoR-complete — immediately
			replenishable. Spikes cannot be templated: a templated investigation is a contradiction.
		</p>
		{#if data.templates.length === 0}
			<p class="tron-text-muted text-xs">No workflow templates yet.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="tron-text-muted text-left text-xs uppercase">
							<th class="pb-2 pr-3">Name</th>
							<th class="pb-2 pr-3">Type</th>
							<th class="pb-2 pr-3">Size</th>
							<th class="pb-2 pr-3">Class</th>
							<th class="pb-2 pr-3">Active</th>
							<th class="pb-2"></th>
						</tr>
					</thead>
					<tbody>
						{#each data.templates as t (t.id)}
							<tr class="border-t border-[var(--color-tron-border)] {t.active ? '' : 'opacity-50'}">
								<td class="tron-text-primary py-2 pr-3">{t.name}</td>
								<td class="tron-text-muted py-2 pr-3 text-xs">{t.itemType}</td>
								<td class="tron-text-muted py-2 pr-3 text-xs uppercase">{t.sizeClass}</td>
								<td class="tron-text-muted py-2 pr-3 text-xs">{t.classOfService}</td>
								<td class="py-2 pr-3 text-xs font-bold" style="color: {t.active ? 'var(--color-tron-green, #10b981)' : 'var(--color-tron-text-secondary)'};">
									{t.active ? 'yes' : 'no'}
								</td>
								<td class="py-2">
									{#if data.canAdmin}
										<div class="flex items-center justify-end gap-2">
											<TronButton onclick={() => openTemplateModal(t)}>Edit</TronButton>
											<form method="POST" action="?/toggleTemplate" use:enhance={submitEnhance}>
												<input type="hidden" name="templateId" value={t.id} />
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
						<option value="reagent_stock">Reagent stock</option>
						<option value="manual">Manual value</option>
					</select>
				</div>
			</div>
			<div class="mb-4">
				<label for="st-params" class="tron-label">Metric params (JSON)</label>
				<textarea id="st-params" name="metricParams" class="tron-input w-full font-mono text-xs" rows="3">{t?.metricParams ?? '{"statuses": []}'}</textarea>
				<p class="tron-text-muted mt-1 text-[11px]">
					cartridge_phase_count: {'{'}"statuses": [...], "skus": [...]{'}'} · part_stock: {'{'}"partId": "..."{'}'} ·
					reagent_stock: {'{'}"catalogId": "...", "variantKey": "...", "measure": "count"{'}'} · manual: {'{'}"value": 12{'}'}
				</p>
			</div>
			<div class="mb-4 grid grid-cols-3 gap-4">
				<TronInput label="Target" name="target" type="number" value={t?.target ?? ''} required />
				<TronInput label="Reorder point" name="reorderPoint" type="number" value={t?.reorderPoint ?? ''} required />
				<TronInput label="Batch size" name="batchSize" type="number" value={t?.batchSize ?? ''} required />
			</div>
			<div class="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div>
					<label for="st-spawn" class="tron-label">Spawned card type</label>
					<select id="st-spawn" name="spawnItemType" class="tron-select w-full" value={t?.spawnItemType ?? 'deliverable'}>
						<option value="deliverable">Deliverable</option>
						<option value="chore">Chore</option>
					</select>
				</div>
				<div>
					<label for="st-size" class="tron-label">Spawned size class</label>
					<select id="st-size" name="spawnSizeClass" class="tron-select w-full" value={t?.spawnSizeClass ?? 'short'}>
						<option value="short">Short</option>
						<option value="medium">Medium</option>
						<option value="long">Long</option>
					</select>
				</div>
			</div>
			<div class="mb-4">
				<label for="st-template" class="tron-label">Shape template (optional)</label>
				<select id="st-template" name="templateId" class="tron-select w-full" value={t?.templateId ?? ''}>
					<option value="">— none (auto-shaped) —</option>
					{#each data.templates.filter((x: any) => x.active) as tpl (tpl.id)}
						<option value={tpl.id}>{tpl.name}</option>
					{/each}
				</select>
				<p class="tron-text-muted mt-1 text-[11px]">When set, the template's size/class/DoR shape the spawned card.</p>
			</div>
			<div class="mb-4">
				<label class="tron-text-primary flex items-center gap-2 text-sm">
					<input type="checkbox" name="autoCommit" checked={t ? t.autoCommit : true} />
					Auto-commit spawned cards straight to ready (KB2-13 supply autopilot)
				</label>
				<p class="tron-text-muted mt-1 text-[11px]">
					Unchecked = KB2-10 behavior: a captured option that goes through the normal commitment point.
				</p>
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

<!-- Workflow template create/edit modal (KB2-11) -->
{#if templateModal}
	{@const tpl = templateModal.template}
	<KanbanModal title={tpl ? `Edit template: ${tpl.name}` : 'New workflow template'} onclose={() => (templateModal = null)} maxWidth="max-w-xl">
		<form method="POST" action={tpl ? '?/updateTemplate' : '?/createTemplate'} use:enhance={submitEnhance}>
			{#if tpl}
				<input type="hidden" name="templateId" value={tpl.id} />
			{/if}
			<div class="mb-4">
				<TronInput label="Name" name="name" value={tpl?.name ?? ''} required placeholder="Build & validate an SPU" />
			</div>
			<div class="mb-4">
				<label for="wt-type" class="tron-label">Item type (spikes cannot be templated)</label>
				<select id="wt-type" name="itemType" class="tron-select w-full" value={tpl?.itemType ?? 'deliverable'}>
					<option value="deliverable">Deliverable</option>
					<option value="chore">Chore</option>
				</select>
			</div>
			<div class="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div>
					<label for="wt-size" class="tron-label">Size class</label>
					<select id="wt-size" name="sizeClass" class="tron-select w-full" value={tpl?.sizeClass ?? 'short'}>
						<option value="short">Short</option>
						<option value="medium">Medium</option>
						<option value="long">Long</option>
					</select>
				</div>
				<div>
					<label for="wt-cos" class="tron-label">Class of service</label>
					<select id="wt-cos" name="classOfService" class="tron-select w-full" value={tpl?.classOfService ?? 'standard'}>
						<option value="standard">Standard</option>
						<option value="fixed_date">Fixed date</option>
						<option value="chore">Chore</option>
						<option value="expedite">Expedite</option>
					</select>
				</div>
			</div>
			<div class="mb-4">
				<TronInput label="Title template" name="titleTemplate" value={tpl?.titleTemplate ?? ''} required placeholder={'Build & validate SPU {n}'} />
			</div>
			<div class="mb-4">
				<label for="wt-deliverable" class="tron-label">DoR — deliverable (pre-written from the SOP)</label>
				<textarea id="wt-deliverable" name="dorDeliverable" class="tron-input w-full" rows="3" required>{tpl?.dorDeliverable ?? ''}</textarea>
				<p class="tron-text-muted mt-1 text-xs">
					State what will exist or be true when this is done — and how you'd verify it. Outcome, not steps.
				</p>
			</div>
			<div class="mb-4">
				<label for="wt-brief" class="tron-label">DoR — agent handoff brief (required to commit items tagged 'software')</label>
				<textarea id="wt-brief" name="dorHandoffBrief" class="tron-input w-full" rows="3">{tpl?.dorHandoffBrief ?? ''}</textarea>
			</div>
			<div class="mb-4">
				<TronInput label="Tags (comma-separated)" name="tags" value={tpl?.tags ?? ''} placeholder="spu, build" />
			</div>
			<div class="mb-4">
				<label for="wt-notes" class="tron-label">Notes</label>
				<textarea id="wt-notes" name="notes" class="tron-input w-full" rows="2">{tpl?.notes ?? ''}</textarea>
			</div>
			<div class="mb-4">
				<label class="flex items-center gap-2 text-sm">
					<input type="checkbox" name="active" checked={tpl ? tpl.active : true} />
					<span class="tron-text-primary">Active (available in the Inventory template picker)</span>
				</label>
			</div>
			<div class="flex justify-end gap-3">
				<TronButton onclick={() => (templateModal = null)}>Cancel</TronButton>
				<TronButton type="submit" variant="primary" disabled={submitting}>{tpl ? 'Save Template' : 'Create Template'}</TronButton>
			</div>
		</form>
	</KanbanModal>
{/if}
