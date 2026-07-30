<script lang="ts">
	import { enhance } from '$app/forms';
	import TronButton from '$lib/components/ui/TronButton.svelte';
	import KanbanModal from '$lib/components/kanban/KanbanModal.svelte';
	import TaskStatusBadge from '$lib/components/kanban/TaskStatusBadge.svelte';

	let { data, form } = $props();

	let errorMsg = $state('');
	let submitting = $state(false);
	let staged = $state<string[]>([]);
	let note = $state('');
	let demoteTarget = $state<null | { taskId: string; title: string }>(null);

	$effect(() => {
		if ((form as any)?.error) errorMsg = (form as any).error;
	});

	let result = $derived((form as any)?.replenishResult ?? null);

	let candidates = $derived(data.status.candidates as any[]);
	let candidateById = $derived(new Map(candidates.map((c: any) => [c.taskId, c])));
	let readyQueue = $derived(data.status.ready.queue as any[]);
	let wipByClass = $derived(data.status.wipByClassOfService as Record<string, number>);
	let allocation = $derived(data.status.allocationTargetsPct as Record<string, number>);
	let wipTotal = $derived(Object.values(wipByClass).reduce((a, b) => a + b, 0));

	function toggleStaged(taskId: string) {
		staged = staged.includes(taskId) ? staged.filter((id) => id !== taskId) : [...staged, taskId];
	}

	function moveStaged(taskId: string, dir: -1 | 1) {
		const i = staged.indexOf(taskId);
		const j = i + dir;
		if (i === -1 || j < 0 || j >= staged.length) return;
		const next = [...staged];
		[next[i], next[j]] = [next[j], next[i]];
		staged = next;
	}

	function submitEnhance() {
		submitting = true;
		return async ({ result: r, update }: { result: any; update: (opts?: any) => Promise<void> }) => {
			submitting = false;
			if (r.type === 'failure') {
				errorMsg = r.data?.error ?? 'Action failed';
				demoteTarget = null;
				await update({ reset: false });
			} else {
				if (r.type === 'success') {
					errorMsg = '';
					demoteTarget = null;
					staged = [];
					note = '';
				}
				await update({ reset: false });
			}
		};
	}

	function fmtWhen(d: string): string {
		return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	}

	const classOrder = ['standard', 'fixed_date', 'chore', 'expedite'];
</script>

