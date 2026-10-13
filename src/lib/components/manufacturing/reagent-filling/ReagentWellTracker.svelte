<script lang="ts">
	/**
	 * Reagent well tracker (2026-10-06). The deck drawn the same way as the
	 * loading grid (8 rows × 3 carriers, snake order), each cartridge split into
	 * its four reagent wells (2 beads · 3 tracer · 4 wash · 5 elution). The
	 * operator watching the robot taps the well that just went wrong, picks what
	 * they saw, and it is on the run record immediately — no clipboard, no
	 * "I think it was slot 14". Entries can be removed (mis-tap) until Done.
	 */
	import { deserialize } from '$app/forms';
	import {
		REAGENT_DECK_ROWS,
		REAGENT_WELLS,
		REAGENT_WELL_ISSUE_DEFS,
		issueShort,
		issueLabel,
		type ReagentWellIssueRow
	} from '$lib/manufacturing/reagent-well-issues';

	interface Props {
		runId: string;
		issues: ReagentWellIssueRow[];
		/** Deck positions that hold a cartridge (others render as empty). */
		loadedPositions: number[];
		/** cartridgeId per deck position, for the tile caption. */
		cartridgeByPosition?: Record<number, string>;
		/** Reagent name per well (from the run's tube records / assay). */
		reagentNames?: Record<number, string>;
		/** Wells the protocol was told to fill (well_2..well_5 RTPs). Unfilled wells render muted. */
		activeWells?: number[];
		readonly?: boolean;
		onChange?: (issues: ReagentWellIssueRow[]) => void;
		/** Builds a form-action URL; defaults to this page's own ?/<name>. */
		actionUrl?: (name: string) => string;
	}

	let {
		runId,
		issues,
		loadedPositions,
		cartridgeByPosition = {},
		reagentNames = {},
		activeWells = [2, 3, 4, 5],
		readonly = false,
		onChange,
		actionUrl = (n: string) => `?/${n}`
	}: Props = $props();

	let selected = $state<{ position: number; well: number } | null>(null);
	let note = $state('');
	let busy = $state(false);
	let error = $state('');

	const loaded = $derived(new Set(loadedPositions));
	const active = $derived(new Set(activeWells));

	// position → well → entries
	const byCell = $derived.by(() => {
		const m = new Map<string, ReagentWellIssueRow[]>();
		for (const i of issues) {
			const k = `${i.deckPosition}:${i.well}`;
			if (!m.has(k)) m.set(k, []);
			m.get(k)!.push(i);
		}
		return m;
	});
	const cellIssues = (position: number, well: number) => byCell.get(`${position}:${well}`) ?? [];

	const affectedCarts = $derived(new Set(issues.map((i) => i.deckPosition)).size);

	function wellName(well: number): string {
		return reagentNames[well] ?? REAGENT_WELLS.find((w) => w.well === well)?.defaultName ?? `Well ${well}`;
	}

	function pick(position: number, well: number) {
		if (readonly || !loaded.has(position)) return;
		if (selected?.position === position && selected?.well === well) {
			selected = null;
			return;
		}
		selected = { position, well };
		note = '';
		error = '';
	}

	async function post(action: 'logWellIssue' | 'removeWellIssue', fields: Record<string, string>) {
		busy = true;
		error = '';
		try {
			const fd = new FormData();
			fd.set('runId', runId);
			for (const [k, v] of Object.entries(fields)) fd.set(k, v);
			const res = await fetch(actionUrl(action), {
				method: 'POST',
				body: fd,
				headers: { 'x-sveltekit-action': 'true' }
			});
			const result = deserialize(await res.text());
			if (result.type === 'failure') throw new Error(String((result.data as any)?.error ?? `HTTP ${result.status}`));
			if (result.type === 'error') throw new Error(result.error?.message ?? 'Request failed');
			if (result.type === 'success' && Array.isArray((result.data as any)?.wellIssues)) {
				onChange?.((result.data as any).wellIssues as ReagentWellIssueRow[]);
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save';
		} finally {
			busy = false;
		}
	}

	async function log(issue: string) {
		if (!selected) return;
		const sel = selected;
		await post('logWellIssue', {
			deckPosition: String(sel.position),
			well: String(sel.well),
			issue,
			note
		});
		if (!error) {
			note = '';
			selected = null;
		}
	}

	async function remove(id: string) {
		await post('removeWellIssue', { issueId: id });
	}

	function cellClass(position: number, well: number): string {
		const n = cellIssues(position, well).length;
		const isSel = selected?.position === position && selected?.well === well;
		if (!loaded.has(position)) return 'border-transparent bg-transparent';
		if (n > 0) return isSel ? 'border-red-300 bg-red-500/60 text-white' : 'border-red-400/70 bg-red-500/35 text-red-100';
		if (!active.has(well)) return 'border-[var(--color-tron-border)]/40 bg-transparent text-[var(--color-tron-text-secondary)]/40';
		return isSel
			? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/30 text-[var(--color-tron-cyan)]'
			: 'border-emerald-500/40 bg-emerald-900/20 text-emerald-200/80 hover:border-[var(--color-tron-cyan)]';
	}

	const fmtTime = (iso: string | null) =>
		iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
</script>

<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
	<div class="mb-3 flex flex-wrap items-start justify-between gap-2">
		<div>
			<h3 class="text-sm font-semibold text-[var(--color-tron-text)]">Well tracker — log fill mistakes as you see them</h3>
			<p class="mt-0.5 text-xs text-[var(--color-tron-text-secondary)]">
				Tap the well that went wrong, then what you saw. Each cartridge shows its four reagent wells left→right:
				{#each REAGENT_WELLS as w, i (w.well)}{i > 0 ? ' · ' : ''}<span class="font-mono">{w.well}</span> {wellName(w.well)}{/each}.
			</p>
		</div>
		<div class="text-right text-xs">
			{#if issues.length === 0}
				<span class="rounded border border-emerald-500/40 bg-emerald-900/20 px-2 py-1 text-emerald-300">No issues logged</span>
			{:else}
				<span class="rounded border border-red-400/50 bg-red-900/20 px-2 py-1 text-red-200">
					{issues.length} issue{issues.length === 1 ? '' : 's'} on {affectedCarts} cartridge{affectedCarts === 1 ? '' : 's'}
				</span>
			{/if}
		</div>
	</div>

	<div class="grid gap-4 lg:grid-cols-[auto_1fr]">
		<!-- Deck: 8 rows × 3 carriers, same snake as the loading grid -->
		<div class="overflow-x-auto">
			<div class="mb-1 grid grid-cols-3 gap-2 text-center text-[10px] uppercase tracking-wide text-[var(--color-tron-text-secondary)]">
				<span>Carrier 1</span><span>Carrier 2</span><span>Carrier 3</span>
			</div>
			<div class="grid grid-cols-3 gap-2">
				{#each REAGENT_DECK_ROWS as row, ri (ri)}
					{#each row as position (position)}
						{@const cartId = cartridgeByPosition[position]}
						{@const n = REAGENT_WELLS.reduce((s, w) => s + cellIssues(position, w.well).length, 0)}
						<div
							class="rounded border px-1.5 py-1 {loaded.has(position)
								? n > 0
									? 'border-red-400/60 bg-red-900/10'
									: 'border-[var(--color-tron-border)] bg-[var(--color-tron-bg)]/40'
								: 'border-dashed border-[var(--color-tron-border)]/40 opacity-40'}"
						>
							<div class="flex items-center justify-between text-[10px] leading-tight">
								<span class="font-semibold text-[var(--color-tron-text)]">#{position}</span>
								{#if cartId}
									<span class="font-mono text-[var(--color-tron-text-secondary)]" title={cartId}>…{cartId.slice(-4)}</span>
								{:else if loaded.has(position)}
									<span class="text-[var(--color-tron-text-secondary)]">loaded</span>
								{:else}
									<span class="text-[var(--color-tron-text-secondary)]">empty</span>
								{/if}
							</div>
							<div class="mt-1 grid grid-cols-4 gap-0.5">
								{#each REAGENT_WELLS as w (w.well)}
									{@const c = cellIssues(position, w.well)}
									<button
										type="button"
										class="min-h-[30px] rounded border text-[11px] font-mono leading-none transition-colors disabled:cursor-default {cellClass(position, w.well)}"
										disabled={readonly || !loaded.has(position)}
										title={loaded.has(position)
											? `#${position} · well ${w.well} (${wellName(w.well)})${c.length ? ' — ' + c.map((x) => issueLabel(x.issue)).join(', ') : ''}`
											: 'No cartridge in this position'}
										onclick={() => pick(position, w.well)}
									>
										{#if c.length > 0}
											{issueShort(c[0].issue)}{c.length > 1 ? `+${c.length - 1}` : ''}
										{:else}
											{w.well}
										{/if}
									</button>
								{/each}
							</div>
						</div>
					{/each}
				{/each}
			</div>
		</div>

		<!-- Right: picker (when a well is selected) + the running log -->
		<div class="min-w-0 space-y-3">
			{#if selected && !readonly}
				<div class="rounded-lg border border-[var(--color-tron-cyan)]/60 bg-[var(--color-tron-cyan)]/10 p-3">
					<div class="flex items-center justify-between">
						<div class="text-sm font-semibold" style="color: var(--color-tron-cyan)">
							Cartridge #{selected.position} · well {selected.well} ({wellName(selected.well)})
							{#if cartridgeByPosition[selected.position]}
								<span class="ml-2 font-mono text-[11px] text-[var(--color-tron-text-secondary)]">{cartridgeByPosition[selected.position]}</span>
							{/if}
						</div>
						<button type="button" class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]" onclick={() => (selected = null)}>Close</button>
					</div>
					<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">What did you see?</p>
					<div class="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
						{#each REAGENT_WELL_ISSUE_DEFS as d (d.code)}
							<button
								type="button"
								class="min-h-[40px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)]/60 px-2 py-1 text-left text-xs text-[var(--color-tron-text)] hover:border-red-400 hover:bg-red-900/20 disabled:opacity-50"
								disabled={busy}
								title={d.hint}
								onclick={() => log(d.code)}
							>
								<span class="font-medium">{d.label}</span>
							</button>
						{/each}
					</div>
					<input
						type="text"
						class="tron-input mt-2"
						placeholder="Optional note (e.g. tip hit the rim, second trip)"
						bind:value={note}
						maxlength="500"
						disabled={busy}
					/>
					{#if error}
						<p class="mt-2 text-xs text-red-300">{error}</p>
					{/if}
				</div>
			{:else if error}
				<p class="text-xs text-red-300">{error}</p>
			{/if}

			<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)]/40">
				<div class="border-b border-[var(--color-tron-border)] px-3 py-1.5 text-[11px] uppercase tracking-wide text-[var(--color-tron-text-secondary)]">
					Logged this run
				</div>
				{#if issues.length === 0}
					<p class="px-3 py-3 text-xs text-[var(--color-tron-text-secondary)]">Nothing yet. Tap a well on the deck to log a mistake.</p>
				{:else}
					<ul class="max-h-72 divide-y divide-[var(--color-tron-border)] overflow-y-auto text-xs">
						{#each [...issues].sort((a, b) => (b.loggedAt ?? '').localeCompare(a.loggedAt ?? '')) as i (i.id)}
							<li class="flex items-start justify-between gap-2 px-3 py-1.5">
								<div class="min-w-0">
									<span class="font-semibold text-[var(--color-tron-text)]">#{i.deckPosition}</span>
									<span class="text-[var(--color-tron-text-secondary)]"> · well {i.well}{i.reagentName ? ` ${i.reagentName}` : ''} · </span>
									<span class="text-red-200">{issueLabel(i.issue)}</span>
									{#if i.note}<span class="text-[var(--color-tron-text-secondary)]"> — {i.note}</span>{/if}
									<span class="ml-1 text-[10px] text-[var(--color-tron-text-secondary)]">{fmtTime(i.loggedAt)}{i.loggedBy ? ` · ${i.loggedBy}` : ''}</span>
								</div>
								{#if !readonly}
									<button
										type="button"
										class="shrink-0 text-[11px] text-[var(--color-tron-text-secondary)] hover:text-red-300 disabled:opacity-50"
										disabled={busy}
										title="Remove (mis-tap)"
										onclick={() => remove(i.id)}
									>✕</button>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	</div>
</div>
