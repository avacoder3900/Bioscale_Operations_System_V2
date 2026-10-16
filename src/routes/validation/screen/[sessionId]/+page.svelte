<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard, TronBadge } from '$lib/components/ui';
	import ScreenReportTable from '$lib/components/validation/screen/ScreenReportTable.svelte';

	let { data, form } = $props();
	const s = $derived(data.session);
	let verdict = $state('accepted');
	const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
	const CH_COLOR: Record<string, string> = { A: 'var(--color-tron-cyan)', B: 'var(--color-tron-orange)', C: 'var(--color-tron-purple)' };
	const W = 640, H = 160, P = { l: 36, r: 8, t: 8, b: 20 };
	function trace(rec: any, field: number) {
		const all = rec.trace.flatMap((t: any) => t.pts.map((p: number[]) => p[field]));
		const hi = Math.max(1, ...all);
		const n = Math.max(1, ...rec.trace.flatMap((t: any) => t.pts.map((p: number[]) => p[0])));
		const X = (i: number) => P.l + (i / n) * (W - P.l - P.r);
		const Y = (v: number) => P.t + (1 - v / hi) * (H - P.t - P.b);
		return { hi, lines: rec.trace.map((t: any) => ({ ch: t.ch, d: t.pts.map((p: number[], i: number) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[field]).toFixed(1)}`).join(' ') })) };
	}
</script>

<div class="space-y-6">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Screen — {s.spuUdi ?? s.particleDeviceId}</h1>
			<p class="tron-text-muted mt-1 text-sm">
				fw {s.fw ?? '—'} · run {s.run ?? '—'} · started {when(s.startedAt)} · {s.complete ? `completed ${when(s.completedAt)}` : 'still running'}
				{#if s.summary}· device total {(s.summary.ms / 60000).toFixed(1)} min · levels {s.summary.levels} · ×{s.summary.reps}{/if}
			</p>
		</div>
		<div class="flex items-center gap-2">
			{#if s.complete}
				<TronBadge variant={s.overallPassed ? 'success' : 'error'}>{s.overallPassed ? 'PASS' : 'FAIL'}</TronBadge>
			{:else}
				<TronBadge variant="warning">running</TronBadge>
			{/if}
			<a href="/validation/screen?udi={encodeURIComponent(s.spuUdi ?? '')}" class="text-sm text-[var(--color-tron-cyan)] hover:underline">unit history →</a>
			{#if s.spuId}<a href="/spu/{s.spuId}" class="text-sm text-[var(--color-tron-cyan)] hover:underline">unit →</a>{/if}
		</div>
	</div>

	<div class="grid gap-3 sm:grid-cols-5">
		{#each [['pass', 'Pass'], ['fail', 'Fail'], ['warn', 'Warn'], ['skip', 'Skip'], ['info', 'Info']] as [k, label] (k)}
			<TronCard>
				<div class="tron-text-muted text-[10px] uppercase">{label}</div>
				<div class="text-2xl font-bold {k === 'fail' && s.counts[k] ? 'text-[var(--color-tron-red)]' : k === 'warn' && s.counts[k] ? 'text-[var(--color-tron-orange)]' : 'text-[var(--color-tron-cyan)]'}">{s.counts[k]}</div>
			</TronCard>
		{/each}
	</div>

	{#if s.failureReasons.length}
		<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-sm text-[var(--color-tron-red)]">
			<div class="font-semibold">Failures</div>
			<ul class="mt-1 list-disc pl-5">{#each s.failureReasons as r}<li>{r}</li>{/each}</ul>
		</div>
	{/if}

	<!-- Review sign-off: a person read the full report and concluded something. -->
	<TronCard>
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div>
				<h3 class="tron-text-primary text-lg font-medium">Review</h3>
				{#if s.review}
					<p class="mt-1 text-sm">
						<TronBadge variant={s.review.verdict === 'accepted' ? 'success' : s.review.verdict === 'rejected' ? 'error' : 'warning'}>{s.review.verdict}</TronBadge>
						<span class="tron-text-muted ml-2">by {s.review.by?.username ?? '?'} · {when(s.review.at)}</span>
					</p>
					{#if s.review.notes}<p class="tron-text-muted mt-1 whitespace-pre-wrap text-sm">{s.review.notes}</p>{/if}
				{:else}
					<p class="tron-text-muted mt-1 text-sm">Not reviewed yet. Read the {s.rows.length} rows below, then sign off. The device's own verdict ({s.overallPassed === null ? 'pending' : s.overallPassed ? 'pass' : 'fail'}) is not changed by this; it records what a person concluded.</p>
				{/if}
				{#if form?.error}<p class="mt-2 text-sm text-[var(--color-tron-red)]">{form.error}</p>{/if}
				{#if form?.reviewed}<p class="mt-2 text-sm text-[var(--color-tron-cyan)]">Recorded: {form.reviewed}.</p>{/if}
			</div>
			<form method="POST" action="?/review" use:enhance class="flex w-full max-w-xl flex-col gap-2 sm:w-auto">
				<div class="flex flex-wrap gap-3 text-sm">
					{#each [['accepted', 'Accept'], ['rejected', 'Reject'], ['rerun', 'Re-run']] as [v, label] (v)}
						<label class="inline-flex items-center gap-1"><input type="radio" name="verdict" value={v} bind:group={verdict} /> {label}</label>
					{/each}
				</div>
				<textarea name="notes" rows="2" class="tron-input w-full text-sm" placeholder={verdict === 'accepted' ? 'Notes (optional)' : 'Why? (required)'}></textarea>
				<div class="flex gap-2">
					<button type="submit" class="tron-btn-primary text-sm">{s.review ? 'Update review' : 'Sign off'}</button>
					{#if s.review}
						<button type="submit" formaction="?/clearReview" class="tron-text-muted text-sm hover:underline">clear</button>
					{/if}
				</div>
			</form>
		</div>
	</TronCard>

	<TronCard>
		<h3 class="tron-text-primary mb-1 text-lg font-medium">Full report — every row the device sent</h3>
		<p class="tron-text-muted mb-3 text-xs">
			Rows are numbered in the order the device ran them. Repeated tests carry their rep number; level 2 rows carry
			the run number. Values are raw device units (°C×10, µm, ms, counts) — hover a level number for its name,
			and read the last two columns for what a row measures and how it is judged.
		</p>
		<ScreenReportTable rows={s.rows} levels={s.levels} sessionId={s.id} confirms={s.operatorConfirms} />
	</TronCard>

	{#if data.records.length}
		<TronCard>
			<h3 class="tron-text-primary mb-2 text-lg font-medium">Assay motion runs — empty-slot background records</h3>
			<p class="tron-text-muted mb-3 text-xs">Each level-2 run is the full production assay with no cartridge; its record is the unit's background spectrum under assay timing. Clear band per reading, channels A/B/C.</p>
			<div class="space-y-4">
				{#each data.records as rec (rec.runIndex)}
					{@const t = trace(rec, 1)}
					<div>
						<div class="mb-1 flex flex-wrap gap-4 text-xs">
							<span class="tron-text-primary font-semibold">Run {rec.runIndex}</span>
							<span class="tron-text-muted">assay {rec.assayId} · {rec.durationS} s · {rec.numberOfReadings} readings</span>
							{#if rec.stageCheck}
								<span class="font-mono" title="expected − measured at the end-of-test home">stage error {rec.stageCheck.endErrorUm} µm · hits {rec.stageCheck.limitHits}{rec.stageCheck.travelUm != null ? ` · travel ${(rec.stageCheck.travelUm / 1000).toFixed(1)} mm` : ''}{rec.stageCheck.homeMs != null ? ` · home ${rec.stageCheck.homeMs} ms` : ''}{rec.stageCheck.hitMs?.length ? ` · hits at ${rec.stageCheck.hitMs.join(', ')} ms` : ''}</span>
							{/if}
							{#if rec.background}
								<span class="font-mono tron-text-muted">clear A/B/C {rec.background.A?.clear ?? '—'} / {rec.background.B?.clear ?? '—'} / {rec.background.C?.clear ?? '—'}</span>
							{/if}
						</div>
						<svg viewBox="0 0 {W} {H}" class="w-full max-w-3xl" role="img" aria-label="Clear band per reading">
							<line x1={P.l} x2={W - P.r} y1={H - P.b} y2={H - P.b} stroke="var(--color-tron-border)" />
							<text x={P.l - 4} y={P.t + 8} font-size="10" text-anchor="end" fill="var(--color-tron-text-secondary)" font-family="monospace">{t.hi}</text>
							{#each t.lines as l (l.ch)}<path d={l.d} fill="none" stroke={CH_COLOR[l.ch]} stroke-width="1.5" />{/each}
						</svg>
					</div>
				{/each}
			</div>
		</TronCard>
	{/if}
</div>
