<script lang="ts">
	/**
	 * The full screen report: EVERY row the device emitted, flat, numbered in
	 * emission order, with what each test measures and how it is judged. The
	 * grouped ScreenRowsTable is the quick look; this is the one you review.
	 */
	import { enhance } from '$app/forms';
	import { TronBadge } from '$lib/components/ui';

	interface Row {
		seq: number;
		id: string;
		base: string;
		rep: number | null;
		label: string;
		what: string;
		rule: string;
		level: number;
		status: string;
		deviceStatus: string;
		value: number | string | null;
		limit: number | null;
		ms: number;
		note: string | null;
	}
	interface Props {
		rows: Row[];
		levels: Record<string, { name: string; complete: boolean; counts: { pass: number; fail: number; warn: number; skip: number; info: number } }>;
		sessionId: string;
		confirms?: Array<{ id: string; passed: boolean; by: string; at: string }>;
	}
	let { rows, levels, sessionId, confirms = [] }: Props = $props();

	const STATUS: Record<string, { label: string; v: 'success' | 'error' | 'warning' | 'neutral' }> = {
		P: { label: 'pass', v: 'success' },
		F: { label: 'FAIL', v: 'error' },
		W: { label: 'warn', v: 'warning' },
		S: { label: 'skip', v: 'neutral' },
		I: { label: 'info', v: 'neutral' }
	};
	const LEVEL_NAME: Record<string, string> = { '0': 'Static', '1': 'Actuators & sensors', '2': 'Assay motion', '3': 'Cloud path' };

	let statusFilter = $state<Record<string, boolean>>({ P: true, F: true, W: true, S: true, I: true });
	let levelFilter = $state<string>('all');
	let search = $state('');
	let attentionOnly = $state(false);

	const levelKeys = $derived([...new Set([...Object.keys(levels), ...rows.map((r) => String(r.level))])].sort());
	const counts = $derived.by(() => {
		const c: Record<string, number> = { P: 0, F: 0, W: 0, S: 0, I: 0 };
		for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
		return c;
	});
	const visible = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return rows.filter((r) => {
			if (!statusFilter[r.status]) return false;
			if (levelFilter !== 'all' && String(r.level) !== levelFilter) return false;
			if (attentionOnly && (r.status === 'P' || r.status === 'I')) return false;
			if (q && !`${r.id} ${r.label} ${r.what} ${r.note ?? ''}`.toLowerCase().includes(q)) return false;
			return true;
		});
	});
	const confirmFor = (id: string) => confirms.find((c) => c.id === id) ?? null;
	const fmtMs = (ms: number) => (ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : ms ? `${ms} ms` : '');
	const fmtVal = (v: number | string | null) => (v == null ? '—' : typeof v === 'number' ? v.toLocaleString() : v);
	function toggleAll(on: boolean) {
		for (const k of Object.keys(statusFilter)) statusFilter[k] = on;
	}
</script>

