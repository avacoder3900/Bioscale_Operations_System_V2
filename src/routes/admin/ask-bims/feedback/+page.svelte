<script lang="ts">
	import type { PageData } from './$types';

	interface Props { data: PageData }
	let { data }: Props = $props();

	function fmtTime(iso: string | Date): string {
		const d = new Date(iso);
		const now = Date.now();
		const ms = now - d.getTime();
		if (ms < 60_000) return 'just now';
		if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
		if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
		return d.toLocaleString();
	}

	function truncate(s: string, n: number): string {
		if (!s) return '';
		return s.length > n ? s.slice(0, n) + '…' : s;
	}

	function confidenceColor(c: string | undefined): string {
		if (c === 'high') return 'bg-emerald-500 text-emerald-50';
		if (c === 'partial') return 'bg-yellow-500 text-yellow-50';
		if (c === 'degraded') return 'bg-red-500 text-red-50';
		return 'bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-text-secondary)]';
	}

	// Group the 7-day daily counts so we can render a tiny trend strip
	const dailyByDate = $derived.by(() => {
		const map = new Map<string, { up: number; down: number }>();
		for (const row of data.dailyLast7d) {
			const e = map.get(row.date) ?? { up: 0, down: 0 };
			if (row.rating === 'up') e.up += row.count;
			if (row.rating === 'down') e.down += row.count;
			map.set(row.date, e);
		}
		return Array.from(map.entries()).map(([date, counts]) => ({ date, ...counts }));
	});
</script>

