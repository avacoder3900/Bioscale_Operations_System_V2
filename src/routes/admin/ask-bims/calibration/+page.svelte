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
</script>

<div class="space-y-6">
	<header>
		<h1 class="text-xl font-semibold text-[var(--color-tron-text)]">Ask BIMS — Confidence calibration</h1>
		<p class="text-sm text-[var(--color-tron-text-secondary)]">
			Cross-tabs every recent answer's confidence badge against the operator's thumbs feedback.
			If high-confidence answers get thumbs-down above {data.threshold}%, the inference rule
			(<code class="text-[var(--color-tron-cyan)]">inferConfidence</code> in <code>ask-bims.ts</code>) is mis-calibrated and needs tuning.
		</p>
		<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">
			Analyzed {data.analyzedCount} of the last {data.sampleSize} conversations. Generated {fmtTime(data.generatedAt)}.
		</p>
	</header>

	<!-- Verdict banner -->
	{#if data.insufficient}
		<div class="rounded-lg border border-[var(--color-tron-yellow)]/40 bg-[var(--color-tron-yellow)]/10 p-4">
			<div class="text-sm font-semibold text-[var(--color-tron-yellow)]">Not enough rated answers yet</div>
			<div class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
				Need at least 10 rated high-confidence answers for a stable signal — currently {data.matrix.high.up + data.matrix.high.down}.
				Sweep the feedback queue once that threshold is hit.
			</div>
		</div>
	{:else if data.miscalibrated}
		<div class="rounded-lg border-2 border-red-500 bg-red-500/10 p-4">
			<div class="text-sm font-semibold text-red-400">⚠ Miscalibrated: high-confidence answers drew thumbs-down {data.highDownPct}% of the time</div>
			<div class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
				Threshold is &lt;{data.threshold}%. Tune <code>inferConfidence</code> — the conditions that currently classify these as high need a stricter check. See the sample failures and reason hints below.
			</div>
		</div>
	{:else}
		<div class="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4">
			<div class="text-sm font-semibold text-emerald-400">✓ Calibrated: high-confidence answers got thumbs-down {data.highDownPct}% of the time</div>
			<div class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
				Under the {data.threshold}% threshold. No tuning action required from this sweep.
			</div>
		</div>
	{/if}

	<!-- Cross-tab -->
	<section>
		<h2 class="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Confidence × feedback</h2>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<table class="w-full text-xs">
				<thead>
					<tr class="text-left text-[var(--color-tron-text-secondary)]">
						<th class="pb-2 font-mono">Confidence</th>
						<th class="pb-2 text-right font-mono">Total</th>
						<th class="pb-2 text-right font-mono text-emerald-400">👍 Up</th>
						<th class="pb-2 text-right font-mono text-red-400">👎 Down</th>
						<th class="pb-2 text-right font-mono text-amber-400">🚩 Flagged</th>
						<th class="pb-2 text-right font-mono">Unrated</th>
						<th class="pb-2 text-right font-mono">Down rate</th>
					</tr>
				</thead>
				<tbody>
					{#each ['high', 'partial', 'degraded', 'unknown'] as bucket (bucket)}
						{@const m = data.matrix[bucket]}
						{@const rated = m.up + m.down}
						{@const downPct = rated > 0 ? Math.round((m.down / rated) * 1000) / 10 : 0}
						<tr class="border-t border-[var(--color-tron-border)]">
							<td class="py-1.5 font-mono">
								<span
									class="rounded px-1.5 py-0.5 text-[10px] font-semibold"
									class:bg-emerald-500={bucket === 'high'}
									class:text-emerald-50={bucket === 'high'}
									class:bg-yellow-500={bucket === 'partial'}
									class:text-yellow-50={bucket === 'partial'}
									class:bg-red-500={bucket === 'degraded'}
									class:text-red-50={bucket === 'degraded'}
									class:bg-gray-600={bucket === 'unknown'}
									class:text-gray-50={bucket === 'unknown'}
								>{bucket}</span>
							</td>
							<td class="py-1.5 text-right font-mono text-[var(--color-tron-text)]">{m.total}</td>
							<td class="py-1.5 text-right font-mono text-emerald-400">{m.up}</td>
							<td class="py-1.5 text-right font-mono text-red-400">{m.down}</td>
							<td class="py-1.5 text-right font-mono text-amber-400">{m.flagged}</td>
							<td class="py-1.5 text-right font-mono text-[var(--color-tron-text-secondary)]">{m.unrated}</td>
							<td class="py-1.5 text-right font-mono {downPct > data.threshold ? 'text-red-400' : 'text-[var(--color-tron-text-secondary)]'}">{rated > 0 ? `${downPct}%` : '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	<!-- Reason hints — which confidenceReasons recur on high+down failures -->
	{#if data.topReasonsOnFailures.length > 0}
		<section>
			<h2 class="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
				Reasons recurring on high-confidence + thumbs-down answers
			</h2>
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
				<p class="mb-2 text-xs text-[var(--color-tron-text-secondary)]">
					These confidence reasons are firing on answers that the operator said were wrong.
					Each is a candidate for tightening — likely the rule misses an integrity signal it should have caught.
				</p>
				<table class="w-full text-xs">
					<thead>
						<tr class="text-left text-[var(--color-tron-text-secondary)]">
							<th class="pb-2 font-mono">Reason</th>
							<th class="pb-2 text-right font-mono">Count</th>
						</tr>
					</thead>
					<tbody>
						{#each data.topReasonsOnFailures as r (r.reason)}
							<tr class="border-t border-[var(--color-tron-border)]">
								<td class="py-1.5 font-mono text-[var(--color-tron-text)]">{r.reason}</td>
								<td class="py-1.5 text-right font-mono text-red-400">{r.count}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}

	<!-- Sample high + down failures -->
	{#if data.highWithDowns.length > 0}
		<section>
			<h2 class="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
				Sample high-confidence answers rated thumbs-down ({data.highWithDowns.length})
			</h2>
			<div class="space-y-3">
				{#each data.highWithDowns as s (s.responseId)}
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-xs">
						<div class="flex items-center justify-between text-[10px] text-[var(--color-tron-text-secondary)]">
							<span class="font-mono">{fmtTime(s.timestamp)}</span>
							<span class="font-mono">{s.toolCallCount} tool{s.toolCallCount === 1 ? '' : 's'}</span>
						</div>
						<div class="mt-1 font-semibold text-[var(--color-tron-text)]">Q: {truncate(s.question, 240)}</div>
						<div class="mt-1 text-[var(--color-tron-text-secondary)]">A: {truncate(s.answer, 320)}</div>
						{#if s.comment}
							<div class="mt-1 rounded bg-red-500/10 px-2 py-1 text-[var(--color-tron-text)]">
								<span class="font-semibold text-red-400">Operator:</span> {s.comment}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</section>
	{/if}
</div>
