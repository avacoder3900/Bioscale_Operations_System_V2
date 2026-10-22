<script lang="ts">
	/**
	 * ARM-09 — the verified run as it happens: which chunk is playing, which
	 * step is being checked, each step's verdict, and where/why it stopped.
	 * The run itself is driven by `VerifiedRun` (verified-run.svelte.ts).
	 */
	import VisionStage, { type StageTag } from './VisionStage.svelte';
	import { friendlyName } from '$lib/robot-arm/animation';
	import type { VerifiedRun } from '$lib/robot-arm/verified-run.svelte';

	interface Props {
		vr: VerifiedRun;
	}
	let { vr }: Props = $props();

	const run = $derived(vr.run);
	const resultByStep = $derived(new Map((run?.results ?? []).map((r) => [r.step, r])));
	const latest = $derived(run?.results.length ? run.results[run.results.length - 1] : null);
	const failed = $derived(run?.failure ? (resultByStep.get(run.failure.step) ?? null) : null);
	const shown = $derived(failed ?? latest);
	const stageTags = $derived<StageTag[]>(
		(shown?.markers ?? []).map((m) => ({ key: String(m.tagId), label: `${m.name}${m.offMm != null ? ` ${m.offMm.toFixed(1)} mm` : ''}`, corners: null, center: null, status: m.status === 'ok' ? 'ok' : m.status === 'missing' ? 'missing' : 'moved' }))
	);

	const STATUS: Record<string, { label: string; color: string }> = {
		running: { label: 'RUNNING', color: '#4ade80' },
		passed: { label: 'PASSED', color: '#4ade80' },
		failed: { label: 'FAILED', color: '#ef4444' },
		stopped: { label: 'STOPPED', color: '#fbbf24' },
		error: { label: 'ERROR', color: '#ef4444' }
	};

	function stepState(i: number): { glyph: string; color: string; title: string } {
		if (!run) return { glyph: '○', color: 'var(--color-tron-text-secondary)', title: '' };
		const s = run.steps[i];
		const r = resultByStep.get(i);
		if (r) return r.passed ? { glyph: '✓', color: '#4ade80', title: r.message } : { glyph: '✗', color: '#ef4444', title: r.message };
		const c = run.chunks[run.cursor.chunk];
		const inChunk = !!c && i >= c.from && i <= c.to;
		if (run.status === 'running' && inChunk) return run.cursor.phase === 'verify' && c.verifyStep === i ? { glyph: '◉', color: '#fbbf24', title: 'checking' } : { glyph: '●', color: '#4ade80', title: 'playing' };
		if (!s.verify) return { glyph: '·', color: 'var(--color-tron-text-secondary)', title: 'not checked' };
		return { glyph: '○', color: 'var(--color-tron-text-secondary)', title: 'to check' };
	}

	const phaseText = $derived.by(() => {
		if (!run || run.status !== 'running') return '';
		const c = run.chunks[run.cursor.chunk];
		if (!c) return '';
		const label = c.verifyStep != null ? `to "${friendlyName(run.steps[c.verifyStep].name)}"` : `steps ${c.from + 1}–${c.to + 1}`;
		if (run.cursor.phase === 'play') return `Starting the move ${label}…`;
		if (run.cursor.phase === 'playing') return `Moving ${label} · ${vr.elapsedS.toFixed(0)} / ${(run.playing?.durationS ?? 0).toFixed(1)} s`;
		if (run.cursor.phase === 'verify') return `Checking "${friendlyName(run.steps[c.verifyStep ?? c.to].name)}" with the camera…`;
		return '';
	});

	const btn = 'min-h-[36px] rounded px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40';
	const red = 'background: rgba(239,68,68,0.15); color: #fca5a5; border: 1px solid #ef4444;';
	const muted = 'color: var(--color-tron-text-secondary)';
</script>

