<script lang="ts">
	import type { PageData } from './$types';

	interface Props { data: PageData }
	let { data }: Props = $props();

	function fmt(n: number): string {
		return `$${n.toFixed(4)}`;
	}
	function fmtCompact(n: number): string {
		if (n >= 100) return `$${n.toFixed(0)}`;
		return `$${n.toFixed(2)}`;
	}

	const maxDailyCost = $derived(Math.max(...data.last7d.daily.map(d => d.costUsd), 0.01));
</script>

<div class="space-y-6">
	<header>
		<h1 class="text-xl font-semibold text-[var(--color-tron-text)]">Ask BIMS — Cost</h1>
		<p class="text-sm text-[var(--color-tron-text-secondary)]">
			All-time and rolling spend on Anthropic API. No question/answer text is logged here — only telemetry.
		</p>
	</header>

	<!-- Headline numbers -->
	<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Today</div>
			<div class="mt-1 font-mono text-2xl text-[var(--color-tron-cyan)]">{fmtCompact(data.today.totalUsd)}</div>
			<div class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
				{data.today.byUser.reduce((s, u) => s + u.queries, 0)} queries · {data.today.byUser.length} users
			</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Last 7 days</div>
			<div class="mt-1 font-mono text-2xl text-[var(--color-tron-cyan)]">{fmtCompact(data.last7d.totalUsd)}</div>
			<div class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
				{data.last7d.daily.reduce((s, d) => s + d.queries, 0)} queries
			</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Last 30 days</div>
			<div class="mt-1 font-mono text-2xl text-[var(--color-tron-cyan)]">{fmtCompact(data.last30d.totalUsd)}</div>
			<div class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
				{data.last30d.queries} queries
			</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Projected monthly</div>
			<div class="mt-1 font-mono text-2xl text-[var(--color-tron-yellow)]">{fmtCompact(data.projectedMonthlyUsd)}</div>
			<div class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">7-day rolling × 30/7</div>
		</div>
	</div>

	<!-- Daily caps -->
	<section>
		<h2 class="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Daily caps (resets midnight UTC)</h2>
		<div class="space-y-2 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<!-- Workspace cap -->
			<div>
				<div class="flex items-center justify-between text-xs">
					<span class="font-mono text-[var(--color-tron-text)]">Workspace (all users)</span>
					<span class="font-mono text-[var(--color-tron-text-secondary)]">{fmt(data.caps.workspaceSpentToday)} / {fmtCompact(data.caps.workspaceUsd)}</span>
				</div>
				<div class="mt-1 h-2 overflow-hidden rounded bg-[var(--color-tron-bg-tertiary)]">
					<div
						class="h-full transition-all {data.caps.workspacePct >= 80 ? 'bg-[var(--color-tron-red)]' : data.caps.workspacePct >= 50 ? 'bg-[var(--color-tron-yellow)]' : 'bg-[var(--color-tron-cyan)]'}"
						style="width: {Math.min(data.caps.workspacePct, 100)}%"
					></div>
				</div>
			</div>

			<!-- Per-model caps -->
			{#each data.caps.perModel as cap (cap.model)}
				<div>
					<div class="flex items-center justify-between text-xs">
						<span class="font-mono text-[var(--color-tron-text)]">{cap.model.replace('claude-', '')} (per user, today)</span>
						<span class="font-mono text-[var(--color-tron-text-secondary)]">{fmt(cap.spent)} / {fmtCompact(cap.cap)}</span>
					</div>
					<div class="mt-1 h-1.5 overflow-hidden rounded bg-[var(--color-tron-bg-tertiary)]">
						<div
							class="h-full transition-all {cap.pct >= 80 ? 'bg-[var(--color-tron-red)]' : cap.pct >= 50 ? 'bg-[var(--color-tron-yellow)]' : 'bg-[var(--color-tron-cyan)]'}"
							style="width: {Math.min(cap.pct, 100)}%"
						></div>
					</div>
				</div>
			{/each}
		</div>
	</section>

	<!-- 7-day daily trend -->
	<section>
		<h2 class="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Last 7 days — daily spend</h2>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			{#if data.last7d.daily.length === 0}
				<p class="text-sm text-[var(--color-tron-text-secondary)]">No telemetry yet. Run a few questions to populate this.</p>
			{:else}
				<div class="space-y-1">
					{#each data.last7d.daily as d (d.date)}
						<div class="flex items-center gap-3 text-xs">
							<span class="w-24 font-mono text-[var(--color-tron-text-secondary)]">{d.date}</span>
							<div class="h-4 flex-1 overflow-hidden rounded bg-[var(--color-tron-bg-tertiary)]">
								<div class="h-full bg-[var(--color-tron-cyan)]/60" style="width: {(d.costUsd / maxDailyCost) * 100}%"></div>
							</div>
							<span class="w-20 text-right font-mono text-[var(--color-tron-cyan)]">{fmt(d.costUsd)}</span>
							<span class="w-16 text-right font-mono text-[var(--color-tron-text-secondary)]">{d.queries}q</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</section>

	<!-- Per-model breakdown -->
	<section>
		<h2 class="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Last 7 days — by model</h2>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			{#if data.last7d.byModel.length === 0}
				<p class="text-sm text-[var(--color-tron-text-secondary)]">No data yet.</p>
			{:else}
				<table class="w-full text-xs">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] text-left text-[var(--color-tron-text-secondary)]">
							<th class="py-2">Model</th>
							<th class="py-2 text-right">Spend</th>
							<th class="py-2 text-right">Queries</th>
							<th class="py-2 text-right">$/query</th>
						</tr>
					</thead>
					<tbody>
						{#each data.last7d.byModel as r (r.model)}
							<tr class="border-b border-[var(--color-tron-border)]/40">
								<td class="py-2 font-mono">{r.model.replace('claude-', '')}</td>
								<td class="py-2 text-right font-mono text-[var(--color-tron-cyan)]">{fmt(r.costUsd)}</td>
								<td class="py-2 text-right font-mono">{r.queries}</td>
								<td class="py-2 text-right font-mono text-[var(--color-tron-text-secondary)]">{r.queries > 0 ? fmt(r.costUsd / r.queries) : '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>
	</section>

	<!-- Top users -->
	<section>
		<h2 class="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Last 7 days — top users</h2>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			{#if data.last7d.topUsers.length === 0}
				<p class="text-sm text-[var(--color-tron-text-secondary)]">No users yet.</p>
			{:else}
				<table class="w-full text-xs">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] text-left text-[var(--color-tron-text-secondary)]">
							<th class="py-2">User</th>
							<th class="py-2 text-right">Spend</th>
							<th class="py-2 text-right">Queries</th>
							<th class="py-2 text-right">$/query</th>
						</tr>
					</thead>
					<tbody>
						{#each data.last7d.topUsers as r, i (r.userId)}
							<tr class="border-b border-[var(--color-tron-border)]/40 {i === 0 ? 'text-[var(--color-tron-text)]' : ''}">
								<td class="py-2">{r.username}</td>
								<td class="py-2 text-right font-mono text-[var(--color-tron-cyan)]">{fmt(r.costUsd)}</td>
								<td class="py-2 text-right font-mono">{r.queries}</td>
								<td class="py-2 text-right font-mono text-[var(--color-tron-text-secondary)]">{r.queries > 0 ? fmt(r.costUsd / r.queries) : '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>
	</section>

	<footer class="border-t border-[var(--color-tron-border)] pt-4 text-xs text-[var(--color-tron-text-secondary)]">
		<p>
			Caps configurable via env vars: <span class="font-mono">ASK_BIMS_DAILY_CAP_HAIKU_USD</span>,
			<span class="font-mono">ASK_BIMS_DAILY_CAP_SONNET_USD</span>,
			<span class="font-mono">ASK_BIMS_DAILY_CAP_OPUS_USD</span>,
			<span class="font-mono">ASK_BIMS_DAILY_CAP_WORKSPACE_USD</span>.
		</p>
		<p class="mt-1">Bedrock guardrail: set a hard monthly cap in the Anthropic console.</p>
	</footer>
</div>
