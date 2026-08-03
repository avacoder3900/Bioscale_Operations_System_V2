<script lang="ts">
	import { enhance } from '$app/forms';
	import TronButton from '$lib/components/ui/TronButton.svelte';
	import TronInput from '$lib/components/ui/TronInput.svelte';
	import KanbanModal from '$lib/components/kanban/KanbanModal.svelte';
	import TaskStatusBadge from '$lib/components/kanban/TaskStatusBadge.svelte';
	import { SIZE_CLASSES, CLASSES_OF_SERVICE } from '$lib/shared/kanban-status';

	let { data, form } = $props();

	type TaskRow = (typeof data.tasks)[number];

	let errorMsg = $state('');
	let successMsg = $state('');
	let submitting = $state(false);
	let modal = $state<null | { kind: 'process' | 'decline'; task: TaskRow }>(null);
	let processCos = $state('standard');

	// KB2-11 — capture-from-template picker state.
	let selectedTemplateId = $state('');
	let templateProjectId = $state('');
	let selectedTemplate = $derived(
		data.templates.find((t: { id: string }) => t.id === selectedTemplateId) ?? null
	);
	$effect(() => {
		// Changing the template resets the project select to its default.
		templateProjectId = selectedTemplate?.defaultProjectId ?? '';
	});

	// Filters — captured|processed default on; icebox/declined behind toggles.
	let showCaptured = $state(true);
	let showProcessed = $state(true);
	let showIcebox = $state(false);
	let showDeclined = $state(false);
	let itemTypeFilter = $state('all');
	let originFilter = $state('all');

	$effect(() => {
		const f = form as any;
		if (f?.error) errorMsg = f.error;
		successMsg = f?.capturedFromTemplate
			? `Captured "${f.capturedFromTemplate}" from template — processed and DoR-complete.`
			: '';
	});

	let filtered = $derived(
		data.tasks.filter((t: TaskRow) => {
			if (t.status === 'captured' && !showCaptured) return false;
			if (t.status === 'processed' && !showProcessed) return false;
			if (t.status === 'icebox' && !showIcebox) return false;
			if (t.status === 'declined' && !showDeclined) return false;
			if (itemTypeFilter !== 'all' && t.itemType !== itemTypeFilter) return false;
			if (originFilter !== 'all' && t.origin !== originFilter) return false;
			return true;
		})
	);

	// Grouped by project, ordered by Tier 1 rank (server sort preserved).
	let groups = $derived.by(() => {
		const byProject = new Map<string, { name: string; color: string | null; tasks: TaskRow[] }>();
		for (const t of filtered) {
			const key = t.projectId ?? '__none';
			if (!byProject.has(key)) {
				byProject.set(key, { name: t.projectName ?? 'No project', color: t.projectColor, tasks: [] });
			}
			byProject.get(key)!.tasks.push(t);
		}
		return [...byProject.entries()]
			.map(([id, g]) => ({ id, ...g }))
			.sort((a, b) => (a.id === '__none' ? 1 : b.id === '__none' ? -1 : a.name.localeCompare(b.name)));
	});

	function submitEnhance() {
		submitting = true;
		return async ({ result, update }: { result: any; update: (opts?: any) => Promise<void> }) => {
			submitting = false;
			if (result.type === 'failure') {
				errorMsg = result.data?.error ?? 'Action failed';
				modal = null;
				await update({ reset: false });
			} else {
				if (result.type === 'success') {
					errorMsg = '';
					modal = null;
				}
				await update();
			}
		};
	}

	// KB2-12 — one unified modal: process a captured item, or reshape a
	// processed one (pre-filled, no status change).
	function openProcess(task: TaskRow) {
		processCos = task.classOfService ?? 'standard';
		modal = { kind: 'process', task };
	}

	const cosLabels: Record<string, string> = {
		standard: 'Standard',
		fixed_date: 'Fixed date (real external deadline)',
		chore: 'Chore',
		expedite: 'Expedite (emergency lane — system-capped)'
	};
</script>

