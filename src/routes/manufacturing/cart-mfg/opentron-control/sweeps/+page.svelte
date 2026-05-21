<script lang="ts">
	import { goto } from '$app/navigation';

	let { data } = $props();

	type SweepItem = {
		_id: string;
		robotId: string;
		robotName?: string;
		positionSetTitle?: string;
		status: string;
		slotsTotal: number;
		slotsDone: number;
		scanCount: number;
		errorCount: number;
		source: string;
		contextRef?: string;
		startedAt: string;
		completedAt?: string;
		durationSec: number | null;
		requestedByUsername?: string;
		abortReason?: string;
	};

	const items = $derived((data.items ?? []) as SweepItem[]);
	const robots = $derived((data.robots ?? []) as { _id: string; name: string }[]);
	const selected = $derived(data.selected as any);
	const filter = $derived(data.filter as { robotId: string | null; status: string | null; selectedId: string | null });

	function fmtTime(iso: string | undefined | null) {
		if (!iso) return '—';
		const d = new Date(iso);
		return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
	}

	function fmtDuration(sec: number | null) {
		if (sec === null || sec === undefined) return '—';
		const m = Math.floor(sec / 60);
		const s = sec % 60;
		return m > 0 ? `${m}m ${s}s` : `${s}s`;
	}

	function statusClass(status: string) {
		switch (status) {
			case 'running': return 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]';
			case 'paused': return 'bg-amber-500/20 text-amber-300';
			case 'completed': return 'bg-green-500/20 text-green-300';
			case 'cancelled': return 'bg-red-500/20 text-red-300';
			case 'errored': return 'bg-red-500/30 text-red-200';
			default: return 'bg-[var(--color-tron-border)]/30 text-[var(--color-tron-text-secondary)]';
		}
	}

	function applyFilter(updates: Record<string, string | null>) {
		const u = new URL(window.location.href);
		for (const [k, v] of Object.entries(updates)) {
			if (v) u.searchParams.set(k, v);
			else u.searchParams.delete(k);
		}
		goto(u.pathname + u.search, { replaceState: false, keepFocus: true });
	}

	function selectRow(id: string) {
		applyFilter({ selected: id });
	}
	function closeDetail() {
		applyFilter({ selected: null });
	}
</script>

