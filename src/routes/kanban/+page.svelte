<script lang="ts">
	import { enhance } from '$app/forms';
	import TronButton from '$lib/components/ui/TronButton.svelte';
	import TronInput from '$lib/components/ui/TronInput.svelte';
	import KanbanModal from '$lib/components/kanban/KanbanModal.svelte';
	import { agingLevel, STATUS_META, type KanbanStatus } from '$lib/shared/kanban-status';
	import { tagColor } from '$lib/shared/tag-color';

	let { data, form } = $props();

	type TaskRow = (typeof data.tasks)[number];

	let errorMsg = $state('');
	let submitting = $state(false);
	let supplyOpen = $state(true);
	let modal = $state<null | { kind: 'block' | 'wait' | 'demote'; task: TaskRow }>(null);

	// Server errors from non-enhanced navigations also land in `form`.
	$effect(() => {
		if ((form as any)?.error) errorMsg = (form as any).error;
	});

	let wip = $derived(data.tasks.filter((t: TaskRow) => t.status === 'wip'));
	let waiting = $derived(data.tasks.filter((t: TaskRow) => t.status === 'waiting'));
	let blocked = $derived(data.tasks.filter((t: TaskRow) => t.status === 'blocked'));
	let review = $derived(data.tasks.filter((t: TaskRow) => t.status === 'review'));
	let ready = $derived(
		[...data.tasks.filter((t: TaskRow) => t.status === 'ready')].sort((a, b) => a.rank - b.rank)
	);
	let doneRecent = $derived(data.tasks.filter((t: TaskRow) => t.status === 'done'));

	// WIP grouped by assignee — grouping subheaders inside the single column, not lanes.
	let wipGroups = $derived.by(() => {
		const groups = new Map<string, TaskRow[]>();
		for (const t of wip) {
			const key = t.assigneeName ?? 'Unassigned';
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(t);
		}
		return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
	});

	function ageColor(t: TaskRow): string | null {
		const level = agingLevel(t.status as KanbanStatus, t.daysInStatus);
		return level === 'critical' ? '#ef4444' : level === 'warn' ? '#f59e0b' : null;
	}

	function fmtDate(d: string | null): string {
		return d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
	}

	// Shared enhance: banner on failure, close modals on success.
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
</script>

