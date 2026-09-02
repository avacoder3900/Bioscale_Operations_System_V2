<script lang="ts">
	import { enhance, deserialize } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import TronButton from '$lib/components/ui/TronButton.svelte';
	import TronInput from '$lib/components/ui/TronInput.svelte';
	import KanbanModal from '$lib/components/kanban/KanbanModal.svelte';
	import TaskStatusBadge from '$lib/components/kanban/TaskStatusBadge.svelte';
	import { SIZE_CLASSES, CLASSES_OF_SERVICE } from '$lib/shared/kanban-status';
	import { tagColor } from '$lib/shared/tag-color';
	import { page } from '$app/stores';
	import { get } from 'svelte/store';

	let { data, form } = $props();

	type TaskRow = (typeof data.tasks)[number];

	let errorMsg = $state('');
	let successMsg = $state('');
	let submitting = $state(false);
	let modal = $state<null | { kind: 'process' | 'decline'; task: TaskRow }>(null);
	// KB2-26 rank jump: which task's rank number is being edited, and the typed value.
	let rankEdit = $state<null | { id: string; value: string }>(null);
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

	// One-click commit — replaces the KB2-14 staging checkbox + sticky commit
	// bar. The button is only enabled on processed + DoR-complete rows; the
	// replenish() gate re-checks everything server-side either way.
	let commitResult = $derived((form as any)?.replenishResult ?? null);

	function committable(t: TaskRow): boolean {
		return t.status === 'processed' && t.dorMissing.length === 0;
	}
	function commitBlockedReason(t: TaskRow): string {
		if (t.status === 'captured') return "Still 'captured' — process it first";
		return 'DoR incomplete:\n' + t.dorMissing.join('\n');
	}

	// Commit keeps its own enhance: replenishResult arrives via `form`, and the
	// list should repaint without resetting other in-flight inputs.
	function commitEnhance() {
		submitting = true;
		return async ({ result, update }: { result: any; update: (opts?: any) => Promise<void> }) => {
			submitting = false;
			if (result.type === 'failure') {
				errorMsg = result.data?.error ?? 'Commit failed';
			} else if (result.type === 'success') {
				errorMsg = '';
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

	// KB2-39 — chains as a lens on Tier 1. `viewMode` groups the list by
	// primary chain (dependency order inside each group; rank untouched);
	// `chainFilter` narrows to one chain ('__unwired__' = not in any chain).
	// URL: ?chain=<id>&view=chain[&process=1] — the roadmap band label and
	// the task page link here; process=1 starts the Process-chain walk.
	type ChainSummary = (typeof data.chains)[number];
	const initialParams = get(page).url.searchParams;
	let viewMode = $state<'rank' | 'chain'>(initialParams.get('view') === 'chain' ? 'chain' : 'rank');
	let chainFilter = $state<string | null>(initialParams.get('chain'));
	const chainById = $derived(new Map<string, ChainSummary>(data.chains.map((c: ChainSummary) => [c.id, c])));
	// Chains that actually have Tier 1 rows on this page (chips + groups).
	const chainsHere = $derived.by(() => {
		const present = new Set<string>();
		for (const t of data.tasks as TaskRow[]) if (t.chain) present.add(t.chain.chainId);
		return (data.chains as ChainSummary[]).filter((c) => present.has(c.id));
	});
	const unwiredCount = $derived((data.tasks as TaskRow[]).filter((t) => !t.chain).length);
	function toggleChainFilter(id: string) {
		chainFilter = chainFilter === id ? null : id;
	}
	const fmtDue = (iso: string | null) =>
		iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';

	// Process-chain walk: open the Process modal on each captured task of a
	// chain in dependency order, advancing on every successful save.
	let walkQueue = $state<string[]>([]);
	let walkTotal = $state(0);
	function startChainWalk(chainId: string) {
		const c = chainById.get(chainId);
		if (!c) return;
		const captured = new Set((data.tasks as TaskRow[]).filter((t) => t.status === 'captured').map((t) => t.id));
		const queue = c.order.filter((id: string) => captured.has(id));
		if (!queue.length) return;
		walkTotal = queue.length;
		walkQueue = queue.slice(1);
		const first = (data.tasks as TaskRow[]).find((t) => t.id === queue[0]);
		if (first) openProcess(first);
	}
	function cancelChainWalk() {
		walkQueue = [];
		walkTotal = 0;
	}
	$effect(() => {
		// Auto-start the walk when arriving via ?process=1 (once).
		if (initialParams.get('process') === '1' && chainFilter && walkTotal === 0 && !modal) {
			startChainWalk(chainFilter);
		}
	});
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
			// KB2-39 — chain filter (primary chain, or unwired).
			if (chainFilter === '__unwired__' && t.chain) return false;
			if (chainFilter && chainFilter !== '__unwired__' && t.chain?.chainId !== chainFilter) return false;
			return true;
		})
	);

	// KB2-39 — what the list renders: one flat group in rank view; in chain
	// view, one group per chain (dependency order) then the unwired rest.
	type RowGroup = { key: string; chain: ChainSummary | null; tasks: TaskRow[] };
	const rowGroups = $derived.by((): RowGroup[] => {
		if (viewMode !== 'chain') return [{ key: 'all', chain: null, tasks: filtered }];
		const groups: RowGroup[] = [];
		const byChain = new Map<string, TaskRow[]>();
		const unwired: TaskRow[] = [];
		for (const t of filtered as TaskRow[]) {
			if (!t.chain) { unwired.push(t); continue; }
			(byChain.get(t.chain.chainId) ?? byChain.set(t.chain.chainId, []).get(t.chain.chainId)!).push(t);
		}
		for (const c of data.chains as ChainSummary[]) {
			const tasks = byChain.get(c.id);
			if (!tasks?.length) continue;
			tasks.sort((a, b) => (a.chain?.position ?? 0) - (b.chain?.position ?? 0));
			groups.push({ key: c.id, chain: c, tasks });
		}
		if (unwired.length) groups.push({ key: '__unwired__', chain: null, tasks: unwired });
		return groups;
	});

	// ---- Copy the visible list (plain text, one task per line) ----
	// Copies exactly what the filters are showing, in the order shown (rank asc)
	// — the point is to paste the current slice somewhere else, so a copy that
	// ignored the filters would be the wrong list.
	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	const taskLine = (t: TaskRow) =>
		[
			String(t.rank ?? 0),
			t.title,
			`[${t.status}/${t.itemType}]`,
			(t.tags ?? []).join(', ')
		]
			.filter((part) => part !== '')
			.join('  ');

	const copyText = $derived(filtered.map(taskLine).join('\n'));

	async function copyList() {
		if (!filtered.length) return;
		try {
			await navigator.clipboard.writeText(copyText);
		} catch {
			// Clipboard API needs a secure context + permission; fall back to a
			// throwaway textarea so this still works where it isn't granted.
			const ta = document.createElement('textarea');
			ta.value = copyText;
			ta.setAttribute('readonly', '');
			ta.style.position = 'fixed';
			ta.style.opacity = '0';
			document.body.appendChild(ta);
			ta.select();
			try {
				document.execCommand('copy');
			} catch {
				errorMsg = 'Could not copy to the clipboard';
				document.body.removeChild(ta);
				return;
			}
			document.body.removeChild(ta);
		}
		copied = true;
		clearTimeout(copyTimer);
		copyTimer = setTimeout(() => (copied = false), 2000);
	}

	// KB2-26 rank jump: POST ?/rankSet with the typed target position. Blur and
	// Enter both land here; rankEdit is nulled first so the double-fire (Enter
	// triggers blur) is a no-op the second time.
	async function submitRankSet() {
		if (!rankEdit) return;
		const { id, value } = rankEdit;
		rankEdit = null;
		const n = parseInt(value, 10);
		if (!Number.isFinite(n)) return;
		submitting = true;
		try {
			const body = new FormData();
			body.set('taskId', id);
			body.set('rank', String(n));
			const res = await fetch('?/rankSet', { method: 'POST', body });
			const result = deserialize(await res.text());
			if (result.type === 'failure') {
				errorMsg = (result.data as any)?.error ?? 'Rank change failed';
			} else {
				errorMsg = '';
				await invalidateAll();
			}
		} catch {
			errorMsg = 'Rank change failed';
		} finally {
			submitting = false;
		}
	}

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
					// KB2-39 — Process-chain walk: advance to the next captured task.
					if (walkQueue.length) {
						const nextId = walkQueue[0];
						walkQueue = walkQueue.slice(1);
						const next = (data.tasks as TaskRow[]).find((x) => x.id === nextId);
						if (next) openProcess(next);
					} else if (walkTotal) {
						walkTotal = 0;
					}
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
		<!-- KB2-38: optional slot in the Tier 1 order; blank = bottom -->
		<input
			name="position"
			type="number"
			min="1"
			step="1"
			class="tron-input"
			style="width: 84px; flex: 0 0 auto;"
			placeholder="#"
			title="Position in Tier 1 (1 = top). Blank = bottom (#{data.tasks.filter((t: TaskRow) => t.status === 'captured' || t.status === 'processed').length + 1})"
			autocomplete="off"
		/>
		<TronButton type="submit" variant="primary" disabled={submitting}>Capture</TronButton>
		<!-- KB2-38: detailed capture — the whole item, and where it lands -->
		<a
			href="/kanban/capture"
			class="rounded border px-3 py-2 text-sm font-medium hover:underline"
			style="border-color: var(--color-tron-border); color: var(--color-tron-cyan);"
			title="Fill out everything: deliverable, size, class, tags, estimate — and capture it processed or straight to the Board"
		>
			Detailed…
		</a>
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
			<option value="spike">Investigation</option>
			<option value="chore">Chore</option>
		</select>
		<select bind:value={originFilter} class="tron-select">
			<option value="all">All origins</option>
			<option value="planned">Planned</option>
			<option value="discovered">Discovered</option>
		</select>
		<!-- KB2-39 — view toggle: rank (global importance) vs chain (structure). A lens, never a re-rank. -->
		<div class="flex items-center overflow-hidden rounded border border-[var(--color-tron-border)] text-xs" role="group" aria-label="List view">
			<button type="button" class="px-2.5 py-1 {viewMode === 'rank' ? 'bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-cyan)]' : 'tron-text-muted'}" onclick={() => (viewMode = 'rank')} title="One flat list in global rank order">By rank</button>
			<button type="button" class="border-l border-[var(--color-tron-border)] px-2.5 py-1 {viewMode === 'chain' ? 'bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-cyan)]' : 'tron-text-muted'}" onclick={() => (viewMode = 'chain')} title="Grouped by milestone chain, in dependency order">By chain</button>
		</div>
		<span class="tron-text-muted ml-auto text-xs">{filtered.length} option{filtered.length === 1 ? '' : 's'}</span>
		<button
			type="button"
			onclick={copyList}
			disabled={!filtered.length}
			class="rounded border border-[var(--color-tron-border)] px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 {copied
				? 'border-emerald-500/60 text-emerald-300'
				: 'tron-text-muted hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]'}"
			title="Copy the {filtered.length} listed task{filtered.length === 1 ? '' : 's'} as plain text, one per line"
		>
			{copied ? '✓ Copied' : '⧉ Copy list'}
		</button>
	</div>

	<!-- KB2-39 — chain chips: one chain at a time, plus the unwired inbox -->
	{#if chainsHere.length > 0 || unwiredCount > 0}
		<div class="flex flex-wrap items-center gap-1.5 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-4 py-2.5">
			<span class="tron-text-muted mr-1 text-xs uppercase tracking-wide">Chains</span>
			{#each chainsHere as c (c.id)}
				{@const active = chainFilter === c.id}
				<button
					type="button"
					class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors"
					style={active
						? 'border-color: var(--color-tron-cyan); background: rgba(0,212,255,0.12); color: var(--color-tron-cyan);'
						: 'border-color: var(--color-tron-border); color: var(--color-tron-text-secondary);'}
					onclick={() => toggleChainFilter(c.id)}
					title="{c.done}/{c.total} done · {c.board} on the Board · {c.tier1} in Tier 1{c.dueDate ? ` · due ${c.dueDate}` : ''}"
				>
					<span style="color: {c.kind === 'milestone' ? 'var(--color-tron-cyan)' : '#94a3b8'};">◆</span>
					{c.name}
					{#if c.dueDate}<span class="tron-text-muted">{fmtDue(c.dueDate)}</span>{/if}
					<span class="tron-text-muted">{c.tier1}</span>
				</button>
			{/each}
			{#if unwiredCount > 0}
				{@const active = chainFilter === '__unwired__'}
				<button
					type="button"
					class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors"
					style={active
						? 'border-color: #94a3b8; background: rgba(148,163,184,0.12); color: #cbd5e1;'
						: 'border-color: var(--color-tron-border); color: var(--color-tron-text-secondary);'}
					onclick={() => toggleChainFilter('__unwired__')}
					title="Not in any chain — the unshaped inbox"
				>
					Unwired <span class="tron-text-muted">{unwiredCount}</span>
				</button>
			{/if}
			{#if chainFilter}
				<button type="button" class="tron-text-muted ml-1 text-xs hover:underline" onclick={() => (chainFilter = null)}>clear</button>
			{/if}
		</div>
	{/if}

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
			{#each rowGroups as g (g.key)}
				{#if viewMode === 'chain'}
					<!-- KB2-39 — chain header: the milestone, its date, live progress, the walk -->
					{@const capturedHere = g.tasks.filter((t: TaskRow) => t.status === 'captured').length}
					<div class="flex flex-wrap items-center gap-3 bg-[var(--color-tron-bg-tertiary)] px-4 py-2">
						{#if g.chain}
							<span style="color: {g.chain.kind === 'milestone' ? 'var(--color-tron-cyan)' : '#94a3b8'};">◆</span>
							<span class="tron-text-primary text-sm font-bold">{g.chain.name}</span>
							{#if g.chain.dueDate}<span class="tron-text-muted text-xs">due {fmtDue(g.chain.dueDate)}</span>{/if}
							<span class="tron-text-muted text-xs">{g.chain.done}/{g.chain.total} done · {g.chain.board} on the Board · {g.tasks.length} here · {g.chain.nextUp.length} next up</span>
							<span class="ml-auto flex items-center gap-2">
								{#if g.chain.planId}
									<a href="/kanban/plans/{g.chain.planId}" class="text-xs hover:underline" style="color: var(--color-tron-cyan);" title={g.chain.planTitle ?? ''}>plan ›</a>
								{/if}
								<a href="/kanban/roadmap" class="text-xs hover:underline" style="color: var(--color-tron-cyan);">roadmap ›</a>
								{#if capturedHere > 0}
									<TronButton variant="primary" onclick={() => startChainWalk(g.chain!.id)} title="Process this chain's captured tasks one after another, in dependency order">
										Process chain ({capturedHere})
									</TronButton>
								{/if}
							</span>
						{:else}
							<span class="tron-text-primary text-sm font-bold">Unwired</span>
							<span class="tron-text-muted text-xs">{g.tasks.length} option{g.tasks.length === 1 ? '' : 's'} in no chain — the inbox. Add a blocks/blocked-by link to wire one in.</span>
						{/if}
					</div>
				{/if}
				{#each g.tasks as t (t.id)}
					<div class="flex flex-wrap items-center gap-3 px-4 py-2.5">
						{#if t.status === 'captured' || t.status === 'processed'}
							{#if rankEdit !== null && rankEdit.id === t.id}
								<!-- svelte-ignore a11y_autofocus -->
								<input
									type="number"
									min="1"
									class="w-12 shrink-0 rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-bg-tertiary)] px-1 py-0.5 text-right text-xs font-bold text-[var(--color-tron-cyan)] outline-none"
									autofocus
									bind:value={rankEdit.value}
									onkeydown={(e) => {
										if (e.key === 'Enter') submitRankSet();
										else if (e.key === 'Escape') rankEdit = null;
									}}
									onblur={() => submitRankSet()}
									aria-label="Set rank position"
								/>
							{:else}
								<button
									type="button"
									class="tron-text-muted w-7 shrink-0 cursor-pointer rounded text-right text-xs font-bold hover:bg-[var(--color-tron-bg-tertiary)] hover:text-[var(--color-tron-cyan)]"
									title="Click to type a new position — the list shifts around it"
									onclick={() => (rankEdit = { id: t.id, value: String(t.rank) })}
								>{t.rank}</button>
							{/if}
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
								<!-- KB2-39 — chain badge: which milestone DAG, and whether it is startable -->
								{#if t.chain}
									<button
										type="button"
										class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold"
										style={t.chain.nextUp
											? 'background: rgba(52,211,153,0.15); color: #34d399;'
											: 'background: rgba(0,212,255,0.10); color: var(--color-tron-cyan);'}
										title="{t.chain.chainName} · {t.chain.position} of {t.chain.total}{t.chain.also.length ? ` · also in ${t.chain.also.length} more` : ''} — click to filter"
										onclick={() => toggleChainFilter(t.chain!.chainId)}
									>
										◆ {t.chain.chainName}
										{#if t.chain.nextUp}· NEXT UP{:else if t.chain.behind > 0}· behind {t.chain.behind}{/if}
										{#if t.chain.also.length}<span class="opacity-70">+{t.chain.also.length}</span>{/if}
									</button>
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
								{#if data.canReplenish}
									<!-- One-click commit: enabled once processed + DoR-complete.
									     The span carries the tooltip — disabled buttons don't. -->
									<form method="POST" action="?/commit" use:enhance={commitEnhance} class="flex items-center">
										<input type="hidden" name="taskIds" value={t.id} />
										<span title={committable(t) ? 'Commit to the Board — joins the ready queue' : commitBlockedReason(t)}>
											<TronButton type="submit" variant="primary" disabled={!committable(t) || submitting}>Commit</TronButton>
										</span>
									</form>
								{/if}
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
			{/each}
			{#if filtered.length === 0}
				<p class="tron-text-muted px-4 py-3 text-xs">No Tier 1 options match the current filters.</p>
			{/if}
		</div>
	</section>

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
		<!-- KB2-39 — chain context + walk progress -->
		{#if modal.task.chain || walkTotal}
			<div class="mb-3 flex flex-wrap items-center gap-2 text-xs">
				{#if modal.task.chain}
					<span class="rounded px-1.5 py-0.5 font-bold" style="background: rgba(0,212,255,0.10); color: var(--color-tron-cyan);">◆ {modal.task.chain.chainName}</span>
					<span class="tron-text-muted">{modal.task.chain.position} of {modal.task.chain.total}{#if modal.task.chain.nextUp} · next up{:else if modal.task.chain.behind > 0} · behind {modal.task.chain.behind}{/if}</span>
				{/if}
				{#if walkTotal}
					<span class="ml-auto tron-text-muted">Processing chain: {walkTotal - walkQueue.length} of {walkTotal}</span>
					<button type="button" class="tron-text-muted hover:underline" onclick={cancelChainWalk}>stop after this</button>
				{/if}
			</div>
		{/if}
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

			<!-- KB2-39 — estimate joins the Tier 1 modal (was task-page only); the scheduler's rung 1 -->
			<div class="mb-4">
				<TronInput
					label="Estimate (working days — optional; size class stands in when blank)"
					name="estimateDays"
					type="number"
					min="0.5"
					step="0.5"
					value={modal.task.estimateDays ?? ''}
					placeholder="duration in working days"
				/>
			</div>

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
						an investigation: a timeboxed question ('Can X work?') with a timebox (e.g. 2 days). An
						investigation is done when the timebox ends — 'we still don't know' is a valid recorded answer.
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
