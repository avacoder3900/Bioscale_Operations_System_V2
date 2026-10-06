<!--
	Move between sonic recordings from a recording's page: ◀ Previous / Next ▶ in
	the recordings list's order, a picker of every SONIC recording (optionally only
	the ones still to trim), and "Next to trim →" — the next recording after this
	one that still needs analyzing or trimming (wraps around).
-->
<script lang="ts" module>
	export interface NavItem {
		id: string;
		udi: string;
		at: string | null;
		fileName: string | null;
		status: 'verified' | 'unusable' | 'needs-trim' | 'needs-analysis';
		anomalies: number | null;
	}
</script>

<script lang="ts">
	import { goto } from '$app/navigation';

	interface Props {
		items: NavItem[];
		currentId: string;
	}
	let { items, currentId }: Props = $props();

	let onlyTodo = $state(false);

	const idx = $derived(items.findIndex((r) => r.id === currentId));
	const prev = $derived(idx > 0 ? items[idx - 1] : null);
	const next = $derived(idx >= 0 && idx < items.length - 1 ? items[idx + 1] : null);
	const todo = (r: NavItem) => r.status === 'needs-trim' || r.status === 'needs-analysis';
	const todoCount = $derived(items.filter(todo).length);
	/** The next recording after this one (wrapping) that still needs work. */
	const nextTodo = $derived.by(() => {
		if (!items.length) return null;
		for (let k = 1; k <= items.length; k++) {
			const r = items[(Math.max(idx, 0) + k) % items.length];
			if (r.id !== currentId && todo(r)) return r;
		}
		return null;
	});
	const shown = $derived(onlyTodo ? items.filter((r) => todo(r) || r.id === currentId) : items);

	const icon: Record<NavItem['status'], string> = {
		'needs-analysis': '… analyze',
		'needs-trim': '⚠ trim',
		verified: '✓',
		unusable: '✗ unusable'
	};
	const day = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
	const label = (r: NavItem) =>
		`${r.udi} · ${day(r.at)} · ${icon[r.status]}${r.status === 'verified' && r.anomalies != null ? ` (${r.anomalies} anomal${r.anomalies === 1 ? 'y' : 'ies'})` : ''}`;

	function open(id: string) {
		if (id && id !== currentId) goto(`/validation/sonic/${id}`);
	}
</script>

<div class="tron-card flex flex-wrap items-center gap-2 p-3 text-sm">
	<button type="button" disabled={!prev} onclick={() => prev && open(prev.id)} title={prev ? label(prev) : 'This is the first recording'} class="rounded border border-[var(--color-tron-border)] px-3 disabled:opacity-40" style="min-height: 44px;">◀ Previous</button>
	<select
		value={currentId}
		onchange={(e) => open((e.currentTarget as HTMLSelectElement).value)}
		aria-label="Go to another recording"
		class="tron-select min-w-[260px] flex-1"
		style="min-height: 44px;"
	>
		{#each shown as r (r.id)}
			<option value={r.id}>{label(r)}</option>
		{/each}
	</select>
	<button type="button" disabled={!next} onclick={() => next && open(next.id)} title={next ? label(next) : 'This is the last recording'} class="rounded border border-[var(--color-tron-border)] px-3 disabled:opacity-40" style="min-height: 44px;">Next ▶</button>
	<label class="inline-flex items-center gap-2 px-1" style="min-height: 44px;">
		<input type="checkbox" bind:checked={onlyTodo} class="h-5 w-5" />
		<span class="text-xs">Only ones to trim</span>
	</label>
	<button
		type="button"
		disabled={!nextTodo}
		onclick={() => nextTodo && open(nextTodo.id)}
		title={nextTodo ? label(nextTodo) : 'Every other recording is trimmed and verified (or marked unusable)'}
		class="rounded bg-[var(--color-tron-orange)] px-4 font-semibold text-[var(--color-tron-bg-primary)] disabled:opacity-40"
		style="min-height: 44px;"
	>
		Next to trim → <span class="font-normal">({todoCount} left)</span>
	</button>
	<span class="tron-text-muted w-full text-xs">Recording {idx >= 0 ? idx + 1 : '—'} of {items.length}, newest first.</span>
</div>
