<script lang="ts">
	import { enhance } from '$app/forms';
	import TronButton from '$lib/components/ui/TronButton.svelte';
	import TronInput from '$lib/components/ui/TronInput.svelte';
	import KanbanModal from '$lib/components/kanban/KanbanModal.svelte';
	import TaskStatusBadge from '$lib/components/kanban/TaskStatusBadge.svelte';
	import { agingLevel, type KanbanStatus } from '$lib/shared/kanban-status';

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
	let parked = $derived(data.tasks.filter((t: TaskRow) => t.status === 'blocked' || t.status === 'waiting'));
	let review = $derived(data.tasks.filter((t: TaskRow) => t.status === 'review'));
	let ready = $derived(
		[...data.tasks.filter((t: TaskRow) => t.status === 'ready')].sort((a, b) => a.rank - b.rank)
	);
	let doneRecent = $derived(data.tasks.filter((t: TaskRow) => t.status === 'done'));

	// WIP grouped by assignee — grouping headers for legibility, not swim lanes.
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

	function inventoryHref(): string {
		return data.board === 'software' ? '/kanban/inventory?board=software' : '/kanban/inventory';
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
		<span class="rounded-full px-1.5 py-0.5 text-[10px] font-bold" style="background: rgba(129,140,248,0.15); color: #818cf8;">SPIKE</span>
	{:else if t.itemType === 'chore'}
		<span class="rounded-full px-1.5 py-0.5 text-[10px] font-bold" style="background: rgba(56,189,248,0.12); color: #38bdf8;">CHORE</span>
	{/if}
	{#if t.sizeClass}
		<span class="tron-text-muted rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[10px] uppercase">{t.sizeClass}</span>
	{/if}
	{#if t.projectName}
		<span class="inline-flex items-center gap-1 text-[10px]" style="color: {t.projectColor ?? 'var(--color-tron-text-secondary)'};">
			<span class="h-2 w-2 rounded-full" style="background: {t.projectColor ?? '#6b7280'};"></span>
			{t.projectName}
		</span>
	{/if}
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

<div class="space-y-6">
	<!-- Header -->
	<div class="flex flex-wrap items-start justify-between gap-4">
		<div>
			<h2 class="tron-text-primary text-2xl font-bold">The Queue</h2>
			<p class="tron-text-muted text-sm">
				Committed work on the <span class="font-bold uppercase">{data.board}</span> board.
				<a href={inventoryHref()} class="hover:underline" style="color: var(--color-tron-cyan);">
					{data.capturedCount} option{data.capturedCount === 1 ? '' : 's'} upstream in inventory
				</a>
			</p>
		</div>

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

	<!-- Quick capture: one line → a Tier 1 'captured' option -->
	<form
		method="POST"
		action="?/create"
		class="flex flex-wrap items-center gap-2"
		use:enhance={submitEnhance}
	>
		<div class="min-w-[240px] flex-1">
			<TronInput name="title" placeholder="Quick capture — one line is enough (goes to inventory as 'captured')" required />
		</div>
		<select name="projectId" class="tron-select" title="Project (optional)">
			<option value="">No project</option>
			{#each data.projects as p (p.id)}
				<option value={p.id}>{p.name}</option>
			{/each}
		</select>
		<TronButton type="submit" variant="primary" disabled={submitting}>Capture</TronButton>
	</form>

	<!-- Min order point signal -->
	{#if data.readyCount < data.minOrderPoint}
		<div class="rounded border border-[rgba(245,158,11,0.4)] bg-[rgba(245,158,11,0.08)] px-4 py-3 text-sm" style="color: #f59e0b;">
			Ready queue is at {data.readyCount} — below the minimum order point ({data.minOrderPoint}).
			Run <a href={data.board === 'software' ? '/kanban/replenish?board=software' : '/kanban/replenish'} class="font-bold underline">replenishment</a>
			before people start pulling from Tier 1 again.
		</div>
	{/if}

	<!-- Error banner: the server's explanation, verbatim -->
	{#if errorMsg}
		<div class="flex items-start justify-between gap-3 rounded border border-[rgba(255,51,102,0.3)] bg-[rgba(255,51,102,0.1)] px-4 py-3 text-sm" style="color: var(--color-tron-red);">
			<span>{errorMsg}</span>
			<button type="button" class="shrink-0 font-bold" onclick={() => (errorMsg = '')} aria-label="Dismiss">✕</button>
		</div>
	{/if}

	<!-- Supply panel (KB2-10) — standing targets, read-only -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
		<button
			type="button"
			class="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-[var(--color-tron-bg-tertiary)]"
			onclick={() => (supplyOpen = !supplyOpen)}
		>
			<span class="tron-text-primary text-sm font-bold">
				Supply — standing targets
				{#if data.standing.some((s: any) => s.belowReorderPoint)}
					<span class="ml-2 rounded-full px-2 py-0.5 text-[10px] font-bold" style="background: rgba(255,51,102,0.15); color: var(--color-tron-red);">
						{data.standing.filter((s: any) => s.belowReorderPoint).length} below reorder point
					</span>
				{/if}
			</span>
			<svg class="h-4 w-4 transition-transform {supplyOpen ? '' : '-rotate-90'}" style="color: var(--color-tron-text-secondary);" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
			</svg>
		</button>
		{#if supplyOpen}
			<div class="border-t border-[var(--color-tron-border)] px-4 py-3">
				{#if data.standing.length === 0}
					<p class="tron-text-muted text-xs">No standing targets defined. Create them on the Policy page.</p>
				{:else}
					<div class="space-y-3">
						{#each data.standing as s (s.targetId)}
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
										open build option →
									</a>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>

	<!-- WIP — grouped by assignee (grouping headers, not lanes) -->
	<section>
		<h3 class="tron-text-primary mb-3 text-sm font-bold uppercase tracking-wide">
			In Progress <span class="tron-text-muted font-normal">({wip.length})</span>
		</h3>
		{#if wip.length === 0}
			<p class="tron-text-muted text-xs">Nothing in progress.</p>
		{/if}
		{#each wipGroups as [assignee, tasks] (assignee)}
			<div class="mb-4">
				<p class="tron-text-muted mb-2 text-xs font-bold uppercase tracking-wide">{assignee}</p>
				<div class="space-y-2">
					{#each tasks as t (t.id)}
						{@const color = ageColor(t)}
						<div class="tron-card flex flex-wrap items-center gap-3 !p-3" style={color ? `border-left: 3px solid ${color};` : ''}>
							<div class="min-w-[200px] flex-1">
								<a href="/kanban/task/{t.id}" class="tron-text-primary text-sm font-medium hover:underline">{t.title}</a>
								<div class="mt-1 flex flex-wrap items-center gap-1.5">
									{@render cardChips(t)}
									{@render ageBadge(t)}
								</div>
							</div>
							<div class="flex shrink-0 items-center gap-2">
								<form method="POST" action="?/move" use:enhance={submitEnhance}>
									{@render hiddenTask(t)}
									<input type="hidden" name="to" value="done" />
									<TronButton type="submit" variant="primary" disabled={submitting}>Done</TronButton>
								</form>
								<TronButton onclick={() => (modal = { kind: 'block', task: t })}>Block…</TronButton>
								<TronButton onclick={() => (modal = { kind: 'wait', task: t })}>Wait…</TronButton>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/each}
	</section>

	<!-- Blocked / Waiting -->
	<section>
		<h3 class="tron-text-primary mb-3 text-sm font-bold uppercase tracking-wide">
			Blocked / Waiting <span class="tron-text-muted font-normal">({parked.length})</span>
		</h3>
		{#if parked.length === 0}
			<p class="tron-text-muted text-xs">Nothing parked. Good.</p>
		{:else}
			<div class="space-y-2">
				{#each parked as t (t.id)}
					{@const color = ageColor(t)}
					<div class="tron-card flex flex-wrap items-center gap-3 !p-3" style={color ? `border-left: 3px solid ${color};` : ''}>
						<div class="min-w-[200px] flex-1">
							<div class="flex items-center gap-2">
								<TaskStatusBadge status={t.status} />
								<a href="/kanban/task/{t.id}" class="tron-text-primary text-sm font-medium hover:underline">{t.title}</a>
							</div>
							<p class="mt-1 text-xs" style="color: var(--color-tron-red);">
								{#if t.status === 'blocked'}
									{t.blockedReason ?? 'No reason recorded'}
								{:else}
									Waiting on {t.waitingOn ?? '?'} until {fmtDate(t.waitingUntil)}{t.waitingReason ? ` — ${t.waitingReason}` : ''}
								{/if}
							</p>
							<div class="mt-1 flex flex-wrap items-center gap-1.5">
								{@render cardChips(t)}
								{@render ageBadge(t)}
							</div>
						</div>
						<div class="flex shrink-0 items-center gap-2">
							<form method="POST" action="?/resume" use:enhance={submitEnhance}>
								{@render hiddenTask(t)}
								<TronButton type="submit" variant="primary" disabled={submitting}>Resume</TronButton>
							</form>
							{#if data.canReplenish}
								<TronButton onclick={() => (modal = { kind: 'demote', task: t })}>Demote…</TronButton>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</section>

	<!-- Review (software board only) -->
	{#if data.board === 'software'}
		<section>
			<h3 class="tron-text-primary mb-3 text-sm font-bold uppercase tracking-wide">
				In Review <span class="tron-text-muted font-normal">({review.length})</span>
			</h3>
			{#if review.length === 0}
				<p class="tron-text-muted text-xs">No PRs awaiting review.</p>
			{:else}
				<div class="space-y-2">
					{#each review as t (t.id)}
						<div class="tron-card flex flex-wrap items-center gap-3 !p-3">
							<div class="min-w-[200px] flex-1">
								<a href="/kanban/task/{t.id}" class="tron-text-primary text-sm font-medium hover:underline">{t.title}</a>
								<div class="mt-1 flex flex-wrap items-center gap-1.5">
									{@render cardChips(t)}
									{@render ageBadge(t)}
								</div>
							</div>
							<form method="POST" action="?/move" use:enhance={submitEnhance}>
								{@render hiddenTask(t)}
								<input type="hidden" name="to" value="done" />
								<TronButton type="submit" variant="primary" disabled={submitting}>Done</TronButton>
							</form>
						</div>
					{/each}
				</div>
			{/if}
		</section>
	{/if}

	<!-- Ready — the global ordered queue -->
	<section>
		<h3 class="tron-text-primary mb-3 text-sm font-bold uppercase tracking-wide">
			Ready <span class="tron-text-muted font-normal">({ready.length} / cap {data.readyCap} — pull from the top {data.pullWindow} only)</span>
		</h3>
		{#if ready.length === 0}
			<p class="tron-text-muted text-xs">The ready queue is empty. Replenishment decides what enters it.</p>
		{:else}
			<div class="space-y-2">
				{#each ready as t (t.id)}
					{@const inWindow = t.rank >= 1 && t.rank <= data.pullWindow}
					<div
						class="tron-card flex flex-wrap items-center gap-3 !p-3"
						style={inWindow ? 'border-color: var(--color-tron-cyan); box-shadow: 0 0 8px rgba(0,212,255,0.15);' : ''}
					>
						<!-- Rank number badge, top-left. Order IS the layout. -->
						<span
							class="flex h-8 w-8 shrink-0 items-center justify-center rounded font-bold"
							style={inWindow
								? 'background: var(--color-tron-cyan); color: var(--color-tron-bg-primary);'
								: 'background: var(--color-tron-bg-tertiary); color: var(--color-tron-text-secondary);'}
						>
							{t.rank}
						</span>
						<div class="min-w-[200px] flex-1">
							<a href="/kanban/task/{t.id}" class="tron-text-primary text-sm font-medium hover:underline">{t.title}</a>
							<div class="mt-1 flex flex-wrap items-center gap-1.5">
								{@render cardChips(t)}
								{@render ageBadge(t)}
							</div>
						</div>
						<div class="flex shrink-0 items-center gap-2">
							{#if inWindow}
								<form method="POST" action="?/pull" use:enhance={submitEnhance}>
									{@render hiddenTask(t)}
									<TronButton type="submit" variant="primary" disabled={submitting}>Pull</TronButton>
								</form>
							{/if}
							{#if data.canReplenish}
								<TronButton onclick={() => (modal = { kind: 'demote', task: t })}>Demote…</TronButton>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</section>

	<!-- Done (recent 7 days, pre-archive) -->
	<section>
		<h3 class="tron-text-primary mb-3 text-sm font-bold uppercase tracking-wide">
			Done — last 7 days <span class="tron-text-muted font-normal">({doneRecent.length})</span>
		</h3>
		{#if doneRecent.length === 0}
			<p class="tron-text-muted text-xs">Nothing finished in the last 7 days.</p>
		{:else}
			<div class="space-y-1">
				{#each doneRecent as t (t.id)}
					<div class="flex flex-wrap items-center gap-2 rounded px-2 py-1 hover:bg-[var(--color-tron-bg-tertiary)]">
						<span class="h-2 w-2 shrink-0 rounded-full" style="background: #10b981;"></span>
						<a href="/kanban/task/{t.id}" class="tron-text-primary text-sm hover:underline">{t.title}</a>
						<span class="tron-text-muted text-xs">{fmtDate(t.completedDate)}</span>
						{@render cardChips(t)}
					</div>
				{/each}
			</div>
		{/if}
	</section>
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