{#snippet cardChips(t: TaskRow)}
	{#if t.classOfService === 'expedite'}
		<span class="rounded-full px-1.5 py-0.5 text-[10px] font-bold" style="background: rgba(255,51,102,0.15); color: var(--color-tron-red); border: 1px solid rgba(255,51,102,0.4);">EXPEDITE</span>
	{:else if t.classOfService === 'fixed_date'}
		<span class="rounded-full px-1.5 py-0.5 text-[10px] font-bold" style="background: rgba(245,158,11,0.12); color: #f59e0b;">FIXED {fmtDate(t.dueDate)}</span>
	{/if}
	{#if t.itemType === 'spike'}
		<span class="rounded-full px-1.5 py-0.5 text-[10px] font-bold" style="background: rgba(129,140,248,0.15); color: #818cf8;">INVESTIGATION</span>
	{:else if t.itemType === 'chore'}
		<span class="rounded-full px-1.5 py-0.5 text-[10px] font-bold" style="background: rgba(56,189,248,0.12); color: #38bdf8;">CHORE</span>
	{/if}
	{#if t.sizeClass}
		<span class="tron-text-muted rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[10px] uppercase">{t.sizeClass}</span>
	{/if}
	{#each t.tags as tag (tag)}
		<span class="inline-flex items-center gap-1 text-[10px]" style="color: {tagColor(tag)};">
			<span class="h-2 w-2 rounded-full" style="background: {tagColor(tag)};"></span>
			{tag}
		</span>
	{/each}
{/snippet}

{#snippet ageBadge(t: TaskRow)}
	{@const color = ageColor(t)}
	<span
		class="rounded-full px-1.5 py-0.5 text-[10px] font-bold"
		style={color ? `background: ${color}20; color: ${color};` : 'color: var(--color-tron-text-secondary);'}
		title="{t.daysInStatus} day{t.daysInStatus === 1 ? '' : 's'} in this status"
	>
		{t.daysInStatus}d
	</span>
{/snippet}

{#snippet hiddenTask(t: TaskRow)}
	<input type="hidden" name="taskId" value={t.id} />
{/snippet}

{#snippet columnHeader(label: string, color: string, count: string)}
	<div
		class="mb-3 flex items-center justify-between rounded-t-lg px-3 py-2"
		style="background: {color}15; border-bottom: 2px solid {color};"
	>
		<h3 class="text-sm font-bold" style="color: {color};">{label}</h3>
		<span
			class="inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-full px-1.5 text-xs font-bold"
			style="background: {color}20; color: {color};"
		>
			{count}
		</span>
	</div>
{/snippet}

<div class="space-y-6">
	<!-- Header -->
	<div class="flex flex-wrap items-start justify-between gap-4">
		<div>
			<h2 class="tron-text-primary text-2xl font-bold">Board</h2>
			<p class="tron-text-muted text-sm">Committed work — everything here is already approved. Pull anything.</p>
		</div>

		<!-- KB2-38: detailed capture pre-set to land on the Board (replenisher gate applies server-side) -->
		<a
			href="/kanban/capture?landing=committed"
			class="rounded border px-3 py-2 text-sm font-medium hover:underline"
			style="border-color: var(--color-tron-border); color: var(--color-tron-cyan);"
			title="Capture a fully shaped item straight onto the Board"
		>
			+ New task
		</a>

		<!-- Ready count vs cap gauge -->
		<div class="min-w-[200px]">
			<div class="mb-1 flex items-center justify-between text-xs">
				<span class="tron-text-muted">Ready queue</span>
				<span class="tron-text-primary font-bold">{data.readyCount} / {data.readyCap}</span>
			</div>
			<div class="h-2 w-full overflow-hidden rounded-full bg-[var(--color-tron-bg-tertiary)]">
				<div
					class="h-full rounded-full"
					style="width: {Math.min(100, (data.readyCount / Math.max(1, data.readyCap)) * 100)}%; background: {data.readyCount < data.minOrderPoint ? 'var(--color-tron-red)' : 'var(--color-tron-cyan)'};"
				></div>
			</div>
		</div>
	</div>

	<!-- Error banner: the server's explanation, verbatim -->
	{#if errorMsg}
		<div class="flex items-start justify-between gap-3 rounded border border-[rgba(255,51,102,0.3)] bg-[rgba(255,51,102,0.1)] px-4 py-3 text-sm" style="color: var(--color-tron-red);">
			<span>{errorMsg}</span>
			<button type="button" class="shrink-0 font-bold" onclick={() => (errorMsg = '')} aria-label="Dismiss">✕</button>
		</div>
	{/if}

	<!-- Supply panel (KB2-10/KB2-13) — standing targets + parts below minimum order qty.
	     Below a reorder point the system spawns an auto-committed supply card straight to
	     ready (Jacob's KB2-13 decision). Target CRUD lives on the policy page.
	     Hidden entirely when there is nothing to show. -->
	{#if data.standing.targets.length > 0 || data.standing.partsReorder.length > 0}
	{@const supplySignals = data.standing.targets.filter((s: any) => s.belowReorderPoint).length + data.standing.partsReorder.length}
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
		<button
			type="button"
			class="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-[var(--color-tron-bg-tertiary)]"
			onclick={() => (supplyOpen = !supplyOpen)}
		>
			<span class="tron-text-primary text-sm font-bold">
				Supply — standing targets &amp; reorders
				{#if supplySignals > 0}
					<span class="ml-2 rounded-full px-2 py-0.5 text-[10px] font-bold" style="background: rgba(255,51,102,0.15); color: var(--color-tron-red);">
						{supplySignals} below reorder point
					</span>
				{/if}
			</span>
			<svg class="h-4 w-4 transition-transform {supplyOpen ? '' : '-rotate-90'}" style="color: var(--color-tron-text-secondary);" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
			</svg>
		</button>
		{#if supplyOpen}
			<div class="border-t border-[var(--color-tron-border)] px-4 py-3">
				<div class="space-y-3">
						{#each data.standing.targets as s (s.targetId)}
							<div class="flex flex-wrap items-center gap-3 rounded px-2 py-1 {s.belowReorderPoint ? 'border border-[rgba(255,51,102,0.35)] bg-[rgba(255,51,102,0.06)]' : ''}">
								<span class="tron-text-primary min-w-[180px] text-sm">{s.name}</span>
								<div class="h-2 min-w-[120px] flex-1 overflow-hidden rounded-full bg-[var(--color-tron-bg-tertiary)]">
									<div
										class="h-full rounded-full"
										style="width: {s.actual === null ? 0 : Math.min(100, (s.actual / Math.max(1, s.target)) * 100)}%; background: {s.belowReorderPoint ? 'var(--color-tron-red)' : 'var(--color-tron-green, #10b981)'};"
									></div>
								</div>
								<span class="text-xs {s.belowReorderPoint ? 'font-bold' : 'tron-text-muted'}" style={s.belowReorderPoint ? 'color: var(--color-tron-red);' : ''}>
									{s.actual ?? '?'} / {s.target}
									<span class="tron-text-muted">(reorder at {s.reorderPoint})</span>
								</span>
								{#if s.openOptionId}
									<a href="/kanban/task/{s.openOptionId}" class="text-xs hover:underline" style="color: var(--color-tron-cyan);">
										open supply card →
									</a>
								{/if}
							</div>
						{/each}
						{#if data.standing.partsReorder.length > 0}
							<p class="tron-text-muted pt-1 text-[10px] uppercase tracking-wide">Parts at/below minimum order qty</p>
							{#each data.standing.partsReorder as p (p.partId)}
								<div class="flex flex-wrap items-center gap-3 rounded border border-[rgba(255,51,102,0.35)] bg-[rgba(255,51,102,0.06)] px-2 py-1">
									<span class="tron-text-primary min-w-[180px] text-sm">{p.partNumber} — {p.name ?? ''}</span>
									<span class="text-xs font-bold" style="color: var(--color-tron-red);">
										{p.inventoryCount} on hand
										<span class="tron-text-muted">(min {p.minimumOrderQty})</span>
									</span>
									{#if p.openTaskId}
										<a href="/kanban/task/{p.openTaskId}" class="text-xs hover:underline" style="color: var(--color-tron-cyan);">
											open order card →
										</a>
									{/if}
								</div>
							{/each}
						{/if}
					</div>
			</div>
		{/if}
	</div>
	{/if}

	<!-- Horizontal column board — one row, single swim lane. No drag-and-drop:
	     every move is an explicit button through the transition service. -->
	<div class="flex gap-4 overflow-x-auto pb-2" style="min-height: 320px;">
		<!-- Ready — the global ordered queue -->
		<div class="flex min-w-[250px] max-w-[340px] flex-1 flex-col rounded-lg">
			{@render columnHeader(STATUS_META.ready.label, STATUS_META.ready.color, `${ready.length} / ${data.readyCap}`)}
			<div class="max-h-[70vh] flex-1 space-y-2 overflow-y-auto pr-1">
				{#if ready.length === 0}
					<p class="tron-text-muted px-1 text-xs">The ready queue is empty. Replenishment decides what enters it.</p>
				{/if}
				{#each ready as t (t.id)}
					<div class="tron-card !p-3">
						<div class="flex items-start gap-2">
							<!-- No rank badge: being on the board IS the approval. Cards sit in
							     commit order (rank is kept server-side only as a stable sort key). -->
							<div class="min-w-0 flex-1">
								<a href="/kanban/task/{t.id}" class="tron-text-primary text-sm font-medium hover:underline">{t.title}</a>
								<div class="mt-1 flex flex-wrap items-center gap-1.5">
									{@render cardChips(t)}
									{@render ageBadge(t)}
								</div>
							</div>
						</div>
						<div class="mt-2 flex flex-wrap items-center gap-1.5">
							<form method="POST" action="?/pull" use:enhance={submitEnhance}>
								{@render hiddenTask(t)}
								<TronButton size="sm" type="submit" variant="primary" disabled={submitting}>Pull</TronButton>
							</form>
							{#if data.canReplenish}
								<TronButton size="sm" onclick={() => (modal = { kind: 'demote', task: t })}>Demote</TronButton>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- In Progress — grouped by assignee (subheaders, not lanes) -->
		<div class="flex min-w-[250px] max-w-[340px] flex-1 flex-col rounded-lg">
			{@render columnHeader(STATUS_META.wip.label, STATUS_META.wip.color, `${wip.length}`)}
			<div class="max-h-[70vh] flex-1 space-y-2 overflow-y-auto pr-1">
				{#if wip.length === 0}
					<p class="tron-text-muted px-1 text-xs">Nothing in progress.</p>
				{/if}
				{#each wipGroups as [assignee, tasks] (assignee)}
					<p class="tron-text-muted px-1 pt-1 text-[10px] font-bold uppercase tracking-wide">{assignee}</p>
					{#each tasks as t (t.id)}
						{@const color = ageColor(t)}
						<div class="tron-card !p-3" style={color ? `border-left: 3px solid ${color};` : ''}>
							<a href="/kanban/task/{t.id}" class="tron-text-primary text-sm font-medium hover:underline">{t.title}</a>
							<div class="mt-1 flex flex-wrap items-center gap-1.5">
								{@render cardChips(t)}
								{@render ageBadge(t)}
							</div>
							<div class="mt-2 flex flex-wrap items-center gap-1.5">
								<form method="POST" action="?/move" use:enhance={submitEnhance}>
									{@render hiddenTask(t)}
									<input type="hidden" name="to" value="done" />
									<TronButton size="sm" type="submit" variant="primary" disabled={submitting}>Done</TronButton>
								</form>
								<TronButton size="sm" onclick={() => (modal = { kind: 'block', task: t })}>Block</TronButton>
								<TronButton size="sm" onclick={() => (modal = { kind: 'wait', task: t })}>Wait</TronButton>
							</div>
						</div>
					{/each}
				{/each}
			</div>
		</div>

		<!-- In Review (KB2-16: review is legal for all work; shown when occupied) -->
		{#if review.length > 0}
			<div class="flex min-w-[250px] max-w-[340px] flex-1 flex-col rounded-lg">
				{@render columnHeader(STATUS_META.review.label, STATUS_META.review.color, `${review.length}`)}
				<div class="max-h-[70vh] flex-1 space-y-2 overflow-y-auto pr-1">
					{#each review as t (t.id)}
						<div class="tron-card !p-3">
							<a href="/kanban/task/{t.id}" class="tron-text-primary text-sm font-medium hover:underline">{t.title}</a>
							<div class="mt-1 flex flex-wrap items-center gap-1.5">
								{@render cardChips(t)}
								{@render ageBadge(t)}
							</div>
							<div class="mt-2">
								<form method="POST" action="?/move" use:enhance={submitEnhance}>
									{@render hiddenTask(t)}
									<input type="hidden" name="to" value="done" />
									<TronButton size="sm" type="submit" variant="primary" disabled={submitting}>Done</TronButton>
								</form>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Waiting — named external dependency -->
		<div class="flex min-w-[250px] max-w-[340px] flex-1 flex-col rounded-lg">
			{@render columnHeader(STATUS_META.waiting.label, STATUS_META.waiting.color, `${waiting.length}`)}
			<div class="max-h-[70vh] flex-1 space-y-2 overflow-y-auto pr-1">
				{#if waiting.length === 0}
					<p class="tron-text-muted px-1 text-xs">Nothing waiting.</p>
				{/if}
				{#each waiting as t (t.id)}
					{@const color = ageColor(t)}
					<div class="tron-card !p-3" style={color ? `border-left: 3px solid ${color};` : ''}>
						<a href="/kanban/task/{t.id}" class="tron-text-primary text-sm font-medium hover:underline">{t.title}</a>
						<p class="mt-1 text-xs" style="color: var(--color-tron-red);">
							Waiting on {t.waitingOn ?? '?'} until {fmtDate(t.waitingUntil)}{t.waitingReason ? ` — ${t.waitingReason}` : ''}
						</p>
						<div class="mt-1 flex flex-wrap items-center gap-1.5">
							{@render cardChips(t)}
							{@render ageBadge(t)}
						</div>
						<div class="mt-2 flex flex-wrap items-center gap-1.5">
							<form method="POST" action="?/resume" use:enhance={submitEnhance}>
								{@render hiddenTask(t)}
								<TronButton size="sm" type="submit" variant="primary" disabled={submitting}>Resume</TronButton>
							</form>
							{#if data.canReplenish}
								<TronButton size="sm" onclick={() => (modal = { kind: 'demote', task: t })}>Demote</TronButton>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- Blocked — blocked on us, reason on the card -->
		<div class="flex min-w-[250px] max-w-[340px] flex-1 flex-col rounded-lg">
			{@render columnHeader(STATUS_META.blocked.label, STATUS_META.blocked.color, `${blocked.length}`)}
			<div class="max-h-[70vh] flex-1 space-y-2 overflow-y-auto pr-1">
				{#if blocked.length === 0}
					<p class="tron-text-muted px-1 text-xs">Nothing blocked. Good.</p>
				{/if}
				{#each blocked as t (t.id)}
					{@const color = ageColor(t)}
					<div class="tron-card !p-3" style={color ? `border-left: 3px solid ${color};` : ''}>
						<a href="/kanban/task/{t.id}" class="tron-text-primary text-sm font-medium hover:underline">{t.title}</a>
						<p class="mt-1 text-xs" style="color: var(--color-tron-red);">
							{t.blockedReason ?? 'No reason recorded'}
						</p>
						<div class="mt-1 flex flex-wrap items-center gap-1.5">
							{@render cardChips(t)}
							{@render ageBadge(t)}
						</div>
						<div class="mt-2 flex flex-wrap items-center gap-1.5">
							<form method="POST" action="?/resume" use:enhance={submitEnhance}>
								{@render hiddenTask(t)}
								<TronButton size="sm" type="submit" variant="primary" disabled={submitting}>Resume</TronButton>
							</form>
							{#if data.canReplenish}
								<TronButton size="sm" onclick={() => (modal = { kind: 'demote', task: t })}>Demote</TronButton>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- Done (recent 7 days, pre-archive) -->
		<div class="flex min-w-[250px] max-w-[340px] flex-1 flex-col rounded-lg">
			{@render columnHeader(`${STATUS_META.done.label} — 7d`, STATUS_META.done.color, `${doneRecent.length}`)}
			<div class="max-h-[70vh] flex-1 space-y-2 overflow-y-auto pr-1">
				{#if doneRecent.length === 0}
					<p class="tron-text-muted px-1 text-xs">Nothing finished in the last 7 days.</p>
				{/if}
				{#each doneRecent as t (t.id)}
					<div class="tron-card !p-3">
						<div class="flex items-center gap-2">
							<span class="h-2 w-2 shrink-0 rounded-full" style="background: #10b981;"></span>
							<a href="/kanban/task/{t.id}" class="tron-text-primary min-w-0 flex-1 text-sm hover:underline">{t.title}</a>
							<span class="tron-text-muted shrink-0 text-xs">{fmtDate(t.completedDate)}</span>
						</div>
						<div class="mt-1 flex flex-wrap items-center gap-1.5">
							{@render cardChips(t)}
						</div>
					</div>
				{/each}
			</div>
		</div>
	</div>
</div>

<!-- Block… modal -->
{#if modal?.kind === 'block'}
	<KanbanModal title="Block: {modal.task.title}" onclose={() => (modal = null)}>
		<form method="POST" action="?/block" use:enhance={submitEnhance}>
			<input type="hidden" name="taskId" value={modal.task.id} />
			<div class="mb-4">
				<label for="block-reason" class="tron-label">What is blocking us? (required)</label>
				<textarea id="block-reason" name="reason" class="tron-input w-full" rows="3" required placeholder="Blocked on us — the reason is kept on the card."></textarea>
			</div>
			<div class="flex justify-end gap-3">
				<TronButton onclick={() => (modal = null)}>Cancel</TronButton>
				<TronButton type="submit" variant="primary" disabled={submitting}>Block</TronButton>
			</div>
		</form>
	</KanbanModal>
{/if}

<!-- Wait… modal -->
{#if modal?.kind === 'wait'}
	<KanbanModal title="Wait: {modal.task.title}" onclose={() => (modal = null)}>
		<form method="POST" action="?/wait" use:enhance={submitEnhance}>
			<input type="hidden" name="taskId" value={modal.task.id} />
			<div class="mb-4">
				<TronInput label="Waiting on (named external dependency)" name="waitingOn" required placeholder="Vendor, person, delivery…" />
			</div>
			<div class="mb-4">
				<TronInput label="Follow up by" name="waitingUntil" type="date" required />
			</div>
			<div class="mb-4">
				<label for="wait-reason" class="tron-label">Notes (optional)</label>
				<textarea id="wait-reason" name="reason" class="tron-input w-full" rows="2"></textarea>
			</div>
			<div class="flex justify-end gap-3">
				<TronButton onclick={() => (modal = null)}>Cancel</TronButton>
				<TronButton type="submit" variant="primary" disabled={submitting}>Wait</TronButton>
			</div>
		</form>
	</KanbanModal>
{/if}

<!-- Demote… modal -->
{#if modal?.kind === 'demote'}
	<KanbanModal title="Demote: {modal.task.title}" onclose={() => (modal = null)}>
		<p class="tron-text-muted mb-4 text-sm">
			Demotion unwinds a commitment: the item leaves the queue and returns to Tier 1 as 'processed'.
			The reason is audited.
		</p>
		<form method="POST" action="?/demote" use:enhance={submitEnhance}>
			<input type="hidden" name="taskId" value={modal.task.id} />
			<div class="mb-4">
				<label for="demote-reason" class="tron-label">Reason (required)</label>
				<textarea id="demote-reason" name="reason" class="tron-input w-full" rows="3" required></textarea>
			</div>
			<div class="flex justify-end gap-3">
				<TronButton onclick={() => (modal = null)}>Cancel</TronButton>
				<TronButton type="submit" variant="danger" disabled={submitting}>Demote</TronButton>
			</div>
		</form>
	</KanbanModal>
{/if}