<div class="space-y-6">
	<header>
		<h1 class="text-xl font-semibold text-[var(--color-tron-text)]">Ask BIMS — Feedback</h1>
		<p class="text-sm text-[var(--color-tron-text-secondary)]">
			Thumbs-up and thumbs-down ratings from the widget. Thumbs-downs are the triage queue — those are where prompt and tool tuning levers live. Review weekly.
		</p>
	</header>

	<!-- Headline stats -->
	<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Last 30 days — total rated</div>
			<div class="mt-1 font-mono text-2xl text-[var(--color-tron-cyan)]">{data.summary30d.totalRated}</div>
			<div class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">answers given a thumbs</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Thumbs up</div>
			<div class="mt-1 font-mono text-2xl text-emerald-400">{data.summary30d.upCount}</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Thumbs down</div>
			<div class="mt-1 font-mono text-2xl text-red-400">{data.summary30d.downCount}</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Down rate</div>
			<div class="mt-1 font-mono text-2xl {data.summary30d.downPct > 20 ? 'text-[var(--color-tron-red)]' : data.summary30d.downPct > 10 ? 'text-[var(--color-tron-yellow)]' : 'text-emerald-400'}">{data.summary30d.downPct}%</div>
			<div class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">target &lt; 10%</div>
		</div>
	</div>

	<!-- 7-day trend -->
	{#if dailyByDate.length > 0}
		<section>
			<h2 class="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Last 7 days</h2>
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
				<div class="flex items-end gap-2">
					{#each dailyByDate as d (d.date)}
						{@const total = d.up + d.down}
						{@const maxBar = Math.max(...dailyByDate.map(x => x.up + x.down), 1)}
						<div class="flex flex-1 flex-col items-center gap-1">
							<div class="flex h-16 w-full items-end justify-center gap-px">
								<div class="w-2 bg-emerald-500" style="height: {(d.up / maxBar) * 100}%"></div>
								<div class="w-2 bg-red-500" style="height: {(d.down / maxBar) * 100}%"></div>
							</div>
							<div class="font-mono text-[9px] text-[var(--color-tron-text-secondary)]">{d.date.slice(5)}</div>
							<div class="font-mono text-[9px] text-[var(--color-tron-text)]">{total}</div>
						</div>
					{/each}
				</div>
			</div>
		</section>
	{/if}

	<!-- Tools that show up most often on thumbs-downs -->
	{#if data.topToolsOnDowns.length > 0}
		<section>
			<h2 class="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Tools flagged most often (last 30 days)</h2>
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
				<table class="w-full text-xs">
					<thead>
						<tr class="text-left text-[var(--color-tron-text-secondary)]">
							<th class="pb-2 font-mono">Tool</th>
							<th class="pb-2 text-right font-mono">Thumbs-down count</th>
						</tr>
					</thead>
					<tbody>
						{#each data.topToolsOnDowns as t (t.tool)}
							<tr class="border-t border-[var(--color-tron-border)]">
								<td class="py-1.5 font-mono text-[var(--color-tron-text)]">{t.tool}</td>
								<td class="py-1.5 text-right font-mono text-red-400">{t.downs}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}

	<!-- Triage queue: recent thumbs-downs -->
	<section>
		<h2 class="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
			Triage queue — recent thumbs-downs
		</h2>
		{#if data.recentDowns.length === 0}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 text-center text-sm text-[var(--color-tron-text-secondary)]">
				No thumbs-downs yet. (That's good!)
			</div>
		{:else}
			<div class="space-y-3">
				{#each data.recentDowns as r (r._id)}
					<div class="rounded-lg border border-red-500/30 bg-[var(--color-tron-bg-secondary)] p-4">
						<div class="flex items-start justify-between gap-2 text-xs text-[var(--color-tron-text-secondary)]">
							<span>{r.username} · {fmtTime(r.timestamp)}</span>
							<div class="flex items-center gap-1">
								{#if r.confidence}
									<span class="rounded px-1.5 py-0.5 font-mono text-[10px] {confidenceColor(r.confidence)}">{r.confidence}</span>
								{/if}
								{#if r.model}
									<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-tron-text-secondary)]">{r.model.replace('claude-', '')}</span>
								{/if}
							</div>
						</div>
						<div class="mt-2">
							<div class="text-xs font-semibold text-[var(--color-tron-text-secondary)]">Question</div>
							<div class="mt-0.5 text-sm text-[var(--color-tron-text)]">{r.question}</div>
						</div>
						<div class="mt-2">
							<div class="text-xs font-semibold text-[var(--color-tron-text-secondary)]">Answer</div>
							<div class="mt-0.5 whitespace-pre-wrap text-xs text-[var(--color-tron-text-secondary)]">{truncate(r.answer, 600)}</div>
						</div>
						{#if r.comment}
							<div class="mt-2 rounded border border-[var(--color-tron-yellow)]/40 bg-[var(--color-tron-yellow)]/10 p-2">
								<div class="text-xs font-semibold text-[var(--color-tron-yellow)]">Operator comment</div>
								<div class="mt-0.5 text-xs text-[var(--color-tron-text)]">{r.comment}</div>
							</div>
						{/if}
						{#if r.toolsUsed.length > 0}
							<div class="mt-2 flex flex-wrap gap-1">
								{#each r.toolsUsed as tool (tool)}
									<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-tron-text-secondary)]">{tool}</span>
								{/each}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</section>

	<!-- All ratings feed for context -->
	{#if data.recentAll.length > 0}
		<section>
			<h2 class="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">All recent ratings</h2>
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
				<table class="w-full text-xs">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] text-left text-[var(--color-tron-text-secondary)]">
							<th class="px-3 py-2 font-mono">When</th>
							<th class="px-3 py-2 font-mono">Who</th>
							<th class="px-3 py-2 font-mono">Rating</th>
							<th class="px-3 py-2 font-mono">Confidence</th>
							<th class="px-3 py-2 font-mono">Question</th>
						</tr>
					</thead>
					<tbody>
						{#each data.recentAll as r (r._id)}
							<tr class="border-b border-[var(--color-tron-border)]">
								<td class="px-3 py-1.5 font-mono text-[10px] text-[var(--color-tron-text-secondary)]">{fmtTime(r.timestamp)}</td>
								<td class="px-3 py-1.5 text-[var(--color-tron-text)]">{r.username}</td>
								<td class="px-3 py-1.5">
									<span class="rounded px-1.5 py-0.5 font-mono text-[10px] {r.rating === 'up' ? 'bg-emerald-500 text-emerald-50' : 'bg-red-500 text-red-50'}">
										{r.rating === 'up' ? '👍' : '👎'} {r.rating}
									</span>
								</td>
								<td class="px-3 py-1.5">
									{#if r.confidence}
										<span class="rounded px-1.5 py-0.5 font-mono text-[10px] {confidenceColor(r.confidence)}">{r.confidence}</span>
									{:else}
										<span class="text-[var(--color-tron-text-secondary)]">—</span>
									{/if}
								</td>
								<td class="px-3 py-1.5 text-[var(--color-tron-text-secondary)]">{truncate(r.question, 80)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}
</div>