{#snippet dorDot(t: TaskRow)}
	{#if t.dorMissing.length === 0}
		<span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background: #10b981;" title="Definition of Ready complete"></span>
	{:else}
		<span
			class="h-2.5 w-2.5 shrink-0 rounded-full"
			style="background: #f59e0b;"
			title={'DoR incomplete:\n' + t.dorMissing.join('\n')}
		></span>
	{/if}
{/snippet}

<div class="space-y-6">
	<div>
		<h2 class="tron-text-primary text-2xl font-bold">Inventory</h2>
		<p class="tron-text-muted text-sm">
			Tier 1 — every option we know about on the <span class="font-bold uppercase">{data.board}</span> board.
			Unbounded, ranked per project. Nothing here is committed.
		</p>
	</div>

	<!-- Capture box: one line is enough -->
	<form method="POST" action="?/capture" class="flex flex-wrap items-center gap-2" use:enhance={submitEnhance}>
		<div class="min-w-[240px] flex-1">
			<TronInput name="title" placeholder="Capture an option — one line is enough" required />
		</div>
		<select name="projectId" class="tron-select" title="Project (optional)">
			<option value="">No project</option>
			{#each data.projects as p (p.id)}
				<option value={p.id}>{p.name}</option>
			{/each}
		</select>
		<TronButton type="submit" variant="primary" disabled={submitting}>Capture</TronButton>
	</form>

	<!-- KB2-11: capture from a workflow template — lands processed + DoR-complete -->
	{#if data.templates.length > 0}
		<form method="POST" action="?/captureFromTemplate" class="flex flex-wrap items-center gap-2" use:enhance={submitEnhance}>
			<select name="templateId" class="tron-select" title="Workflow template" bind:value={selectedTemplateId}>
				<option value="">From template…</option>
				{#each data.templates as tpl (tpl.id)}
					<option value={tpl.id}>{tpl.name}</option>
				{/each}
			</select>
			{#if selectedTemplateId}
				<div class="min-w-[220px] flex-1">
					<TronInput name="title" placeholder={selectedTemplate?.titleTemplate ?? 'Title (optional override)'} />
				</div>
				<select name="projectId" class="tron-select" title="Project (optional)" bind:value={templateProjectId}>
					<option value="">No project</option>
					{#each data.projects as p (p.id)}
						<option value={p.id}>{p.name}</option>
					{/each}
				</select>
				{#if selectedTemplate?.classOfService === 'fixed_date'}
					<input type="date" name="dueDate" class="tron-input" title="Due date (fixed-date template)" required />
				{/if}
				<TronButton type="submit" variant="primary" disabled={submitting}>Capture from template</TronButton>
			{/if}
		</form>
	{/if}

	{#if successMsg}
		<div class="rounded border border-[rgba(0,255,136,0.3)] bg-[rgba(0,255,136,0.1)] px-4 py-3 text-sm" style="color: var(--color-tron-green);">{successMsg}</div>
	{/if}

	{#if errorMsg}
		<div class="flex items-start justify-between gap-3 rounded border border-[rgba(255,51,102,0.3)] bg-[rgba(255,51,102,0.1)] px-4 py-3 text-sm" style="color: var(--color-tron-red);">
			<span>{errorMsg}</span>
			<button type="button" class="shrink-0 font-bold" onclick={() => (errorMsg = '')} aria-label="Dismiss">✕</button>
		</div>
	{/if}

	<!-- Filters -->
	<div class="flex flex-wrap items-center gap-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-4 py-3 text-sm">
		<label class="flex items-center gap-1.5"><input type="checkbox" bind:checked={showCaptured} /> <span class="tron-text-primary">Captured</span></label>
		<label class="flex items-center gap-1.5"><input type="checkbox" bind:checked={showProcessed} /> <span class="tron-text-primary">Processed</span></label>
		<label class="flex items-center gap-1.5"><input type="checkbox" bind:checked={showIcebox} /> <span class="tron-text-muted">Icebox</span></label>
		<label class="flex items-center gap-1.5"><input type="checkbox" bind:checked={showDeclined} /> <span class="tron-text-muted">Declined</span></label>
		<select bind:value={itemTypeFilter} class="tron-select">
			<option value="all">All types</option>
			<option value="deliverable">Deliverable</option>
			<option value="spike">Spike</option>
			<option value="chore">Chore</option>
		</select>
		<select bind:value={originFilter} class="tron-select">
			<option value="all">All origins</option>
			<option value="planned">Planned</option>
			<option value="discovered">Discovered</option>
		</select>
		<span class="tron-text-muted ml-auto text-xs">{filtered.length} option{filtered.length === 1 ? '' : 's'}</span>
	</div>

	<!-- Options grouped by project -->
	{#each groups as group (group.id)}
		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
			<div class="flex items-center gap-2 border-b border-[var(--color-tron-border)] px-4 py-3">
				<span class="h-3 w-3 rounded-full" style="background: {group.color ?? '#6b7280'};"></span>
				<span class="text-sm font-bold" style="color: {group.color ?? 'var(--color-tron-text-primary)'};">{group.name}</span>
				<span class="tron-text-muted text-xs">({group.tasks.length})</span>
			</div>
			<div class="divide-y divide-[var(--color-tron-border)]">
				{#each group.tasks as t (t.id)}
					<div class="flex flex-wrap items-center gap-3 px-4 py-2.5">
						{#if t.status === 'captured' || t.status === 'processed'}
							<span class="tron-text-muted w-7 shrink-0 text-right text-xs font-bold">{t.rank}</span>
						{:else}
							<span class="w-7 shrink-0"></span>
						{/if}
						{@render dorDot(t)}
						<div class="min-w-[220px] flex-1">
							<div class="flex flex-wrap items-center gap-2">
								<a href="/kanban/task/{t.id}" class="tron-text-primary text-sm font-medium hover:underline">{t.title}</a>
								<TaskStatusBadge status={t.status} />
								{#if t.itemType !== 'deliverable'}
									<span class="tron-text-muted rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[10px] uppercase">{t.itemType}</span>
								{/if}
								{#if t.origin === 'discovered'}
									<span class="rounded px-1.5 py-0.5 text-[10px] font-bold" style="background: rgba(167,139,250,0.15); color: #a78bfa;">DISCOVERED</span>
								{/if}
								{#if t.sizeClass}
									<span class="tron-text-muted rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[10px] uppercase">{t.sizeClass}</span>
								{/if}
								{#if t.classOfService && t.classOfService !== 'standard'}
									<span class="tron-text-muted rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[10px] uppercase">{t.classOfService}</span>
								{/if}
							</div>
							{#if t.status === 'declined' && t.declineReason}
								<p class="mt-0.5 text-xs" style="color: var(--color-tron-red);">Declined: {t.declineReason}</p>
							{/if}
						</div>

						<!-- Controls -->
						<div class="flex shrink-0 flex-wrap items-center gap-1.5">
							{#if t.status === 'captured' || t.status === 'processed'}
								{#if t.projectId}
									<form method="POST" action="?/rankMove" use:enhance={submitEnhance} class="flex items-center">
										<input type="hidden" name="taskId" value={t.id} />
										<button type="submit" name="direction" value="up" class="tron-button !px-2 !py-1 text-xs" title="Rank up" disabled={submitting}>▲</button>
									</form>
									<form method="POST" action="?/rankMove" use:enhance={submitEnhance} class="flex items-center">
										<input type="hidden" name="taskId" value={t.id} />
										<button type="submit" name="direction" value="down" class="tron-button !px-2 !py-1 text-xs" title="Rank down" disabled={submitting}>▼</button>
									</form>
								{/if}
								<TronButton variant="primary" onclick={() => openProcess(t)}>Process</TronButton>
								<form method="POST" action="?/icebox" use:enhance={submitEnhance}>
									<input type="hidden" name="taskId" value={t.id} />
									<TronButton type="submit" disabled={submitting}>Icebox</TronButton>
								</form>
								<TronButton variant="danger" onclick={() => (modal = { kind: 'decline', task: t })}>Decline…</TronButton>
							{:else if t.status === 'icebox'}
								<form method="POST" action="?/thaw" use:enhance={submitEnhance}>
									<input type="hidden" name="taskId" value={t.id} />
									<TronButton type="submit" disabled={submitting}>Thaw</TronButton>
								</form>
								<TronButton variant="danger" onclick={() => (modal = { kind: 'decline', task: t })}>Decline…</TronButton>
							{/if}
						</div>
					</div>
				{/each}
				{#if group.tasks.length === 0}
					<p class="tron-text-muted px-4 py-3 text-xs">No options match the filters.</p>
				{/if}
			</div>
		</section>
	{/each}
	{#if groups.length === 0}
		<p class="tron-text-muted text-sm">No Tier 1 options match the current filters.</p>
	{/if}
</div>

<!-- Unified Process modal (KB2-03 + KB2-12): processes captured items, reshapes processed ones -->
{#if modal?.kind === 'process'}
	<KanbanModal title="Process: {modal.task.title}" onclose={() => (modal = null)} maxWidth="max-w-xl">
		<p class="tron-text-muted mb-3 text-sm">
			{#if modal.task.status === 'captured'}
				Processing shapes a captured option into a real candidate: sized and classed by the person
				processing — not the author, not the eventual assignee.
			{:else}
				Reshaping edits size, class, and DoR in place — audited, no status change.
			{/if}
		</p>
		<div class="mb-4 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-3 py-2">
			<p class="tron-text-primary text-xs font-bold uppercase tracking-wide">The sizing decision test</p>
			<p class="tron-text-muted mt-1 text-xs">{data.sizingDecisionTest}</p>
		</div>
		<form method="POST" action={modal.task.status === 'captured' ? '?/process' : '?/reshape'} use:enhance={submitEnhance}>
			<input type="hidden" name="taskId" value={modal.task.id} />

			<fieldset class="mb-4">
				<legend class="tron-label">Size class</legend>
				<div class="space-y-2">
					{#each SIZE_CLASSES as sc (sc)}
						<label class="flex items-start gap-2 text-sm">
							<input type="radio" name="sizeClass" value={sc} required class="mt-1" checked={modal.task.sizeClass === sc} />
							<span>
								<span class="tron-text-primary font-bold capitalize">{sc}</span>
								<span class="tron-text-muted block text-xs">{(data.sizeClassDefinitions as Record<string, string>)[sc]}</span>
							</span>
						</label>
					{/each}
				</div>
			</fieldset>

			<div class="mb-4">
				<label for="proc-cos" class="tron-label">Class of service</label>
				<select id="proc-cos" name="classOfService" class="tron-select w-full" required bind:value={processCos}>
					{#each CLASSES_OF_SERVICE as cos (cos)}
						<option value={cos}>{cosLabels[cos] ?? cos}</option>
					{/each}
				</select>
			</div>

			{#if processCos === 'fixed_date'}
				<div class="mb-4">
					<TronInput
						label="Due date (a real external date)"
						name="dueDate"
						type="date"
						value={modal.task.dueDate ? String(modal.task.dueDate).slice(0, 10) : ''}
						required
					/>
				</div>
			{/if}

			<div class="mb-4">
				<label for="proc-deliverable" class="tron-label">Deliverable (DoR)</label>
				<textarea id="proc-deliverable" name="deliverable" class="tron-input w-full" rows="3">{modal.task.dor.deliverable}</textarea>
				<p class="tron-text-muted mt-1 text-xs">
					State what will exist or be true when this is done — and how you'd verify it. Outcome, not steps.
				</p>
				<!-- KB2-12 addendum: spike explainer — when the deliverable can't be written -->
				<div class="mt-2 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-3 py-2">
					<p class="tron-text-muted text-xs">
						<span class="tron-text-primary font-bold">Can't write the deliverable?</span>
						If you don't know enough to say what 'done' looks like, this isn't a deliverable yet — make it a
						spike: a timeboxed investigation with a question ('Can X work?') and a timebox (e.g. 2 days). A
						spike is done when the timebox ends — 'we still don't know' is a valid recorded answer.
					</p>
				</div>
			</div>
			{#if data.board === 'software'}
				<div class="mb-4">
					<label for="proc-brief" class="tron-label">Agent handoff brief (software DoR — lets a coding agent execute without re-discovery)</label>
					<textarea id="proc-brief" name="handoffBrief" class="tron-input w-full" rows="3">{modal.task.dor.handoffBrief}</textarea>
				</div>
			{/if}

			<div class="flex justify-end gap-3">
				<TronButton onclick={() => (modal = null)}>Cancel</TronButton>
				<TronButton type="submit" variant="primary" disabled={submitting}>
					{modal.task.status === 'captured' ? 'Mark Processed' : 'Save Changes'}
				</TronButton>
			</div>
		</form>
	</KanbanModal>
{/if}

<!-- Decline… modal -->
{#if modal?.kind === 'decline'}
	<KanbanModal title="Decline: {modal.task.title}" onclose={() => (modal = null)}>
		<p class="tron-text-muted mb-4 text-sm">Declined items are kept for the record — who and why.</p>
		<form method="POST" action="?/decline" use:enhance={submitEnhance}>
			<input type="hidden" name="taskId" value={modal.task.id} />
			<div class="mb-4">
				<label for="decline-reason" class="tron-label">Reason (required)</label>
				<textarea id="decline-reason" name="reason" class="tron-input w-full" rows="3" required></textarea>
			</div>
			<div class="flex justify-end gap-3">
				<TronButton onclick={() => (modal = null)}>Cancel</TronButton>
				<TronButton type="submit" variant="danger" disabled={submitting}>Decline</TronButton>
			</div>
		</form>
	</KanbanModal>
{/if}
