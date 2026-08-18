<script lang="ts">
	import { enhance } from '$app/forms';
	import TronButton from '$lib/components/ui/TronButton.svelte';
	import TronInput from '$lib/components/ui/TronInput.svelte';
	import KanbanModal from '$lib/components/kanban/KanbanModal.svelte';
	import TaskStatusBadge from '$lib/components/kanban/TaskStatusBadge.svelte';
	import { SIZE_CLASSES, CLASSES_OF_SERVICE } from '$lib/shared/kanban-status';
	import { tagColor } from '$lib/shared/tag-color';

	let { data, form } = $props();

	type TaskRow = (typeof data.tasks)[number];

	let errorMsg = $state('');
	let successMsg = $state('');
	let submitting = $state(false);
	let modal = $state<null | { kind: 'process' | 'decline'; task: TaskRow }>(null);
	let processCos = $state('standard');

	// KB2-25 — tag autocomplete. The field stays a plain comma-separated string
	// (the server action still parses it, and still canonicalises); this only
	// steers typing toward tags that already exist so we stop minting variants
	// like "Firmware" / "firmware" / "firmware ".
	let tagsInput = $state('');
	let tagsFocused = $state(false);
	let tagHighlight = $state(0);

	// Everything before the fragment being typed, and the fragment itself.
	let tagPrefix = $derived(tagsInput.slice(0, tagsInput.lastIndexOf(',') + 1));
	let tagFragment = $derived(tagsInput.slice(tagsInput.lastIndexOf(',') + 1).trim());
	let tagsChosen = $derived(
		new Set(
			tagPrefix
				.split(',')
				.map((s) => s.trim().toLowerCase())
				.filter(Boolean)
		)
	);
	let tagSuggestions = $derived(
		(() => {
			const frag = tagFragment.toLowerCase();
			const pool = (data.tagVocabulary ?? []).filter((t: string) => !tagsChosen.has(t.toLowerCase()));
			if (!frag) return pool.slice(0, 8);
			// Prefix matches first — they're what the typist most likely means.
			const starts = pool.filter((t: string) => t.toLowerCase().startsWith(frag));
			const contains = pool.filter(
				(t: string) => !t.toLowerCase().startsWith(frag) && t.toLowerCase().includes(frag)
			);
			return [...starts, ...contains].slice(0, 8);
		})()
	);
	// An exact hit needs no suggestion list — the tag is already canonical.
	let showTagMenu = $derived(
		tagsFocused &&
			tagSuggestions.length > 0 &&
			!(tagSuggestions.length === 1 && tagSuggestions[0].toLowerCase() === tagFragment.toLowerCase())
	);

	function applyTag(tag: string) {
		tagsInput = tagPrefix + (tagPrefix ? ' ' : '') + tag + ', ';
		tagHighlight = 0;
	}
	function onTagKeydown(e: KeyboardEvent) {
		if (!showTagMenu) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			tagHighlight = (tagHighlight + 1) % tagSuggestions.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			tagHighlight = (tagHighlight - 1 + tagSuggestions.length) % tagSuggestions.length;
		} else if (e.key === 'Tab' || (e.key === 'Enter' && tagFragment)) {
			// Enter only completes while a fragment is in flight, so a finished
			// tag list still submits the form on the first Enter.
			e.preventDefault();
			applyTag(tagSuggestions[Math.min(tagHighlight, tagSuggestions.length - 1)]);
		} else if (e.key === 'Escape') {
			tagsFocused = false;
		}
	}

	// KB2-14 — the commitment ceremony: staged taskIds in commit order.
	let staged = $state<string[]>([]);
	let commitNote = $state('');
	let commitResult = $derived((form as any)?.replenishResult ?? null);
	let taskById = $derived(new Map<string, TaskRow>(data.tasks.map((t: TaskRow) => [t.id, t] as [string, TaskRow])));

	// Only processed + DoR-complete rows are checkable; the gate re-checks server-side.
	function stageable(t: TaskRow): boolean {
		return t.status === 'processed' && t.dorMissing.length === 0;
	}
	function stageBlockedReason(t: TaskRow): string {
		if (t.status === 'captured') return "Still 'captured' — process it first";
		return 'DoR incomplete:\n' + t.dorMissing.join('\n');
	}
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

	// Commit gets its own enhance: on success the staging is spent.
	function commitEnhance() {
		submitting = true;
		return async ({ result, update }: { result: any; update: (opts?: any) => Promise<void> }) => {
			submitting = false;
			if (result.type === 'failure') {
				errorMsg = result.data?.error ?? 'Commit failed';
			} else if (result.type === 'success') {
				errorMsg = '';
				staged = [];
				commitNote = '';
			}
			await update({ reset: false });
		};
	}

	// KB2-11 — capture-from-template picker state.
	let selectedTemplateId = $state('');
	let selectedTemplate = $derived(
		data.templates.find((t: { id: string }) => t.id === selectedTemplateId) ?? null
	);

	// Filters — captured|processed default on; icebox/declined behind toggles.
	let showCaptured = $state(true);
	let showProcessed = $state(true);
	let showIcebox = $state(false);
	let showDeclined = $state(false);
	let itemTypeFilter = $state('all');
	let originFilter = $state('all');
	// KB2-16 — tag filter (match-any). Empty selection = no tag filtering.
	let tagFilter = $state<string[]>([]);
	let allTags = $derived.by(() => {
		const set = new Set<string>();
		for (const t of data.tasks as TaskRow[]) for (const tag of t.tags ?? []) set.add(tag);
		return [...set].sort((a, b) => a.localeCompare(b));
	});
	function toggleTagFilter(tag: string) {
		tagFilter = tagFilter.includes(tag) ? tagFilter.filter((t) => t !== tag) : [...tagFilter, tag];
	}

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
			if (tagFilter.length && !tagFilter.some((tag) => (t.tags ?? []).includes(tag))) return false;
			return true;
		})
	);

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
					// KB2-25 — update() resets the form, but a bound value would just
					// repaint itself back into the field. Clear the state too.
					tagsInput = '';
					tagsFocused = false;
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
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h2 class="tron-text-primary text-2xl font-bold">Tier 1</h2>
			<p class="tron-text-muted text-sm">
				The unbounded inventory of options — every option we know about, one flat list,
				globally ranked. Nothing here is committed.
			</p>
		</div>
		<!-- KB2-14: queue depth where the commitment decision is made -->
		<span
			class="rounded-full border px-3 py-1 text-xs font-bold"
			style={data.ready.belowMinOrderPoint
				? 'border-color: rgba(255,51,102,0.5); background: rgba(255,51,102,0.12); color: var(--color-tron-red);'
				: 'border-color: var(--color-tron-border); background: var(--color-tron-bg-tertiary); color: var(--color-tron-text-secondary);'}
			title={data.ready.belowMinOrderPoint
				? `Ready queue below the minimum order point (${data.ready.minOrderPoint}) — replenish now`
				: 'Ready queue depth vs cap'}
		>
			Ready {data.ready.count}/{data.ready.cap}
		</span>
	</div>

	<!-- Capture box: one line is enough -->
	<form method="POST" action="?/capture" class="flex flex-wrap items-center gap-2" use:enhance={submitEnhance}>
		<div class="min-w-[240px] flex-1">
			<TronInput name="title" placeholder="Capture an option — one line is enough" required />
		</div>
		<!-- KB2-25: tag field with match-as-you-type against the existing vocabulary -->
		<div class="relative min-w-[180px]">
			<input
				name="tags"
				class="tron-input w-full"
				placeholder="Tags (comma-separated, optional)"
				title="Tags — matches existing tags as you type"
				autocomplete="off"
				bind:value={tagsInput}
				onfocus={() => (tagsFocused = true)}
				onblur={() => setTimeout(() => (tagsFocused = false), 120)}
				onkeydown={onTagKeydown}
			/>
			{#if showTagMenu}
				<div
					class="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded border"
					style="border-color: var(--color-tron-border); background: var(--color-tron-bg-secondary);"
				>
					{#each tagSuggestions as tag, i (tag)}
						<button
							type="button"
							class="flex w-full items-center gap-2 px-2 py-1 text-left text-xs"
							style={i === tagHighlight
								? 'background: var(--color-tron-bg-tertiary); color: var(--color-tron-cyan);'
								: 'color: var(--color-tron-text-secondary);'}
							onmouseenter={() => (tagHighlight = i)}
							onclick={() => applyTag(tag)}
						>
							<span class="h-2 w-2 shrink-0 rounded-full" style="background: {tagColor(tag)};"></span>
							{tag}
						</button>
					{/each}
				</div>
			{/if}
		</div>
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

	<!-- KB2-14: commit result — promoted with ranks, rejected with the service's reasons -->
	{#if commitResult}
		<div class="tron-card space-y-3 !p-4">
			<h3 class="tron-text-primary text-sm font-bold">
				Replenishment result — {commitResult.promoted.length} promoted, {commitResult.rejected.length} rejected
				<span class="tron-text-muted font-normal">(ready {commitResult.readyCount}/{commitResult.readyCap})</span>
			</h3>
			{#if commitResult.promoted.length}
				<ul class="space-y-1">
					{#each commitResult.promoted as p (p.taskId)}
						<li class="text-sm" style="color: var(--color-tron-green, #10b981);">
							#{p.rank} — <a href="/kanban/task/{p.taskId}" class="hover:underline">{p.title}</a>
						</li>
					{/each}
				</ul>
			{/if}
			{#if commitResult.rejected.length}
				<ul class="space-y-1">
					{#each commitResult.rejected as r (r.taskId)}
						<li class="text-sm" style="color: var(--color-tron-red);">
							{r.title ?? r.taskId}: {r.reason}
						</li>
					{/each}
				</ul>
			{/if}
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

	<!-- KB2-16 — tag filter (match-any) -->
	{#if allTags.length > 0}
		<div class="flex flex-wrap items-center gap-1.5 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-4 py-2.5">
			<span class="tron-text-muted mr-1 text-xs uppercase tracking-wide">Tags</span>
			{#each allTags as tag (tag)}
				{@const active = tagFilter.includes(tag)}
				<button
					type="button"
					class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors"
					style={active
						? `border-color: ${tagColor(tag)}; background: ${tagColor(tag)}20; color: ${tagColor(tag)};`
						: 'border-color: var(--color-tron-border); color: var(--color-tron-text-secondary);'}
					onclick={() => toggleTagFilter(tag)}
				>
					<span class="h-2 w-2 rounded-full" style="background: {tagColor(tag)};"></span>
					{tag}
				</button>
			{/each}
			{#if tagFilter.length}
				<button type="button" class="tron-text-muted ml-1 text-xs hover:underline" onclick={() => (tagFilter = [])}>clear</button>
			{/if}
		</div>
	{/if}

	<!-- KB2-16 — one flat iterable list, global rank order -->
	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
		<div class="divide-y divide-[var(--color-tron-border)]">
			{#each filtered as t (t.id)}
					<div class="flex flex-wrap items-center gap-3 px-4 py-2.5 {staged.includes(t.id) ? 'bg-[rgba(0,212,255,0.06)]' : ''}">
						{#if data.canReplenish}
							<!-- KB2-14 staging checkbox: processed + DoR-complete only -->
							{#if t.status === 'captured' || t.status === 'processed'}
								<input
									type="checkbox"
									class="shrink-0"
									checked={staged.includes(t.id)}
									disabled={!stageable(t)}
									onchange={() => toggleStaged(t.id)}
									title={stageable(t) ? 'Stage for commitment' : stageBlockedReason(t)}
									aria-label="Stage for commitment"
								/>
							{:else}
								<span class="w-[13px] shrink-0"></span>
							{/if}
						{/if}
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
								{#each t.tags ?? [] as tag (tag)}
									<span class="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px]" style="background: {tagColor(tag)}18; color: {tagColor(tag)};">
										<span class="h-1.5 w-1.5 rounded-full" style="background: {tagColor(tag)};"></span>
										{tag}
									</span>
								{/each}
							</div>
							{#if t.status === 'declined' && t.declineReason}
								<p class="mt-0.5 text-xs" style="color: var(--color-tron-red);">Declined: {t.declineReason}</p>
							{/if}
						</div>

						<!-- Controls -->
						<div class="flex shrink-0 flex-wrap items-center gap-1.5">
							{#if t.status === 'captured' || t.status === 'processed'}
								<form method="POST" action="?/rankMove" use:enhance={submitEnhance} class="flex items-center">
									<input type="hidden" name="taskId" value={t.id} />
									<button type="submit" name="direction" value="up" class="tron-button !px-2 !py-1 text-xs" title="Rank up" disabled={submitting}>▲</button>
								</form>
								<form method="POST" action="?/rankMove" use:enhance={submitEnhance} class="flex items-center">
									<input type="hidden" name="taskId" value={t.id} />
									<button type="submit" name="direction" value="down" class="tron-button !px-2 !py-1 text-xs" title="Rank down" disabled={submitting}>▼</button>
								</form>
								<TronButton variant="primary" onclick={() => openProcess(t)}>Process</TronButton>
								<form method="POST" action="?/icebox" use:enhance={submitEnhance}>
									<input type="hidden" name="taskId" value={t.id} />
									<TronButton type="submit" disabled={submitting}>Icebox</TronButton>
								</form>
								<TronButton variant="danger" onclick={() => (modal = { kind: 'decline', task: t })}>Decline</TronButton>
							{:else if t.status === 'icebox'}
								<form method="POST" action="?/thaw" use:enhance={submitEnhance}>
									<input type="hidden" name="taskId" value={t.id} />
									<TronButton type="submit" disabled={submitting}>Thaw</TronButton>
								</form>
								<TronButton variant="danger" onclick={() => (modal = { kind: 'decline', task: t })}>Decline</TronButton>
							{/if}
						</div>
					</div>
			{/each}
			{#if filtered.length === 0}
				<p class="tron-text-muted px-4 py-3 text-xs">No Tier 1 options match the current filters.</p>
			{/if}
		</div>
	</section>

	<!-- KB2-14: the commit bar — the ceremony itself. Sticks to the viewport
	     bottom while anything is staged; hidden entirely without the permission. -->
	{#if data.canReplenish && staged.length > 0}
		<div
			class="sticky bottom-2 z-30 rounded-lg border bg-[var(--color-tron-bg-secondary)] p-4"
			style="border-color: var(--color-tron-cyan); box-shadow: 0 0 14px rgba(0,212,255,0.25);"
		>
			<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
				<span class="tron-text-primary text-sm font-bold">
					{staged.length} selected
					<span class="tron-text-muted font-normal"> · Ready {data.ready.count}/{data.ready.cap}</span>
				</span>
				<span class="tron-text-muted text-xs">Order below = the order they join the queue</span>
			</div>
			<ol class="mb-3 space-y-1.5">
				{#each staged as id, i (id)}
					{@const t = taskById.get(id)}
					<li class="flex items-center gap-2">
						<span class="tron-text-muted w-5 text-right text-xs font-bold">{i + 1}</span>
						<span class="tron-text-primary flex-1 truncate text-sm">{t?.title ?? id}</span>
						<button type="button" class="tron-button !px-2 !py-0.5 text-xs" onclick={() => moveStaged(id, -1)} disabled={i === 0} title="Move up">▲</button>
						<button type="button" class="tron-button !px-2 !py-0.5 text-xs" onclick={() => moveStaged(id, 1)} disabled={i === staged.length - 1} title="Move down">▼</button>
						<button type="button" class="text-xs font-bold" style="color: var(--color-tron-red);" onclick={() => toggleStaged(id)} title="Remove">✕</button>
					</li>
				{/each}
			</ol>
			<form method="POST" action="?/commit" class="flex flex-wrap items-center gap-2" use:enhance={commitEnhance}>
				{#each staged as id (id)}
					<input type="hidden" name="taskIds" value={id} />
				{/each}
				<input
					name="note"
					class="tron-input min-w-[220px] flex-1"
					placeholder="Note (optional — recorded on the event)"
					bind:value={commitNote}
				/>
				<TronButton type="submit" variant="primary" disabled={submitting}>
					{submitting ? 'Committing…' : `Commit ${staged.length} item${staged.length === 1 ? '' : 's'}`}
				</TronButton>
			</form>
		</div>
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
			{#if (modal.task.tags ?? []).includes('software')}
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
