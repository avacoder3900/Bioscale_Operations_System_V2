<script lang="ts">
	import { enhance, deserialize } from '$app/forms';
	import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
	import TronButton from '$lib/components/ui/TronButton.svelte';
	import TronInput from '$lib/components/ui/TronInput.svelte';
	import TaskStatusBadge from '$lib/components/kanban/TaskStatusBadge.svelte';
	import KanbanModal from '$lib/components/kanban/KanbanModal.svelte';
	import CommentList from '$lib/components/kanban/CommentList.svelte';
	import TagPicker from '$lib/components/kanban/TagPicker.svelte';
	import ActivityLog from '$lib/components/kanban/ActivityLog.svelte';
	import { STATUS_META, SIZE_CLASSES, CLASSES_OF_SERVICE, type KanbanStatus } from '$lib/shared/kanban-status';

	let { data, form } = $props();

	let saving = $state(false);
	let archiving = $state(false);

	// Back link returns to whichever kanban page you came from (queue,
	// inventory, roadmap, flow, …) — not always the queue board.
	// Persisted per tab so a refresh (or task→task
	// hopping after one) doesn't forget the origin; nav.from === null means a
	// fresh document load, the only time the stored origin is consulted.
	const BACK_KEY = 'kanban:taskBackUrl';
	let backUrl = $state('/kanban');
	afterNavigate((nav) => {
		const from = nav.from?.url;
		if (from && from.pathname.startsWith('/kanban') && !from.pathname.startsWith('/kanban/task/')) {
			backUrl = from.pathname + from.search;
			try { sessionStorage.setItem(BACK_KEY, backUrl); } catch { /* private mode etc. */ }
		} else if (!from) {
			try { backUrl = sessionStorage.getItem(BACK_KEY) ?? backUrl; } catch { /* keep default */ }
		}
	});

	// Autosave: unsaved edit-form changes are flushed to ?/update when
	// navigating away, so hitting Save Changes is optional.
	let dirty = $state(false);
	let autosaveError = $state<string | null>(null);
	let editForm: HTMLFormElement | undefined = $state();

	async function autosave(): Promise<boolean> {
		if (!editForm) return true;
		const response = await fetch('?/update', {
			method: 'POST',
			body: new FormData(editForm),
			headers: { 'x-sveltekit-action': 'true' }
		});
		const result = deserialize(await response.text());
		if (result.type === 'success') {
			dirty = false;
			return true;
		}
		autosaveError =
			(result.type === 'failure' && (result.data as any)?.error) ||
			'Could not auto-save your changes — fix the form and save manually.';
		return false;
	}

	beforeNavigate((nav) => {
		if (!dirty || archiving) return;
		if (nav.type === 'leave') {
			// Tab close / hard navigation — best-effort, can't await.
			if (editForm) navigator.sendBeacon(`${location.pathname}?/update`, new FormData(editForm));
			return;
		}
		const to = nav.to?.url;
		nav.cancel();
		autosave().then((ok) => {
			if (ok && to) goto(to.href);
		});
	});

	// KB2-07 — the stop-now test + spike close
	let relatedStep = $state<null | 'ask' | 'option' | 'context'>(null);
	let showSpikeClose = $state(false);
	let spikeOptionTitles = $state<string[]>(['']);
	let modalSubmitting = $state(false);

	function modalEnhance() {
		modalSubmitting = true;
		return async ({ result, update }: { result: any; update: (opts?: any) => Promise<void> }) => {
			modalSubmitting = false;
			if (result.type === 'success') {
				relatedStep = null;
				showSpikeClose = false;
				spikeOptionTitles = [''];
			}
			await update({ reset: false });
		};
	}

	// Flow buttons per status. Tier crossings (captured/processed → ready and
	// ready → captured) are NOT offered here — the server rejects them by
	// design (KB2-02: commitment goes through replenishment on Tier 1). The
	// old header "Ready" button was exactly that dead end; captured options
	// get a Process button instead (2026-08-20), processed ones a Reshape.
	const statusFlow: Partial<Record<KanbanStatus, { prev?: KanbanStatus; next?: KanbanStatus }>> = {
		captured: {},
		processed: {},
		ready: { next: 'wip' },
		wip: { prev: 'ready', next: 'waiting' },
		waiting: { prev: 'wip', next: 'wip' },
		blocked: { next: 'wip' },
		review: { next: 'done' },
		done: {}
	};

	function statusLabel(status: string): string {
		return STATUS_META[status as KanbanStatus]?.label ?? status;
	}

	const sizeLabels: Record<string, string> = { short: 'Short', medium: 'Medium', long: 'Long' };

	// KB2-33 dependencies panel — add-link form state.
	let linkType = $state<'blocked_by' | 'blocks' | 'relates_to'>('blocked_by');
	const linkGroups = $derived({
		blocked_by: data.links.filter((l: any) => l.type === 'blocked_by'),
		blocks: data.links.filter((l: any) => l.type === 'blocks'),
		relates_to: data.links.filter((l: any) => l.type === 'relates_to')
	});

	// KB2-03/KB2-12 unified Process modal (mirrors /kanban/inventory).
	let showProcess = $state(false);
	let processCos = $state('standard');
	function openProcess() {
		processCos = data.task.classOfService ?? 'standard';
		showProcess = true;
	}
	const cosLabels: Record<string, string> = {
		standard: 'Standard',
		fixed_date: 'Fixed date (real external deadline)',
		chore: 'Chore',
		expedite: 'Expedite (emergency lane — system-capped)'
	};
	const isSoftware = $derived((data.task.tags ?? []).some((t: { name: string }) => t.name === 'software'));

	let flow = $derived(statusFlow[data.task.status as KanbanStatus] ?? {});

	let dueDateValue = $derived.by(() => {
		if (!data.task.dueDate) return '';
		const d = new Date(data.task.dueDate);
		return d.toISOString().split('T')[0];
	});

	let selectedTagIds = $derived(data.taskTags.map((t: { id: string }) => t.id));

	function formatDate(date: Date | string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}
