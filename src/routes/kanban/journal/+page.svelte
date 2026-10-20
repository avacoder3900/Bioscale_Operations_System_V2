<script lang="ts">
	/**
	 * VOICE-01 — Journal: Claude-written digests of spoken voice memos. Read-only;
	 * digests are filed over MCP (voice_memo_digest_write). The digest HTML is
	 * rendered server-side by an escape-first renderer (voice-memos/markdown.ts).
	 */
	let { data } = $props();

	const fmtDay = (d: string) =>
		new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
	const fmtTime = (d: string) =>
		new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	const kindLabel = (m: { kind: string; experimentRef: string | null }) =>
		m.kind === 'experiment' ? `Exp ${m.experimentRef ?? ''}`.trim() : 'EOD';
</script>

<svelte:head><title>Journal — Kanban</title></svelte:head>

<div class="space-y-4">
	<p class="text-xs tron-text-muted">
		Digests of spoken end-of-day and experiment memos from the Voicenotes app. Claude writes them from the
		recordings plus what BIMS knows (tasks, lots, devices) via
		<span class="font-mono text-[var(--color-tron-cyan)]">voice_memo_digest_write</span>. Ask it to
		"process my EODs" to turn new memos into a digest.
	</p>

	{#if data.pending.length}
		<details class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
			<summary class="cursor-pointer px-4 py-2 text-sm tron-text-primary">
				<span class="font-bold">{data.pending.length}{data.pending.length === 50 ? '+' : ''}</span>
				memo{data.pending.length === 1 ? '' : 's'} waiting for a digest
			</summary>
			<div class="divide-y divide-[var(--color-tron-border)] border-t border-[var(--color-tron-border)]">
				{#each data.pending as m (m.id)}
					<div class="flex flex-wrap items-center gap-2 px-4 py-1.5 text-xs">
						<span class="font-mono tron-text-muted">{fmtTime(m.recordedAt)}</span>
						<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[10px] uppercase tron-text-muted">{kindLabel(m)}</span>
						<span class="tron-text-primary">{m.title ?? '(untitled)'}</span>
						<span class="tron-text-muted">· {m.speaker}</span>
					</div>
				{/each}
			</div>
		</details>
	{/if}

	{#if data.days.length === 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-6 text-sm tron-text-muted">
			No digests yet.
		</div>
	{:else}
		{#each data.days as day (day.date)}
			<section id={day.date} class="space-y-3">
				<h2 class="tron-text-primary text-sm font-bold uppercase tracking-wide">{fmtDay(day.date)}</h2>
				{#each day.digests as d (d.id)}
					<article class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
						<header class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-tron-border)] px-4 py-2">
							<span class="tron-text-primary text-sm font-bold">{d.title}</span>
							<span class="text-xs tron-text-muted">
								{d.speakers.join(', ')}
								{#if d.version > 1}· v{d.version}{/if}
								· written by {d.authoredBy} via Claude
							</span>
						</header>

						<div class="digest-body px-4 py-3 text-sm tron-text-primary">
							{@html d.html}
						</div>

						{#if d.sources.length}
							<details class="border-t border-[var(--color-tron-border)]">
								<summary class="cursor-pointer px-4 py-1.5 text-xs tron-text-muted">
									Source: {d.sources.length} voice memo{d.sources.length === 1 ? '' : 's'}
								</summary>
								<div class="space-y-3 px-4 pb-3">
									{#each d.sources as s (s.id)}
										<div class="text-xs">
											<div class="flex flex-wrap items-center gap-2 tron-text-muted">
												<span class="font-mono">{fmtTime(s.recordedAt)}</span>
												<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[10px] uppercase">{kindLabel(s)}</span>
												<span class="tron-text-primary">{s.title ?? '(untitled)'}</span>
												<span>· {s.speaker}</span>
												{#if s.deletedInVoicenotes}<span class="text-yellow-300">· deleted in Voicenotes</span>{/if}
											</div>
											{#if s.transcript !== null}
												<p class="mt-1 whitespace-pre-wrap leading-relaxed tron-text-muted">{s.transcript}</p>
											{:else}
												<p class="mt-1 italic tron-text-muted">Transcript visible to the speaker only.</p>
											{/if}
										</div>
									{/each}
								</div>
							</details>
						{/if}
					</article>
				{/each}
			</section>
		{/each}
	{/if}
</div>

<style>
	.digest-body :global(.md-h1),
	.digest-body :global(.md-h2),
	.digest-body :global(.md-h3) {
		font-weight: 700;
		margin: 0.75rem 0 0.25rem;
		color: var(--color-tron-cyan);
	}
	.digest-body :global(.md-h1) {
		font-size: 1rem;
	}
	.digest-body :global(.md-h2) {
		font-size: 0.9rem;
	}
	.digest-body :global(.md-h3) {
		font-size: 0.85rem;
	}
	.digest-body :global(:first-child) {
		margin-top: 0;
	}
	.digest-body :global(.md-p) {
		margin: 0.4rem 0;
		line-height: 1.55;
	}
	.digest-body :global(.md-ul),
	.digest-body :global(.md-ol) {
		margin: 0.3rem 0 0.5rem 1.25rem;
		line-height: 1.5;
	}
	.digest-body :global(.md-ul) {
		list-style: disc;
	}
	.digest-body :global(.md-ol) {
		list-style: decimal;
	}
	.digest-body :global(.md-link) {
		color: var(--color-tron-cyan);
		text-decoration: underline;
	}
	.digest-body :global(.md-code) {
		font-family: ui-monospace, monospace;
		font-size: 0.8em;
		padding: 0 0.25rem;
		border-radius: 0.25rem;
		background: var(--color-tron-bg-tertiary);
	}
</style>
