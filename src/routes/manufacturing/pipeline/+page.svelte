<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	let { data } = $props();

	function selectStage(stageKey: string) {
		const url = new URL(page.url);
		url.searchParams.set('stage', stageKey);
		goto(url.toString().slice(url.origin.length), { keepFocus: true, noScroll: true });
	}

	function formatElapsed(min: number | null): string {
		if (min == null) return '—';
		if (min < 60) return `${min}m`;
		const h = Math.floor(min / 60);
		const m = min % 60;
		if (h < 24) return `${h}h ${m}m`;
		const d = Math.floor(h / 24);
		return `${d}d ${h % 24}h`;
	}

	function formatWhen(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso);
		return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
	}

	function statusClass(status: string): string {
		const s = String(status).toLowerCase();
		if (s === 'ready' || s === 'completed' || s === 'stored' || s === 'cooling') return 'text-tron-green';
		if (s === 'in_oven' || s === 'running' || s === 'sealed') return 'text-tron-cyan';
		if (s === 'consumed') return 'text-tron-text-secondary';
		if (s === 'aborted' || s === 'cancelled' || s === 'voided' || s === 'rejected') return 'text-tron-red';
		if (s === 'setup' || s === 'loading' || s === 'awaiting removal' || s === 'qc' || s === 'storage') return 'text-tron-yellow';
		return 'text-tron-text';
	}
</script>

<div class="min-h-screen tron-grid-bg p-4 lg:p-6">
	<div class="mb-6 flex flex-wrap items-center justify-between gap-3">
		<div>
			<h1 class="text-2xl font-bold text-tron-cyan tracking-wide">MANUFACTURING PIPELINE</h1>
			<p class="text-sm text-tron-text-secondary">{data.meta.description}</p>
		</div>
		<div class="flex items-center gap-2">
			<a href="/manufacturing/cart-mfg-dev" class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-tron-text-secondary hover:text-tron-cyan hover:border-tron-cyan/50">
				← Back to dashboard
			</a>
			<a href="/manufacturing/pipeline?stage={data.stage}" class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-tron-text-secondary hover:text-tron-cyan hover:border-tron-cyan/50">
				⟳ Refresh
			</a>
		</div>
	</div>

	<!-- Stage selector — dropdown + visual chips -->
	<div class="mb-6 rounded-lg border border-[var(--color-tron-border)] bg-tron-bg-card p-4">
		<div class="flex flex-wrap items-center gap-3">
			<label for="stage-select" class="text-xs font-semibold uppercase tracking-widest text-tron-text-secondary">
				Stage
			</label>
			<select
				id="stage-select"
				value={data.stage}
				onchange={(e) => selectStage((e.target as HTMLSelectElement).value)}
				class="rounded border border-[var(--color-tron-border)] bg-tron-bg-tertiary px-3 py-1.5 text-sm text-tron-text focus:border-tron-cyan focus:outline-none"
			>
				{#each data.stages as s (s.key)}
					<option value={s.key}>{s.label}</option>
				{/each}
			</select>

			<div class="ml-auto flex items-center gap-1 text-xs text-tron-text-secondary">
				{#each data.stages as s, i (s.key)}
					<a
						href="/manufacturing/pipeline?stage={s.key}"
						class="rounded px-2 py-1 font-medium transition-colors {s.key === data.stage
							? `bg-${s.color}/20 text-${s.color} border border-${s.color}/40`
							: 'border border-transparent hover:border-[var(--color-tron-border)] hover:text-tron-text'}"
					>
						{s.label}
					</a>
					{#if i < data.stages.length - 1}
						<span class="text-tron-border select-none">›</span>
					{/if}
				{/each}
			</div>
		</div>

		<div class="mt-4 flex items-baseline gap-6">
			<div>
				<div class="text-xs uppercase tracking-widest text-tron-text-secondary">{data.meta.label}</div>
				<div class="mt-1 text-3xl font-bold text-{data.meta.color}">{data.totalCount}</div>
				<div class="text-xs text-tron-text-secondary">cartridges</div>
			</div>
			<div>
				<div class="text-xs uppercase tracking-widest text-tron-text-secondary">Rows</div>
				<div class="mt-1 text-3xl font-bold text-tron-text">{data.totalRows}</div>
				<div class="text-xs text-tron-text-secondary">
					{data.stage === 'backing' ? 'lots' : data.stage === 'wax_fill' || data.stage === 'reagent' ? 'runs' : data.stage === 'seal' ? 'batches' : 'fridges'}
				</div>
			</div>
		</div>
	</div>

	<!-- Rows table -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-tron-bg-card">
		{#if data.rows.length === 0}
			<div class="p-8 text-center text-sm text-tron-text-secondary">
				Nothing at the {data.meta.label.toLowerCase()} stage right now.
			</div>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-left text-sm">
					<thead class="bg-tron-bg-tertiary text-xs uppercase tracking-wider text-tron-text-secondary">
						<tr>
							{#each data.meta.headers as h (h.key)}
								<th class="px-4 py-2 font-medium">{h.label}</th>
							{/each}
							<th class="px-4 py-2 font-medium"></th>
						</tr>
					</thead>
					<tbody class="divide-y divide-[var(--color-tron-border)]/50">
						{#each data.rows as row (row.id)}
							<tr class="text-tron-text hover:bg-tron-bg-tertiary/30">
								{#each data.meta.headers as h (h.key)}
									<td class="px-4 py-2 align-top">
										{#if h.key === 'id'}
											<span class="font-mono text-xs text-tron-cyan">{row.idLabel ?? row.id}</span>
										{:else if h.key === 'status'}
											<span class="font-mono text-xs uppercase {statusClass(row.status)}">{row.status}</span>
										{:else if h.key === 'count'}
											<span class="tabular-nums">{row.count}</span>
										{:else if h.key === 'location'}
											<span class="text-tron-text-secondary">{row.location ?? '—'}</span>
										{:else if h.key === 'operator'}
											<span class="text-tron-text-secondary">{row.operator ?? '—'}</span>
										{:else if h.key === 'when'}
											<span class="text-xs font-mono text-tron-text-secondary">{formatWhen(row.when)}</span>
										{:else if h.key === 'elapsed'}
											<span class="text-xs tabular-nums text-tron-text-secondary">{formatElapsed(row.elapsedMin)}</span>
										{:else if h.key === 'ready'}
											{#if row.extras.ready === 'yes'}
												<span class="rounded border border-green-500/40 bg-green-900/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-green-300">Ready</span>
											{:else if row.extras.ready === '—'}
												<span class="text-xs text-tron-text-secondary">—</span>
											{:else}
												<span class="text-xs text-tron-text-secondary">
													{row.extras.remainingMin}m left
												</span>
											{/if}
										{:else}
											<span class="text-xs text-tron-text-secondary">{row.extras[h.key] ?? '—'}</span>
										{/if}
									</td>
								{/each}
								<td class="px-4 py-2 text-right">
									{#if row.detailHref}
										<a href={row.detailHref} class="text-xs text-tron-cyan hover:underline">View →</a>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>