{#if run || vr.error || vr.busy}
	{@const st = run ? (STATUS[run.status] ?? { label: run.status, color: '#fbbf24' }) : null}
	<div class="rounded border p-3 text-sm sm:p-4" style="border-color: {st?.color ?? 'var(--color-tron-border)'}; background: var(--color-tron-surface);">
		<div class="flex flex-wrap items-center gap-3">
			<span class="font-semibold" style="color: var(--color-tron-text)">Verified run{run ? `: ${friendlyName(run.name)}` : ''}</span>
			{#if st}<span class="rounded px-2 py-0.5 text-[11px] font-semibold" style="background: rgba(0,0,0,0.3); color: {st.color}">{st.label}</span>{/if}
			{#if run}<span class="text-xs" style={muted}>{run.passedSteps} / {run.verifiedSteps} checks passed · camera {run.cameraName}</span>{/if}
			<span class="grow"></span>
			{#if run?.status === 'running'}
				<button type="button" class={btn} style={red} onclick={() => vr.stop()} disabled={vr.busy && !vr.active}>Stop</button>
			{:else if run}
				<button type="button" class="text-xs underline" style={muted} onclick={() => vr.clear()}>close</button>
			{/if}
		</div>

		{#if vr.error}<p class="mt-2 text-xs text-red-300">{vr.error}</p>{/if}
		{#if vr.stopNote}<p class="mt-2 text-xs" style="color: #fbbf24">{vr.stopNote}</p>{/if}
		{#if run?.error}<p class="mt-2 text-xs text-red-300">{run.error}</p>{/if}
		{#if phaseText}<p class="mt-2 text-xs" style="color: #4ade80">{phaseText}</p>{/if}

		{#if run?.failure}
			<div class="mt-2 rounded border border-red-500/50 bg-red-900/15 p-2 text-xs text-red-200">
				Stopped at step {run.failure.step + 1}: {run.failure.message} The arm is holding where it stopped (torque on). Nothing retries — fix the pose or its tolerances and run again.
			</div>
		{:else if run?.status === 'passed'}
			<p class="mt-2 text-xs" style="color: #4ade80">Every checked step landed where its reference says.</p>
		{/if}

		{#if run}
			<div class="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
				<ol class="space-y-0.5 text-xs">
					{#each run.steps as s, i (i)}
						{@const g = stepState(i)}
						{@const r = resultByStep.get(i)}
						<li class="flex items-start gap-2" title={g.title}>
							<span class="w-4 text-center font-mono" style="color: {g.color}">{g.glyph}</span>
							<span class="w-5 font-mono" style={muted}>{i + 1}</span>
							<span class="min-w-0 flex-1">
								<span style="color: var(--color-tron-text)">{friendlyName(s.name)}</span>
								{#if s.verify && s.tolerances}<span class="font-mono" style={muted}> · {s.tolerances.positionMm} mm / {s.tolerances.angleDeg}° / {s.tolerances.steps} st</span>{/if}
								{#if r}
									<span class="block" style="color: {r.passed ? 'var(--color-tron-text-secondary)' : '#fca5a5'}">
										{r.passed ? `landed — encoders within ${r.residualMax ?? '?'} step(s)${r.markers.length ? `, ${r.markers.filter((m) => m.status === 'ok').length}/${r.markers.length} tags ok` : ''}` : r.message}
									</span>
								{/if}
							</span>
						</li>
					{/each}
				</ol>
				{#if shown?.snapshotDataUrl}
					<div>
						<VisionStage src={shown.snapshotDataUrl} width={1920} height={1080} tags={stageTags} alt="Camera at the last check" />
						<p class="mt-1 text-[11px]" style={muted}>Camera at step {shown.step + 1}{shown.elapsedMs != null ? ` · check took ${(shown.elapsedMs / 1000).toFixed(1)} s` : ''}</p>
					</div>
				{/if}
			</div>
			{#if run.warnings.length}<p class="mt-2 text-xs" style="color: #f59e0b">{[...new Set(run.warnings)].join(' ')}</p>{/if}
		{/if}
	</div>
{/if}