<div class="space-y-3">
	<div class="flex flex-wrap items-center gap-2 text-xs">
		<span class="tron-text-muted">Show</span>
		{#each ['F', 'W', 'S', 'P', 'I'] as k (k)}
			<label class="inline-flex cursor-pointer items-center gap-1 rounded border border-[var(--color-tron-border)] px-2 py-0.5 {statusFilter[k] ? '' : 'opacity-40'}">
				<input type="checkbox" bind:checked={statusFilter[k]} class="h-3 w-3" />
				<TronBadge variant={STATUS[k].v}>{STATUS[k].label}</TronBadge>
				<span class="tron-text-muted">{counts[k] ?? 0}</span>
			</label>
		{/each}
		<button type="button" class="tron-text-muted hover:underline" onclick={() => toggleAll(true)}>all</button>
		<span class="tron-text-muted">·</span>
		<label class="inline-flex items-center gap-1"><input type="checkbox" bind:checked={attentionOnly} class="h-3 w-3" /> needs attention only</label>
		<span class="tron-text-muted">·</span>
		<select bind:value={levelFilter} class="tron-input py-0.5 text-xs">
			<option value="all">all levels</option>
			{#each levelKeys as k (k)}<option value={k}>Level {k} · {levels[k]?.name ?? LEVEL_NAME[k] ?? ''}</option>{/each}
		</select>
		<input type="search" bind:value={search} placeholder="find a test, id or note…" class="tron-input min-w-[14rem] py-0.5 text-xs" />
		<span class="tron-text-muted ml-auto">showing {visible.length} of {rows.length} rows</span>
		<a href="/validation/screen/{sessionId}/report.csv" class="text-[var(--color-tron-cyan)] hover:underline">download CSV</a>
	</div>

	<div class="max-h-[70vh] overflow-auto rounded border border-[var(--color-tron-border)]">
		<table class="w-full text-xs">
			<thead class="sticky top-0 bg-[var(--color-tron-bg,#0b0f14)] text-[10px] uppercase text-[var(--color-tron-text-secondary)]">
				<tr class="border-b border-[var(--color-tron-border)]">
					<th class="px-2 py-1 text-right font-medium">#</th>
					<th class="px-2 py-1 text-left font-medium">Lvl</th>
					<th class="px-2 py-1 text-left font-medium">Test</th>
					<th class="px-2 py-1 text-left font-medium">id</th>
					<th class="px-2 py-1 text-right font-medium">Rep</th>
					<th class="px-2 py-1 text-left font-medium">Result</th>
					<th class="px-2 py-1 text-right font-medium">Value</th>
					<th class="px-2 py-1 text-right font-medium">Limit</th>
					<th class="px-2 py-1 text-right font-medium">Took</th>
					<th class="px-2 py-1 text-left font-medium">Note</th>
					<th class="px-2 py-1 text-left font-medium">What it measures</th>
					<th class="px-2 py-1 text-left font-medium">Rule</th>
				</tr>
			</thead>
			<tbody>
				{#each visible as r (r.seq)}
					{@const st = STATUS[r.status] ?? STATUS.I}
					{@const c = r.id === 'buzz' || r.id === 'led' ? confirmFor(r.id) : null}
					<tr class="border-b border-[var(--color-tron-border)]/40 {r.status === 'F' ? 'bg-[var(--color-tron-red)]/10' : r.status === 'W' ? 'bg-[var(--color-tron-orange)]/10' : ''}">
						<td class="px-2 py-1 text-right font-mono tron-text-muted">{r.seq}</td>
						<td class="px-2 py-1 font-mono tron-text-muted" title={LEVEL_NAME[String(r.level)] ?? ''}>{r.level}</td>
						<td class="px-2 py-1 tron-text-primary whitespace-nowrap">{r.label}</td>
						<td class="px-2 py-1 font-mono tron-text-muted">{r.id}</td>
						<td class="px-2 py-1 text-right font-mono tron-text-muted">{r.rep ?? ''}</td>
						<td class="px-2 py-1 whitespace-nowrap">
							<TronBadge variant={st.v}>{st.label}</TronBadge>
							{#if r.deviceStatus !== r.status}<span class="tron-text-muted ml-1 text-[10px]" title="The device reported this status; BIMS criteria changed it">dev {STATUS[r.deviceStatus]?.label ?? r.deviceStatus}</span>{/if}
							{#if r.id === 'buzz' || r.id === 'led'}
								{#if c}
									<span class="ml-2 text-[10px] {c.passed ? 'text-[var(--color-tron-green)]' : 'text-[var(--color-tron-red)]'}">operator: {c.passed ? 'confirmed' : 'NOT seen/heard'} ({c.by})</span>
								{:else}
									<form method="POST" action="/validation/screen?/confirm" use:enhance class="ml-2 inline-flex gap-1">
										<input type="hidden" name="sessionId" value={sessionId} />
										<input type="hidden" name="id" value={r.id} />
										<button type="submit" name="passed" value="1" class="rounded border border-[var(--color-tron-green)] px-1.5 text-[10px] text-[var(--color-tron-green)]">{r.id === 'buzz' ? 'heard it' : 'saw it'}</button>
										<button type="submit" name="passed" value="0" class="rounded border border-[var(--color-tron-red)] px-1.5 text-[10px] text-[var(--color-tron-red)]">no</button>
									</form>
								{/if}
							{/if}
						</td>
						<td class="px-2 py-1 text-right font-mono">{fmtVal(r.value)}</td>
						<td class="px-2 py-1 text-right font-mono tron-text-muted">{r.limit ?? ''}</td>
						<td class="px-2 py-1 text-right font-mono tron-text-muted whitespace-nowrap">{fmtMs(r.ms)}</td>
						<td class="px-2 py-1 tron-text-muted">{r.note ?? ''}</td>
						<td class="px-2 py-1 tron-text-muted">{r.what}</td>
						<td class="px-2 py-1 tron-text-muted">{r.rule}</td>
					</tr>
				{/each}
				{#if visible.length === 0}
					<tr><td colspan="12" class="tron-text-muted px-2 py-3 text-center">No rows match the filter.</td></tr>
				{/if}
			</tbody>
		</table>
	</div>
</div>