</script>

<div class="space-y-6">
	<!-- Breadcrumb -->
	<div class="flex items-center gap-3">
		<a
			href={backUrl}
			class="flex items-center gap-1 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-cyan)]"
		>
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
			</svg>
			Back
		</a>
		<span class="tron-text-muted text-sm">/</span>
		<span class="tron-text-muted text-sm">Task Detail</span>
	</div>

	<!-- Messages -->
	{#if form?.error}
		<div
			class="rounded border border-[rgba(255,51,102,0.3)] bg-[rgba(255,51,102,0.1)] px-4 py-3 text-sm"
			style="color: var(--color-tron-red);"
		>
			{form.error}
		</div>
	{/if}
	{#if autosaveError}
		<div
			class="rounded border border-[rgba(255,51,102,0.3)] bg-[rgba(255,51,102,0.1)] px-4 py-3 text-sm"
			style="color: var(--color-tron-red);"
		>
			{autosaveError}
		</div>
	{/if}
	{#if form?.success}
		<div
			class="rounded border border-[rgba(0,255,136,0.3)] bg-[rgba(0,255,136,0.1)] px-4 py-3 text-sm"
			style="color: var(--color-tron-green);"
		>
			Changes saved successfully.
		</div>
	{/if}

	<div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
		<!-- Left column: main form -->
		<div class="lg:col-span-2">
			<div class="tron-card">
				<!-- Status & actions header -->
				<div class="mb-6 flex flex-wrap items-center justify-between gap-3">
					<div class="flex items-center gap-3">
						<TaskStatusBadge status={data.task.status} />
					</div>
					<div class="flex items-center gap-2">
						{#if flow.prev}
							<form method="POST" action="?/move" use:enhance>
								<input type="hidden" name="taskId" value={data.task.id} />
								<input type="hidden" name="newStatus" value={flow.prev} />
								<TronButton type="submit">
									<span class="flex items-center gap-1">
										<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width="2"
												d="M15 19l-7-7 7-7"
											/>
										</svg>
										{statusLabel(flow.prev)}
									</span>
								</TronButton>
							</form>
						{/if}
						{#if flow.next}
							<form method="POST" action="?/move" use:enhance>
								<input type="hidden" name="taskId" value={data.task.id} />
								<input type="hidden" name="newStatus" value={flow.next} />
								<TronButton type="submit" variant="primary">
									<span class="flex items-center gap-1">
										{statusLabel(flow.next)}
										<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width="2"
												d="M9 5l7 7-7 7"
											/>
										</svg>
									</span>
								</TronButton>
							</form>
						{/if}
						{#if data.task.status === 'captured'}
							<TronButton variant="primary" onclick={openProcess}>Process</TronButton>
						{:else if data.task.status === 'processed'}
							<TronButton onclick={openProcess}>Reshape</TronButton>
						{/if}
						{#if data.task.status === 'done'}
							<TronButton variant="primary" disabled>Completed</TronButton>
						{/if}
						{#if data.task.itemType === 'spike' && data.task.status === 'wip'}
							<TronButton variant="primary" onclick={() => (showSpikeClose = true)}>
								Close investigation
							</TronButton>
						{/if}
						<TronButton onclick={() => (relatedStep = 'ask')}>Related work discovered</TronButton>
					</div>
				</div>

				<!-- Edit form -->
				<form
					method="POST"
					action="?/update"
					bind:this={editForm}
					oninput={() => {
						dirty = true;
						autosaveError = null;
					}}
					use:enhance={() => {
						saving = true;
						return async ({ result, update }) => {
							saving = false;
							if (result.type === 'success') dirty = false;
							await update();
						};
					}}
				>
					<div class="mb-4">
						<TronInput
							label="Title"
							name="title"
							value={data.task.title}
							placeholder="Task title..."
							required
						/>
					</div>

					<div class="mb-4">
						<label for="description" class="tron-label">Description</label>
						<textarea
							id="description"
							name="description"
							class="tron-input w-full"
							rows="4"
							placeholder="Task description...">{data.task.description ?? ''}</textarea
						>
					</div>

					<!-- DoR deliverable — editable at any tier; pre-fills Process, required to commit -->
					<div class="mb-4">
						<label for="deliverable" class="tron-label">Deliverable (DoR)</label>
						<textarea
							id="deliverable"
							name="deliverable"
							class="tron-input w-full"
							rows="3"
							placeholder="What will exist or be true when this is done — and how you'd verify it. Outcome, not steps."
							>{data.task.dor.deliverable}</textarea
						>
					</div>

					<div class="mb-4">
						<label for="assignedTo" class="tron-label">Assign To</label>
						<select
							id="assignedTo"
							name="assignedTo"
							class="tron-select w-full"
							value={data.task.assignedTo ?? ''}
						>
							<option value="">Unassigned</option>
							{#each data.users as u}
								<option value={u.id}>{u.username}</option>
							{/each}
						</select>
					</div>

					<div class="mb-4">
						<TronInput label="Due Date" name="dueDate" type="date" value={dueDateValue} />
					</div>

					{#if data.task.status === 'waiting'}
						<div
							class="mb-4 rounded border border-[rgba(255,51,102,0.3)] bg-[rgba(255,51,102,0.05)] p-4"
						>
							<h3 class="mb-3 text-sm font-bold" style="color: var(--color-tron-red);">
								Waiting Details
							</h3>
							<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
								<div>
									<TronInput
										label="Waiting Reason"
										name="waitingReason"
										value={data.task.waitingReason ?? ''}
										placeholder="Why is this blocked?"
									/>
								</div>
								<div>
									<TronInput
										label="Waiting On"
										name="waitingOn"
										value={data.task.waitingOn ?? ''}
										placeholder="Person or thing..."
									/>
								</div>
							</div>
						</div>
					{:else}
						<input type="hidden" name="waitingReason" value={data.task.waitingReason ?? ''} />
						<input type="hidden" name="waitingOn" value={data.task.waitingOn ?? ''} />
					{/if}

					<div class="flex items-center justify-between">
						<TronButton type="submit" variant="primary" disabled={saving}>
							{saving ? 'Saving...' : 'Save Changes'}
						</TronButton>
					</div>
				</form>

				<!-- Archive -->
				<div class="mt-4 flex justify-end border-t border-[var(--color-tron-border)] pt-4">
					<form
						method="POST"
						action="?/archive"
						use:enhance={() => {
							archiving = true;
							return async ({ result, update }) => {
								archiving = false;
								if (result.type === 'success') {
									goto(backUrl);
								} else {
									await update();
								}
							};
						}}
					>
						<input type="hidden" name="taskId" value={data.task.id} />
						<TronButton type="submit" variant="danger" disabled={archiving}>
							{archiving ? 'Archiving...' : 'Archive Task'}
						</TronButton>
					</form>
				</div>
			</div>
		</div>

		<!-- Right column: metadata + tags + comments + activity -->
		<div class="space-y-6">
			<!-- KB2-33: Dependencies — the blocked_by edges here are exactly what the
			     roadmap scheduler walks; add one and the canvas moves on next load. -->
			<div class="tron-card">
				<h3 class="tron-text-primary mb-1 text-sm font-bold">Dependencies</h3>
				<p class="tron-text-muted mb-3 text-[11px]">Blocking edges drive the roadmap (KB2-28). Cycle-checked.</p>

				{#snippet linkRow(l: any)}
					<div class="flex items-start gap-2 py-1 text-sm">
						<span
							class="mt-1.5 h-2 w-2 shrink-0 rounded-full"
							style="background: {l.status === 'done' ? '#10b981' : '#f59e0b'};"
							title={l.status === 'done' ? 'done' : `still ${l.status ?? 'open'}`}
						></span>
						<div class="min-w-0 flex-1">
							<a href="/kanban/task/{l.taskId}" class="tron-text-primary hover:underline">
								{#if l.trackingNumber}<span class="font-mono text-xs tron-text-muted">{l.trackingNumber}</span>{/if}
								<span class="{l.status === 'done' ? 'line-through opacity-60' : ''}">{l.title}</span>
							</a>
							{#if l.note}<p class="tron-text-muted text-[11px]">{l.note}</p>{/if}
							{#if l.direction === 'derived'}
								<p class="tron-text-muted text-[10px] italic">declared on the other task — remove it there</p>
							{/if}
						</div>
						{#if l.direction === 'declared'}
							<form method="POST" action="?/removeLink" use:enhance>
								<input type="hidden" name="linkId" value={l.linkId} />
								<button type="submit" class="text-xs font-bold" style="color: var(--color-tron-red);" title="Remove link">✕</button>
							</form>
						{/if}
					</div>
				{/snippet}

				{#if data.links.length === 0}
					<p class="tron-text-muted mb-3 text-xs">No links yet.</p>
				{:else}
					{#if linkGroups.blocked_by.length}
						<p class="tron-label !mb-0.5">Blocked by</p>
						<div class="mb-2 divide-y divide-[var(--color-tron-border)]">
							{#each linkGroups.blocked_by as l (l.linkId + l.direction)}{@render linkRow(l)}{/each}
						</div>
					{/if}
					{#if linkGroups.blocks.length}
						<p class="tron-label !mb-0.5">Blocks</p>
						<div class="mb-2 divide-y divide-[var(--color-tron-border)]">
							{#each linkGroups.blocks as l (l.linkId + l.direction)}{@render linkRow(l)}{/each}
						</div>
					{/if}
					{#if linkGroups.relates_to.length}
						<p class="tron-label !mb-0.5">Related</p>
						<div class="mb-2 divide-y divide-[var(--color-tron-border)]">
							{#each linkGroups.relates_to as l (l.linkId + l.direction)}{@render linkRow(l)}{/each}
						</div>
					{/if}
				{/if}

				<!-- Add link -->
				<form method="POST" action="?/addLink" use:enhance class="mt-2 space-y-2 border-t border-[var(--color-tron-border)] pt-3">
					<div class="flex gap-2">
						<select name="linkType" class="tron-select w-[130px] shrink-0 text-xs" bind:value={linkType}>
							<option value="blocked_by">Blocked by</option>
							<option value="blocks">Blocks</option>
							<option value="relates_to">Related to</option>
						</select>
						<input
							name="target"
							class="tron-input min-w-0 flex-1 text-xs"
							placeholder="TASK-012 or task id"
							required
						/>
					</div>
					<div class="flex gap-2">
						<input name="note" class="tron-input min-w-0 flex-1 text-xs" placeholder="Note (optional)" />
						<TronButton type="submit">Add</TronButton>
					</div>
				</form>

				<!-- Structure: parent / subtasks / provenance (read-only; re-parent via MCP) -->
				{#if data.parentTask || data.subtasks.length || data.spawnedFromTask}
					<div class="mt-3 border-t border-[var(--color-tron-border)] pt-3">
						{#if data.parentTask}
							<p class="tron-label !mb-0.5">Parent</p>
							<a href="/kanban/task/{data.parentTask._id}" class="tron-text-primary block py-0.5 text-sm hover:underline">
								{#if data.parentTask.trackingNumber}<span class="font-mono text-xs tron-text-muted">{data.parentTask.trackingNumber}</span>{/if}
								{data.parentTask.title}
							</a>
						{/if}
						{#if data.subtasks.length}
							<p class="tron-label !mb-0.5 mt-1.5">Subtasks</p>
							{#each data.subtasks as st (st._id)}
								<div class="flex items-center gap-2 py-0.5 text-sm">
									<a href="/kanban/task/{st._id}" class="tron-text-primary min-w-0 flex-1 truncate hover:underline">
										{#if st.trackingNumber}<span class="font-mono text-xs tron-text-muted">{st.trackingNumber}</span>{/if}
										{st.title}
									</a>
									<TaskStatusBadge status={st.status} />
								</div>
							{/each}
						{/if}
						{#if data.spawnedFromTask}
							<p class="tron-label !mb-0.5 mt-1.5">Discovered while working</p>
							<a href="/kanban/task/{data.spawnedFromTask._id}" class="tron-text-primary block py-0.5 text-sm hover:underline">
								{#if data.spawnedFromTask.trackingNumber}<span class="font-mono text-xs tron-text-muted">{data.spawnedFromTask.trackingNumber}</span>{/if}
								{data.spawnedFromTask.title}
							</a>
						{/if}
					</div>
				{/if}
			</div>

			<!-- Task metadata -->
			<div class="tron-card">
				<h3 class="tron-text-primary mb-4 text-sm font-bold">Task Info</h3>
				<dl class="space-y-3 text-sm">
					<div class="flex justify-between">
						<dt class="tron-text-muted">Status</dt>
						<dd><TaskStatusBadge status={data.task.status} /></dd>
					</div>
					{#if data.task.sizeClass}
						<div class="flex justify-between">
							<dt class="tron-text-muted">Size</dt>
							<dd class="tron-text-primary">
								{sizeLabels[data.task.sizeClass] ?? data.task.sizeClass}
							</dd>
						</div>
					{/if}
					{#if data.task.assigneeName}
						<div class="flex justify-between">
							<dt class="tron-text-muted">Assigned To</dt>
							<dd style="color: var(--color-tron-cyan);">{data.task.assigneeName}</dd>
						</div>
					{/if}
					<div class="flex justify-between">
						<dt class="tron-text-muted">Created</dt>
						<dd class="tron-text-primary">{formatDate(data.task.createdAt)}</dd>
					</div>
					<div class="flex justify-between">
						<dt class="tron-text-muted">Updated</dt>
						<dd class="tron-text-primary">{formatDate(data.task.updatedAt)}</dd>
					</div>
					{#if data.task.statusChangedAt}
						<div class="flex justify-between">
							<dt class="tron-text-muted">Status Changed</dt>
							<dd class="tron-text-primary">{formatDate(data.task.statusChangedAt)}</dd>
						</div>
					{/if}
					{#if data.task.completedDate}
						<div class="flex justify-between">
							<dt class="tron-text-muted">Completed</dt>
							<dd style="color: var(--color-tron-green);">
								{formatDate(data.task.completedDate)}
							</dd>
						</div>
					{/if}
				</dl>
			</div>

			<!-- Tags -->
			<div class="tron-card">
				<h3 class="tron-text-primary mb-3 text-sm font-bold">Tags</h3>
				<TagPicker allTags={data.allTags} {selectedTagIds} taskId={data.task.id} />
			</div>

			<!-- Comments -->
			<div class="tron-card">
				<h3 class="tron-text-primary mb-4 text-sm font-bold">
					Comments ({data.comments.length})
				</h3>
				<CommentList comments={data.comments} taskId={data.task.id} />
			</div>

			<!-- Spike info (KB2-07) -->
			{#if data.task.spike}
				<div class="tron-card">
					<h3 class="tron-text-primary mb-3 text-sm font-bold">Investigation</h3>
					<p class="tron-text-primary text-sm">{data.task.spike.question}</p>
					{#if data.task.spike.timebox}
						<p class="tron-text-muted mt-1 text-xs">
							Timebox: {data.task.spike.timebox.amount} {data.task.spike.timebox.unit}
							— done when it expires, answered or not.
						</p>
					{/if}
					{#if data.task.spike.outcome}
						<p class="mt-2 text-sm" style="color: var(--color-tron-green);">Outcome: {data.task.spike.outcome}</p>
					{/if}
				</div>
			{/if}

			<!-- Activity Log -->
			<div class="tron-card">
				<h3 class="tron-text-primary mb-4 text-sm font-bold">Activity</h3>
				<ActivityLog entries={data.activityLog} />
			</div>
		</div>
	</div>
</div>

<!-- KB2-07: create-from-task, led by the stop-now test -->
{#if relatedStep}
	<KanbanModal title="Related work discovered" onclose={() => (relatedStep = null)} maxWidth="max-w-xl">
		{#if relatedStep === 'ask'}
			<p class="tron-text-primary mb-4 text-base font-bold">
				If I stopped right now, is this task's stated outcome achieved?
			</p>
			<div class="space-y-3">
				<button
					type="button"
					class="tron-card block w-full !p-4 text-left transition-colors hover:border-[var(--color-tron-cyan)]"
					onclick={() => (relatedStep = 'option')}
				>
					<span class="font-bold" style="color: var(--color-tron-cyan);">Yes — new option</span>
					<span class="tron-text-muted mt-1 block text-xs">
						The new work is outside this task's boundary. It becomes a captured, discovered option in
						inventory and goes through replenishment like everything else — never straight to ready.
					</span>
				</button>
				<button
					type="button"
					class="tron-card block w-full !p-4 text-left transition-colors hover:border-[var(--color-tron-cyan)]"
					onclick={() => (relatedStep = 'context')}
				>
					<span class="tron-text-primary font-bold">No — part of this task</span>
					<span class="tron-text-muted mt-1 block text-xs">
						It was always inside this task's boundary. Append it as context here — no new item is created.
					</span>
				</button>
			</div>
		{:else if relatedStep === 'option'}
			<form method="POST" action="?/discoverOption" use:enhance={modalEnhance}>
				<p class="tron-text-muted mb-4 text-sm">
					New option — created as <span class="font-bold">captured</span> / origin
					<span class="font-bold">discovered</span>, spawned from this task, same tags.
				</p>
				<div class="mb-4">
					<TronInput label="Title" name="title" required placeholder="One line is enough" />
				</div>
				<div class="mb-4">
					<label for="disc-desc" class="tron-label">Description (optional)</label>
					<textarea id="disc-desc" name="description" class="tron-input w-full" rows="3"></textarea>
				</div>
				<div class="flex justify-end gap-3">
					<TronButton onclick={() => (relatedStep = 'ask')}>Back</TronButton>
					<TronButton type="submit" variant="primary" disabled={modalSubmitting}>Capture Option</TronButton>
				</div>
			</form>
		{:else}
			<form method="POST" action="?/appendContext" use:enhance={modalEnhance}>
				<p class="tron-text-muted mb-4 text-sm">Appended to this task's description as context.</p>
				<div class="mb-4">
					<label for="ctx-text" class="tron-label">What did you find?</label>
					<textarea id="ctx-text" name="text" class="tron-input w-full" rows="4" required></textarea>
				</div>
				<div class="flex justify-end gap-3">
					<TronButton onclick={() => (relatedStep = 'ask')}>Back</TronButton>
					<TronButton type="submit" variant="primary" disabled={modalSubmitting}>Append to Task</TronButton>
				</div>
			</form>
		{/if}
	</KanbanModal>
{/if}

<!-- KB2-07: close spike -->
{#if showSpikeClose}
	<KanbanModal title="Close investigation" onclose={() => (showSpikeClose = false)} maxWidth="max-w-xl">
		<form method="POST" action="?/closeSpike" use:enhance={modalEnhance}>
			<p class="tron-text-muted mb-4 text-sm">
				An investigation is done when the timebox expires — "we spent the time and still don't know" is a
				valid, recorded outcome, never a failure. Its output is options, not tasks.
			</p>
			<div class="mb-4">
				<label for="spike-outcome" class="tron-label">Outcome (required — including "still unknown")</label>
				<textarea id="spike-outcome" name="outcome" class="tron-input w-full" rows="3" required></textarea>
			</div>
			<div class="mb-4">
				<span class="tron-label">What options does this create?</span>
				<div class="space-y-2">
					{#each spikeOptionTitles as _, i}
						<input
							name="optionTitle"
							class="tron-input w-full"
							placeholder="Option title (filed as captured / discovered)"
							bind:value={spikeOptionTitles[i]}
						/>
					{/each}
				</div>
				<button
					type="button"
					class="mt-2 text-xs hover:underline"
					style="color: var(--color-tron-cyan);"
					onclick={() => (spikeOptionTitles = [...spikeOptionTitles, ''])}
				>
					+ another option
				</button>
			</div>
			<div class="flex justify-end gap-3">
				<TronButton onclick={() => (showSpikeClose = false)}>Cancel</TronButton>
				<TronButton type="submit" variant="primary" disabled={modalSubmitting}>Close investigation</TronButton>
			</div>
		</form>
	</KanbanModal>
{/if}

<!-- Unified Process modal (KB2-03 process / KB2-12 reshape — mirrors /kanban/inventory).
     Replaces the old dead header "Ready" button: commitment still goes through
     replenishment; PROCESSING is the real next step for a captured option. -->
{#if showProcess}
	<KanbanModal title="{data.task.status === 'captured' ? 'Process' : 'Reshape'}: {data.task.title}" onclose={() => (showProcess = false)} maxWidth="max-w-xl">
		<p class="tron-text-muted mb-3 text-sm">
			{#if data.task.status === 'captured'}
				Processing shapes a captured option into a real candidate: sized and classed by the person
				processing — not the author, not the eventual assignee. Commitment to the Board still happens
				at replenishment on Tier 1.
			{:else}
				Reshaping edits size, class, estimate, and DoR in place — audited, no status change.
			{/if}
		</p>
		<div class="mb-4 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-3 py-2">
			<p class="tron-text-primary text-xs font-bold uppercase tracking-wide">The sizing decision test</p>
			<p class="tron-text-muted mt-1 text-xs">{data.sizingDecisionTest}</p>
		</div>
		<form
			method="POST"
			action={data.task.status === 'captured' ? '?/process' : '?/reshape'}
			use:enhance={() => {
				return async ({ result, update }) => {
					await update({ reset: false });
					if (result.type === 'success') showProcess = false;
				};
			}}
		>
			<fieldset class="mb-4">
				<legend class="tron-label">Size class</legend>
				<div class="space-y-2">
					{#each SIZE_CLASSES as sc (sc)}
						<label class="flex items-start gap-2 text-sm">
							<input type="radio" name="sizeClass" value={sc} required class="mt-1" checked={data.task.sizeClass === sc} />
							<span>
								<span class="tron-text-primary font-bold capitalize">{sc}</span>
								{#if (data.sizeClassDefinitions as Record<string, string>)[sc]}
									<span class="tron-text-muted block text-xs">{(data.sizeClassDefinitions as Record<string, string>)[sc]}</span>
								{/if}
							</span>
						</label>
					{/each}
				</div>
			</fieldset>

			<div class="mb-4">
				<label for="tp-cos" class="tron-label">Class of service</label>
				<select id="tp-cos" name="classOfService" class="tron-select w-full" required bind:value={processCos}>
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
						value={data.task.dueDate ? String(data.task.dueDate).slice(0, 10) : ''}
						required
					/>
				</div>
			{/if}

			<div class="mb-4">
				<label for="tp-estimate" class="tron-label">Estimate (working days — optional, KB2-27)</label>
				<input
					id="tp-estimate"
					name="estimateDays"
					type="number"
					min="0.5"
					step="0.5"
					class="tron-input w-full"
					value={data.task.estimateDays ?? ''}
					placeholder="Feeds the roadmap scheduler; falls back to size class if empty"
				/>
			</div>

			<div class="mb-4">
				<label for="tp-deliverable" class="tron-label">Deliverable (DoR)</label>
				<textarea id="tp-deliverable" name="deliverable" class="tron-input w-full" rows="3">{data.task.dor.deliverable}</textarea>
				<p class="tron-text-muted mt-1 text-xs">
					State what will exist or be true when this is done — and how you'd verify it. Outcome, not steps.
				</p>
			</div>
			{#if isSoftware}
				<div class="mb-4">
					<label for="tp-brief" class="tron-label">Agent handoff brief (software DoR)</label>
					<textarea id="tp-brief" name="handoffBrief" class="tron-input w-full" rows="3">{data.task.dor.handoffBrief}</textarea>
				</div>
			{/if}

			<div class="flex justify-end gap-3">
				<TronButton onclick={() => (showProcess = false)}>Cancel</TronButton>
				<TronButton type="submit" variant="primary">
					{data.task.status === 'captured' ? 'Mark Processed' : 'Save Changes'}
				</TronButton>
			</div>
		</form>
	</KanbanModal>
{/if}