<div class="mx-auto max-w-7xl space-y-6 p-4">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Scan Cartridges — Sweep History</h1>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
				Recent gantry sweeps across all robots. Click a row to open its full log.
			</p>
		</div>
		<a href="/manufacturing/cart-mfg/opentron-control"
			class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs hover:border-[var(--color-tron-cyan)] transition-colors"
			style="color: var(--color-tron-text)">
			← Opentron Control
		</a>
	</div>

	<!-- Filters -->
	<div class="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
		<label class="text-xs" style="color: var(--color-tron-text-secondary)">
			Robot
			<select
				class="ml-2 rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1 text-xs"
				style="color: var(--color-tron-text)"
				value={filter.robotId ?? ''}
				onchange={(e) => applyFilter({ robot: (e.currentTarget as HTMLSelectElement).value || null })}
			>
				<option value="">All</option>
				{#each robots as r (r._id)}
					<option value={r._id}>{r.name}</option>
				{/each}
			</select>
		</label>
		<label class="text-xs" style="color: var(--color-tron-text-secondary)">
			Status
			<select
				class="ml-2 rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1 text-xs"
				style="color: var(--color-tron-text)"
				value={filter.status ?? ''}
				onchange={(e) => applyFilter({ status: (e.currentTarget as HTMLSelectElement).value || null })}
			>
				<option value="">All</option>
				<option value="running">Running</option>
				<option value="paused">Paused</option>
				<option value="completed">Completed</option>
				<option value="cancelled">Cancelled</option>
				<option value="errored">Errored</option>
			</select>
		</label>
		<span class="ml-auto text-xs" style="color: var(--color-tron-text-secondary)">
			{items.length} sweep{items.length === 1 ? '' : 's'} shown (latest 50)
		</span>
	</div>

	<!-- Detail panel -->
	{#if selected}
		<div class="rounded-lg border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-surface)] p-4">
			<div class="flex items-start justify-between gap-3">
				<div>
					<div class="flex items-center gap-2">
						<span class="rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider {statusClass(selected.status)}">
							{selected.status}
						</span>
						<span class="font-mono text-xs" style="color: var(--color-tron-text-secondary)">{selected._id}</span>
					</div>
					<div class="mt-1 text-sm" style="color: var(--color-tron-text)">
						<span class="font-semibold">{selected.robotName ?? selected.robotId}</span>
						<span class="mx-2" style="color: var(--color-tron-text-secondary)">·</span>
						<span style="color: var(--color-tron-text-secondary)">{selected.positionSetTitle ?? '—'}</span>
						<span class="mx-2" style="color: var(--color-tron-text-secondary)">·</span>
						<span style="color: var(--color-tron-text-secondary)">{selected.source}{selected.contextRef ? ` (${selected.contextRef})` : ''}</span>
					</div>
					<div class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
						{fmtTime(selected.startedAt)} → {fmtTime(selected.completedAt)} · {fmtDuration(selected.completedAt && selected.startedAt ? Math.round((new Date(selected.completedAt).getTime() - new Date(selected.startedAt).getTime()) / 1000) : null)}
						· by {selected.requestedByUsername ?? '—'}
					</div>
					{#if selected.abortReason}
						<p class="mt-1 text-xs text-red-300">Abort reason: {selected.abortReason}</p>
					{/if}
				</div>
				<button
					type="button"
					onclick={closeDetail}
					class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
				>
					Close
				</button>
			</div>

			<div class="mt-3 grid gap-3 lg:grid-cols-2">
				<div>
					<h3 class="text-xs font-semibold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
						Scans ({(selected.scans ?? []).length})
					</h3>
					{#if (selected.scans ?? []).length === 0}
						<p class="mt-1 text-[11px] italic" style="color: var(--color-tron-text-secondary)">—</p>
					{:else}
						<div class="mt-1 max-h-64 overflow-y-auto rounded border border-[var(--color-tron-border)] bg-black/30 p-2 font-mono text-[10px]">
							{#each selected.scans as s (s.slotIndex)}
								<div class="flex justify-between gap-2 text-green-300">
									<span>Slot {s.slotIndex + 1}</span>
									<span class="flex-1 break-all text-right">{s.barcode}</span>
									<span class="opacity-60">{s.attempts}×</span>
								</div>
							{/each}
						</div>
					{/if}
				</div>
				<div>
					<h3 class="text-xs font-semibold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
						Errors ({(selected.errors ?? []).length})
					</h3>
					{#if (selected.errors ?? []).length === 0}
						<p class="mt-1 text-[11px] italic" style="color: var(--color-tron-text-secondary)">—</p>
					{:else}
						<div class="mt-1 max-h-64 overflow-y-auto rounded border border-red-500/30 bg-red-900/10 p-2 font-mono text-[10px] text-red-300">
							{#each selected.errors as e (e.slotIndex)}
								<div>
									<span class="font-semibold">Slot {e.slotIndex + 1}:</span> {e.message}
								</div>
							{/each}
						</div>
					{/if}
				</div>
			</div>

			<div class="mt-3">
				<h3 class="text-xs font-semibold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
					Log ({(selected.log ?? []).length})
				</h3>
				<div class="mt-1 max-h-96 overflow-y-auto rounded border border-[var(--color-tron-border)] bg-black/40 p-2 font-mono text-[10px] leading-tight">
					{#each (selected.log ?? []) as entry, i (i)}
						<div class="
							{entry.level === 'error' ? 'text-red-300' :
							entry.level === 'warn' ? 'text-amber-300' :
							'text-[var(--color-tron-text-secondary)]'}">
							<span class="opacity-50">[{new Date(entry.ts).toLocaleTimeString()}]</span>
							{entry.message}
						</div>
					{/each}
				</div>
			</div>
		</div>
	{/if}

	<!-- Table -->
	<div class="overflow-x-auto rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
		<table class="w-full text-xs">
			<thead class="text-left" style="color: var(--color-tron-text-secondary)">
				<tr class="border-b border-[var(--color-tron-border)]">
					<th class="px-3 py-2 font-semibold">Status</th>
					<th class="px-3 py-2 font-semibold">Started</th>
					<th class="px-3 py-2 font-semibold">Robot</th>
					<th class="px-3 py-2 font-semibold">Set</th>
					<th class="px-3 py-2 font-semibold">Source</th>
					<th class="px-3 py-2 text-right font-semibold">Scans</th>
					<th class="px-3 py-2 text-right font-semibold">Errors</th>
					<th class="px-3 py-2 text-right font-semibold">Slots</th>
					<th class="px-3 py-2 text-right font-semibold">Duration</th>
					<th class="px-3 py-2 font-semibold">Operator</th>
				</tr>
			</thead>
			<tbody>
				{#each items as item (item._id)}
					<tr
						class="cursor-pointer border-b border-[var(--color-tron-border)]/40 transition-colors hover:bg-[var(--color-tron-cyan)]/5
							{filter.selectedId === item._id ? 'bg-[var(--color-tron-cyan)]/10' : ''}"
						onclick={() => selectRow(item._id)}
					>
						<td class="px-3 py-2">
							<span class="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider {statusClass(item.status)}">
								{item.status}
							</span>
						</td>
						<td class="px-3 py-2 font-mono text-[11px]" style="color: var(--color-tron-text-secondary)">
							{fmtTime(item.startedAt)}
						</td>
						<td class="px-3 py-2" style="color: var(--color-tron-text)">
							{item.robotName ?? item.robotId}
						</td>
						<td class="px-3 py-2" style="color: var(--color-tron-text-secondary)">
							{item.positionSetTitle ?? '—'}
						</td>
						<td class="px-3 py-2" style="color: var(--color-tron-text-secondary)">
							{item.source}{item.contextRef ? ` (${item.contextRef.slice(0, 8)})` : ''}
						</td>
						<td class="px-3 py-2 text-right font-mono text-green-300">{item.scanCount}</td>
						<td class="px-3 py-2 text-right font-mono {item.errorCount > 0 ? 'text-red-300' : ''}" style="color: {item.errorCount > 0 ? '' : 'var(--color-tron-text-secondary)'}">{item.errorCount}</td>
						<td class="px-3 py-2 text-right font-mono" style="color: var(--color-tron-text-secondary)">
							{item.slotsDone}/{item.slotsTotal}
						</td>
						<td class="px-3 py-2 text-right font-mono text-[11px]" style="color: var(--color-tron-text-secondary)">
							{fmtDuration(item.durationSec)}
						</td>
						<td class="px-3 py-2 font-mono text-[11px]" style="color: var(--color-tron-text-secondary)">
							{item.requestedByUsername ?? '—'}
						</td>
					</tr>
				{:else}
					<tr>
						<td colspan="10" class="px-3 py-8 text-center text-xs" style="color: var(--color-tron-text-secondary)">
							No sweeps recorded yet{filter.robotId || filter.status ? ' for the current filter' : ''}.
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>