<div class="space-y-6">
	<div>
		<h2 class="tron-text-primary text-2xl font-bold">Replenishment</h2>
		<p class="tron-text-muted text-sm">
			The commitment point of the <span class="font-bold uppercase">{data.board}</span> board.
			Crossing Tier 1 → Tier 2 happens here and nowhere else.
		</p>
	</div>

	{#if !data.canReplenish}
		<div class="rounded border border-[rgba(245,158,11,0.4)] bg-[rgba(245,158,11,0.08)] px-4 py-3 text-sm" style="color: #f59e0b;">
			Read-only: you do not hold <code>kanban:replenish</code>. Only a designated replenisher commits work
			— you can inspect candidates, the queue, and past decisions.
		</div>
	{/if}

	{#if errorMsg}
		<div class="flex items-start justify-between gap-3 rounded border border-[rgba(255,51,102,0.3)] bg-[rgba(255,51,102,0.1)] px-4 py-3 text-sm" style="color: var(--color-tron-red);">
			<span>{errorMsg}</span>
			<button type="button" class="shrink-0 font-bold" onclick={() => (errorMsg = '')} aria-label="Dismiss">✕</button>
		</div>
	{/if}

	<!-- Commit result: promoted + rejected-with-reasons -->
	{#if result}
		<div class="tron-card space-y-3 !p-4">
			<h3 class="tron-text-primary text-sm font-bold">
				Replenishment result — {result.promoted.length} promoted, {result.rejected.length} rejected
				<span class="tron-text-muted font-normal">(ready {result.readyCount}/{result.readyCap})</span>
			</h3>
			{#if result.promoted.length}
				<ul class="space-y-1">
					{#each result.promoted as p (p.taskId)}
						<li class="text-sm" style="color: var(--color-tron-green, #10b981);">
							#{p.rank} — <a href="/kanban/task/{p.taskId}" class="hover:underline">{p.title}</a>
						</li>
					{/each}
				</ul>
			{/if}
			{#if result.rejected.length}
				<ul class="space-y-1">
					{#each result.rejected as r (r.taskId)}
						<li class="text-sm" style="color: var(--color-tron-red);">
							{r.title ?? r.taskId}: {r.reason}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}

	<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
		<!-- Left: candidates -->
		<div class="space-y-4">
			<div class="tron-card !p-4">
				<h3 class="tron-text-primary mb-3 text-sm font-bold uppercase tracking-wide">Candidates (Tier 1)</h3>
				{#if candidates.length === 0}
					<p class="tron-text-muted text-xs">No uncommitted options on this board. Capture some in Inventory.</p>
				{:else}
					<div class="max-h-[480px] space-y-1.5 overflow-y-auto pr-1">
						{#each candidates as c (c.taskId)}
							{@const selectable = data.canReplenish && c.status === 'processed'}
							<div class="flex items-start gap-2 rounded px-2 py-1.5 {staged.includes(c.taskId) ? 'bg-[rgba(0,212,255,0.08)]' : 'hover:bg-[var(--color-tron-bg-tertiary)]'}">
								<input
									type="checkbox"
									class="mt-1"
									checked={staged.includes(c.taskId)}
									disabled={!selectable}
									onchange={() => toggleStaged(c.taskId)}
									title={c.status !== 'processed' ? "Still 'captured' — process it first" : undefined}
								/>
								<div class="min-w-0 flex-1">
									<div class="flex flex-wrap items-center gap-2">
										<a href="/kanban/task/{c.taskId}" class="tron-text-primary text-sm hover:underline">{c.title}</a>
										<TaskStatusBadge status={c.status} />
										{#if c.project}<span class="tron-text-muted text-[10px]">{c.project}</span>{/if}
										{#if c.origin === 'discovered'}
											<span class="rounded px-1.5 py-0.5 text-[10px] font-bold" style="background: rgba(167,139,250,0.15); color: #a78bfa;">DISCOVERED</span>
										{/if}
									</div>
									{#if c.dorComplete}
										<p class="text-[11px]" style="color: var(--color-tron-green, #10b981);">DoR complete</p>
									{:else}
										<details class="text-[11px]" style="color: #f59e0b;">
											<summary class="cursor-pointer">DoR incomplete ({c.dorMissing.length} missing)</summary>
											<ul class="mt-1 list-inside list-disc">
												{#each c.dorMissing as m (m)}
													<li>{m}</li>
												{/each}
											</ul>
										</details>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Staging list: arrange the commit order, then Commit -->
			<div class="tron-card !p-4">
				<h3 class="tron-text-primary mb-3 text-sm font-bold uppercase tracking-wide">
					Staged for commitment <span class="tron-text-muted font-normal">({staged.length})</span>
				</h3>
				{#if staged.length === 0}
					<p class="tron-text-muted text-xs">Select candidates on the left, arrange their order, then commit.</p>
				{:else}
					<ol class="mb-3 space-y-1.5">
						{#each staged as id, i (id)}
							{@const c = candidateById.get(id)}
							<li class="flex items-center gap-2">
								<span class="tron-text-muted w-5 text-right text-xs font-bold">{i + 1}</span>
								<span class="tron-text-primary flex-1 truncate text-sm">{c?.title ?? id}</span>
								<button type="button" class="tron-button !px-2 !py-0.5 text-xs" onclick={() => moveStaged(id, -1)} disabled={i === 0} title="Move up">▲</button>
								<button type="button" class="tron-button !px-2 !py-0.5 text-xs" onclick={() => moveStaged(id, 1)} disabled={i === staged.length - 1} title="Move down">▼</button>
								<button type="button" class="text-xs font-bold" style="color: var(--color-tron-red);" onclick={() => toggleStaged(id)} title="Remove">✕</button>
							</li>
						{/each}
					</ol>
					<form method="POST" action="?/commit" use:enhance={submitEnhance}>
						{#each staged as id (id)}
							<input type="hidden" name="taskIds" value={id} />
						{/each}
						<div class="mb-3">
							<label for="commit-note" class="tron-label">Note (optional — recorded on the event)</label>
							<input id="commit-note" name="note" class="tron-input w-full" bind:value={note} />
						</div>
						<TronButton type="submit" variant="primary" disabled={submitting || !data.canReplenish}>
							{submitting ? 'Committing…' : `Commit ${staged.length} item${staged.length === 1 ? '' : 's'}`}
						</TronButton>
					</form>
				{/if}
			</div>
		</div>

		<!-- Right: current ready queue + capacity signals -->
		<div class="space-y-4">
			<div class="tron-card !p-4">
				<div class="mb-2 flex items-center justify-between">
					<h3 class="tron-text-primary text-sm font-bold uppercase tracking-wide">Ready queue</h3>
					<span class="tron-text-primary text-sm font-bold">{data.status.ready.count} / {data.status.ready.cap}</span>
				</div>
				<div class="mb-3 h-2 w-full overflow-hidden rounded-full bg-[var(--color-tron-bg-tertiary)]">
					<div
						class="h-full rounded-full"
						style="width: {Math.min(100, (data.status.ready.count / Math.max(1, data.status.ready.cap)) * 100)}%; background: {data.status.ready.belowMinOrderPoint ? 'var(--color-tron-red)' : 'var(--color-tron-cyan)'};"
					></div>
				</div>
				{#if data.status.ready.belowMinOrderPoint}
					<p class="mb-3 text-xs font-bold" style="color: var(--color-tron-red);">
						Below the minimum order point ({data.status.ready.minOrderPoint}) — replenish now.
					</p>
				{/if}
				{#if readyQueue.length === 0}
					<p class="tron-text-muted text-xs">The ready queue is empty.</p>
				{:else}
					<div class="space-y-1.5">
						{#each readyQueue as t (t._id)}
							<div class="flex items-center gap-2">
								<span class="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-[var(--color-tron-bg-tertiary)] text-xs font-bold" style="color: var(--color-tron-text-secondary);">{t.rank}</span>
								<a href="/kanban/task/{t._id}" class="tron-text-primary flex-1 truncate text-sm hover:underline">{t.title}</a>
								{#if t.classOfService && t.classOfService !== 'standard'}
									<span class="tron-text-muted text-[10px] uppercase">{t.classOfService}</span>
								{/if}
								{#if data.canReplenish}
									<TronButton onclick={() => (demoteTarget = { taskId: t._id, title: t.title })}>Demote…</TronButton>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- WIP share per class of service vs allocation targets -->
			<div class="tron-card !p-4">
				<h3 class="tron-text-primary mb-3 text-sm font-bold uppercase tracking-wide">WIP by class of service</h3>
				<table class="w-full text-sm">
					<thead>
						<tr class="tron-text-muted text-left text-xs uppercase">
							<th class="pb-2">Class</th>
							<th class="pb-2 text-right">WIP</th>
							<th class="pb-2 text-right">Share</th>
							<th class="pb-2 text-right">Target</th>
						</tr>
					</thead>
					<tbody>
						{#each classOrder as cos (cos)}
							{@const n = wipByClass[cos] ?? 0}
							{@const share = wipTotal ? Math.round((n / wipTotal) * 100) : 0}
							{@const target = allocation?.[cos] ?? null}
							<tr class="border-t border-[var(--color-tron-border)]">
								<td class="tron-text-primary py-1.5 capitalize">{cos.replace('_', ' ')}</td>
								<td class="tron-text-primary py-1.5 text-right">{n}</td>
								<td class="py-1.5 text-right {target !== null && share > target ? 'font-bold' : 'tron-text-primary'}" style={target !== null && share > target ? 'color: #f59e0b;' : ''}>{share}%</td>
								<td class="tron-text-muted py-1.5 text-right">{target === null ? '—' : `${target}%`}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="tron-text-muted mt-2 text-[11px]">
					Allocation is advisory at commit time — except the chore ceiling, which is enforced (chore is a floor AND a ceiling).
				</p>
			</div>

			<!-- Recent replenishment events -->
			<div class="tron-card !p-4">
				<h3 class="tron-text-primary mb-3 text-sm font-bold uppercase tracking-wide">Recent replenishment events</h3>
				{#if data.events.length === 0}
					<p class="tron-text-muted text-xs">No replenishment events yet on this board.</p>
				{:else}
					<ul class="space-y-1.5">
						{#each data.events as e (e.id)}
							<li class="text-sm">
								<span class="tron-text-primary font-bold">{e.by}</span>
								<span class="tron-text-muted"> — {fmtWhen(e.at)} — </span>
								<span class="tron-text-primary">{e.promotedCount} promoted</span>
								{#if e.rejectedCount}
									<span style="color: var(--color-tron-red);">, {e.rejectedCount} rejected</span>
								{/if}
								{#if e.note}
									<span class="tron-text-muted block text-xs">“{e.note}”</span>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	</div>
</div>

<!-- Demote modal -->
{#if demoteTarget}
	<KanbanModal title="Demote: {demoteTarget.title}" onclose={() => (demoteTarget = null)}>
		<p class="tron-text-muted mb-4 text-sm">
			Unwinds the commitment — back to Tier 1 as 'processed'. The reason is audited.
		</p>
		<form method="POST" action="?/demote" use:enhance={submitEnhance}>
			<input type="hidden" name="taskId" value={demoteTarget.taskId} />
			<div class="mb-4">
				<label for="rep-demote-reason" class="tron-label">Reason (required)</label>
				<textarea id="rep-demote-reason" name="reason" class="tron-input w-full" rows="3" required></textarea>
			</div>
			<div class="flex justify-end gap-3">
				<TronButton onclick={() => (demoteTarget = null)}>Cancel</TronButton>
				<TronButton type="submit" variant="danger" disabled={submitting}>Demote</TronButton>
			</div>
		</form>
	</KanbanModal>
{/if}
