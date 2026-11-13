<!--
  Diluent filling wizard (DILUENT-FILL-1, 2026-11-13). One component for the
  diluent-filling setup page (mode 'setup'), the Robots-page panel while a run
  is being set up (mode 'panel') and the panel while the robot is running
  (mode 'run'). `data` is loadDiluentWizard()'s result; every action posts to
  the diluent-filling route explicitly (see `act`) because the wizard also
  renders on /robots.

  Stages: Setup (pipette, volume, three source tubes) → Loading (deck checklist,
  confirm, Start) → Running (robot controller, finish) → the run is Completed
  and the panel drops back to idle, showing the lot it produced.
-->
<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { deserialize } from '$app/forms';
	import ProtocolStartPanel from '$lib/components/manufacturing/ProtocolStartPanel.svelte';
	import EmbeddedRunController from '$lib/components/manufacturing/EmbeddedRunController.svelte';
	import { ROBOTS_PATH } from '$lib/manufacturing/robot-panels';
	import {
		DILUENT_PIPETTES,
		DILUENT_SOURCE_WELLS,
		DILUENT_DEST_SLOTS,
		DILUENT_TUBES_PER_RACK,
		DILUENT_MIN_VOLUME_UL,
		DILUENT_MAX_VOLUME_UL,
		diluentMinSourceUl,
		diluentTubesPerTrip,
		diluentRunTimeParameters,
		diluentTubesTotal,
		validateDiluentSetup,
		ulToMlUp,
		type DiluentPipette
	} from '$lib/manufacturing/diluent-fill';
	import type { DiluentWizardData } from '$lib/server/manufacturing/diluent-wizard';

	let { data, mode = 'setup', robotName = '' }: { data: DiluentWizardData; mode?: 'setup' | 'run' | 'panel'; robotName?: string } = $props();

	const ROUTE = '/manufacturing/cart-mfg/diluent-filling';
	const act = (name: string) => `${ROUTE}?/${name}&robot=${encodeURIComponent(data.robotId)}`;

	let errorMsg = $state('');
	let submitting = $state(false);
	let busyLabel = $state('');

	// ── setup form, seeded from the run (or the defaults) ──────────────────────
	const seed = $derived(data.run);
	let pipette = $state<DiluentPipette>('p1000');
	let volumeUl = $state(104.5);
	let tubesPerTrip = $state(8);
	let rows = $state(DILUENT_SOURCE_WELLS.map((well) => ({ well, lotId: '', tubes: 0, ml: 0 })));
	let seededFor = $state<string | null>(null);
	$effect(() => {
		// Re-seed when the run changes (new run, reload), never while the operator is typing.
		const key = seed ? `${seed.runId}:${seed.stage}` : 'none';
		if (seededFor === key) return;
		seededFor = key;
		pipette = seed?.pipette ?? data.defaults.pipette;
		volumeUl = seed?.diluentVolumeUl ?? data.defaults.volumeUl;
		tubesPerTrip = seed?.tubesPerTrip ?? DILUENT_PIPETTES[pipette].maxTubesPerTrip;
		rows = DILUENT_SOURCE_WELLS.map((well, i) => {
			const s = seed?.sources.find((x) => x.well === well);
			return { well, lotId: s?.reagentLotId ?? '', tubes: s?.tubesPlanned ?? (i === 0 ? 40 : 0), ml: s?.loadedMl ?? 0 };
		});
	});
	// A pipette change resets tubes-per-trip to that pipette's maximum.
	function onPipetteChange(p: DiluentPipette) {
		pipette = p;
		tubesPerTrip = DILUENT_PIPETTES[p].maxTubesPerTrip;
	}

	const setupModel = $derived({
		pipette,
		diluentVolumeUl: Number(volumeUl),
		tubesPerTrip: Number(tubesPerTrip),
		sources: rows.map((r) => ({ well: r.well, reagentLotId: r.lotId || null, tubesPlanned: Number(r.tubes) || 0, loadedMl: Number(r.ml) || 0 }))
	});
	const setupProblems = $derived(validateDiluentSetup(setupModel));
	const effectiveTubesPerTrip = $derived(diluentTubesPerTrip(pipette, Number(tubesPerTrip) || 1, Number(volumeUl) || 1));
	const rowMinMl = (tubes: number) => (tubes > 0 ? ulToMlUp(diluentMinSourceUl(pipette, tubes, Number(volumeUl) || 0)) : 0);
	const totalTubes = $derived(diluentTubesTotal(setupModel.sources));

	const stage = $derived(data.run?.stage ?? 'Setup');
	const run = $derived(data.run);
	const rtp = $derived(run ? diluentRunTimeParameters(run) : {});
	const robotFinished = $derived(!!run?.opentronsRunFinalStatus);
	let runFinishedLocal = $state(false);
	let robotStatus = $state('idle');

	// ── posting a route action (fields in, data or error out) ──────────────────
	async function post(action: string, fields: Record<string, string> | FormData, timeoutMs = 45_000): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
		const fd = fields instanceof FormData ? fields : new FormData();
		if (!(fields instanceof FormData)) for (const [k, v] of Object.entries(fields)) fd.set(k, v);
		if (!fd.has('robotId')) fd.set('robotId', data.robotId);
		try {
			const res = await fetch(act(action), { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' }, signal: AbortSignal.timeout(timeoutMs) });
			const result = deserialize(await res.text());
			if (result.type === 'success') return { ok: true, data: result.data ?? {} };
			if (result.type === 'failure') return { ok: false, error: String((result.data as any)?.error ?? `Action failed (HTTP ${res.status})`) };
			if (result.type === 'error') return { ok: false, error: result.error?.message ?? 'Action failed' };
			return { ok: false, error: `Action failed (HTTP ${res.status})` };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : 'Request failed' };
		}
	}

	async function run_(label: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
		if (submitting) return;
		submitting = true;
		busyLabel = label;
		errorMsg = '';
		try {
			const r = await fn();
			if (!r.ok) errorMsg = r.error ?? 'Action failed';
			await invalidateAll();
		} finally {
			submitting = false;
			busyLabel = '';
		}
	}

	// ── Setup ──────────────────────────────────────────────────────────────────
	async function saveSetup() {
		if (setupProblems.length) {
			errorMsg = setupProblems.join(' ');
			return;
		}
		await run_('Saving…', async () => {
			let runId = data.activeRunId;
			if (!runId) {
				const c = await post('createRun', { robotId: data.robotId, robotName });
				if (!c.ok) return c;
				runId = String(c.data?.runId ?? '');
			}
			const fields: Record<string, string> = { runId: runId ?? '', pipette, volumeUl: String(volumeUl), tubesPerTrip: String(tubesPerTrip) };
			rows.forEach((r, i) => {
				fields[`src_${i + 1}_lot`] = r.lotId;
				fields[`src_${i + 1}_tubes`] = String(r.tubes);
				fields[`src_${i + 1}_ml`] = String(r.ml);
			});
			return post('saveSetup', fields);
		});
	}

	// ── Loading ────────────────────────────────────────────────────────────────
	const backToSetup = () => run_('…', () => post('backToSetup', { runId: data.activeRunId ?? '' }));
	const confirmDeck = () => run_('…', () => post('confirmDeck', { runId: data.activeRunId ?? '' }));
	async function cancelSetup() {
		if (!confirm('Cancel this diluent run? Nothing has run on the robot yet.')) return;
		await run_('Cancelling…', () => post('cancelRun', { runId: data.activeRunId ?? '', reason: 'Cancelled during setup' }));
	}

	// Start: the ProtocolStartPanel hands us its FormData (hidden runId +
	// protocol + params); we post it to ?/startRun and stay on this page.
	async function startRun(fd: FormData) {
		fd.set('runId', data.activeRunId ?? '');
		await run_('Starting — the robot takes 15–90 s to create the run…', async () => {
			const r = await post('startRun', fd, 150_000);
			if (r.ok && mode === 'setup') await goto(ROBOTS_PATH, { noScroll: false });
			return r;
		});
	}

	// ── Running ────────────────────────────────────────────────────────────────
	async function recordRunFinished(status: string) {
		runFinishedLocal = true;
		const r = await post('recordRunFinished', { runId: data.activeRunId ?? '', finalStatus: status }, 90_000);
		if (!r.ok) errorMsg = r.error;
		await invalidateAll();
	}
	async function stopRun(action: 'cancel' | 'abort') {
		const reason = prompt(action === 'cancel' ? 'Cancel the run — why?' : 'Abort the run — what happened?') ?? '';
		if (reason === null) return;
		await run_(action === 'cancel' ? 'Cancelling…' : 'Aborting…', () => post(action === 'cancel' ? 'cancelRun' : 'abortRun', { runId: data.activeRunId ?? '', reason }, 90_000));
	}
	let filledCounts = $state<Record<string, string>>({});
	async function completeDespiteFailure() {
		const fields: Record<string, string> = { runId: data.activeRunId ?? '', confirmDespiteFailure: 'true' };
		for (const well of DILUENT_SOURCE_WELLS) fields[`filled_${well}`] = filledCounts[well] ?? '0';
		await run_('Completing…', () => post('completeRun', fields));
	}

	const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—');
	const lotLabel = (id: string) => {
		const l = data.reagentLots.find((x) => x.id === id);
		return l ? `${l.lotBarcode}${l.templateName ? ` — ${l.templateName}` : ''}` : id;
	};

	const input = 'w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1.5 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none disabled:opacity-60';
	const btnPrimary = 'min-h-[44px] rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50';
	const btnGhost = 'min-h-[40px] rounded-lg border border-[var(--color-tron-border)] px-3 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)] disabled:opacity-50';
	const btnDanger = 'min-h-[40px] rounded-lg border border-red-500/50 bg-red-900/20 px-3 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-900/40 disabled:opacity-50';
	const card = 'rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4';
</script>

{#if data.loadError}
	<p class="rounded border border-red-500/50 bg-red-900/20 p-3 text-sm text-red-200">{data.loadError}</p>
{/if}
{#if errorMsg}
	<div class="mb-3 flex items-start justify-between gap-2 rounded border border-red-500/50 bg-red-900/20 p-3 text-sm text-red-200">
		<span>{errorMsg}</span>
		<button type="button" class="text-xs underline" onclick={() => (errorMsg = '')}>dismiss</button>
	</div>
{/if}
{#if submitting && busyLabel}
	<p class="mb-3 text-xs text-[var(--color-tron-cyan)]">{busyLabel}</p>
{/if}

{#if mode === 'run' && stage !== 'Running'}
	<p class="text-sm text-[var(--color-tron-text-secondary)]">No diluent run is running on this robot.</p>

{:else if stage === 'Setup' || !run}
	<!-- ── 1. Setup ─────────────────────────────────────────────────────────── -->
	{#if !run && data.robotBlocked}
		<div class={card}>
			<p class="text-sm text-amber-200">This robot is busy with a {data.robotBlocked.process} run — finish or cancel it before filling diluent here.</p>
		</div>
	{:else}
		{#if !run && data.recentLot}
			<div class="mb-3 rounded-lg border border-emerald-500/40 bg-emerald-900/10 p-3 text-sm text-emerald-200">
				Last lot on this robot: <strong>{data.recentLot.lotNumber}</strong> — {data.recentLot.tubesTotal} tubes × {data.recentLot.volumeUl} µL, finished {fmtTime(data.recentLot.finishedAt)}.
			</div>
		{/if}
		{#if data.robotProtocols.length === 0}
			<div class="mb-3 rounded-lg border border-amber-500/40 bg-amber-900/10 p-3 text-sm text-amber-200">
				This robot has no diluent protocol yet. Import <code>Sample_Diluent_Fill_v2.py</code> on
				<a class="underline" href={resolve('/opentrons-clone/[robotId]/protocols', { robotId: data.robotId })}>its protocols page</a> first — you can still set up the run meanwhile.
			</div>
		{/if}
		<div class="{card} space-y-4">
			<h2 class="text-sm font-semibold uppercase tracking-wide text-[var(--color-tron-cyan)]">1. Setup</h2>

			<div class="grid gap-3 sm:grid-cols-3">
				<label class="block text-xs text-[var(--color-tron-text-secondary)]">
					Pipette
					<select class={input} value={pipette} onchange={(e) => onPipetteChange((e.currentTarget as HTMLSelectElement).value as DiluentPipette)} disabled={submitting}>
						{#each Object.entries(DILUENT_PIPETTES) as [key, spec] (key)}
							<option value={key}>{spec.label} · {spec.tiprackLabel}</option>
						{/each}
					</select>
				</label>
				<label class="block text-xs text-[var(--color-tron-text-secondary)]">
					Volume per tube (µL)
					<input class={input} type="number" step="0.5" min={DILUENT_MIN_VOLUME_UL} max={DILUENT_MAX_VOLUME_UL} bind:value={volumeUl} disabled={submitting} />
				</label>
				<label class="block text-xs text-[var(--color-tron-text-secondary)]">
					Tubes per aspirate
					<input class={input} type="number" step="1" min="1" max={DILUENT_PIPETTES[pipette].maxTubesPerTrip} bind:value={tubesPerTrip} disabled={submitting || DILUENT_PIPETTES[pipette].maxTubesPerTrip === 1} />
					{#if effectiveTubesPerTrip !== Number(tubesPerTrip)}
						<span class="text-amber-300">→ {effectiveTubesPerTrip} (tip capacity)</span>
					{/if}
				</label>
			</div>

			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="text-left text-xs text-[var(--color-tron-text-secondary)]">
						<tr>
							<th class="py-1 pr-2">Source</th>
							<th class="py-1 pr-2">Reagent lot in the tube</th>
							<th class="py-1 pr-2">Tubes (≤{DILUENT_TUBES_PER_RACK})</th>
							<th class="py-1 pr-2">Loaded (mL)</th>
							<th class="py-1">Needs ≥</th>
						</tr>
					</thead>
					<tbody>
						{#each rows as row, i (row.well)}
							{@const min = rowMinMl(Number(row.tubes) || 0)}
							{@const short = Number(row.tubes) > 0 && Number(row.ml) > 0 && Number(row.ml) < min}
							<tr class="border-t border-[var(--color-tron-border)]/60">
								<td class="py-2 pr-2 whitespace-nowrap">
									<span class="font-medium text-[var(--color-tron-text)]">{row.well}</span>
									<span class="block text-[11px] text-[var(--color-tron-text-secondary)]">→ rack in slot {DILUENT_DEST_SLOTS[i]}</span>
								</td>
								<td class="py-2 pr-2">
									<select class={input} bind:value={row.lotId} disabled={submitting}>
										<option value="">— {Number(row.tubes) > 0 ? 'pick a lot' : 'unused'} —</option>
										{#each data.reagentLots as lot (lot.id)}
											<option value={lot.id}>{lot.lotBarcode}{lot.templateName ? ` — ${lot.templateName}` : ''}{lot.volume ? ` (${lot.volume} ${lot.volumeUnit ?? ''})` : ''}</option>
										{/each}
									</select>
								</td>
								<td class="py-2 pr-2"><input class={input} type="number" min="0" max={DILUENT_TUBES_PER_RACK} step="1" bind:value={row.tubes} disabled={submitting} /></td>
								<td class="py-2 pr-2"><input class="{input} {short ? 'border-red-500/70' : ''}" type="number" min="0" max="15" step="0.1" bind:value={row.ml} disabled={submitting} /></td>
								<td class="py-2 text-xs {short ? 'text-red-300' : 'text-[var(--color-tron-text-secondary)]'}">{Number(row.tubes) > 0 ? `${min} mL` : '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="text-xs text-[var(--color-tron-text-secondary)]">
				{totalTubes} tube{totalTubes === 1 ? '' : 's'} at {volumeUl} µL · {DILUENT_PIPETTES[pipette].label}, {effectiveTubesPerTrip} tube{effectiveTubesPerTrip === 1 ? '' : 's'} per aspirate.
				"Needs ≥" is tubes × volume plus what the tip cannot reach at the bottom — the robot refuses a shorter source.
			</p>
			{#if setupProblems.length && (totalTubes > 0 || rows.some((r) => r.lotId || r.ml))}
				<ul class="list-inside list-disc text-xs text-amber-300">
					{#each setupProblems as p (p)}<li>{p}</li>{/each}
				</ul>
			{/if}
			<div class="flex flex-wrap gap-2">
				<button type="button" class={btnPrimary} onclick={saveSetup} disabled={submitting || setupProblems.length > 0}>Save &amp; load deck →</button>
				{#if run}
					<button type="button" class={btnDanger} onclick={cancelSetup} disabled={submitting}>Cancel run</button>
				{/if}
			</div>
		</div>
	{/if}

{:else if stage === 'Loading'}
	<!-- ── 2. Load deck ──────────────────────────────────────────────────────── -->
	{@const used = run.sources.filter((s) => s.tubesPlanned > 0)}
	{@const spec = DILUENT_PIPETTES[run.pipette]}
	<div class="{card} space-y-4">
		<div class="flex items-center justify-between gap-2">
			<h2 class="text-sm font-semibold uppercase tracking-wide text-[var(--color-tron-cyan)]">2. Load the deck</h2>
			<button type="button" class={btnGhost} onclick={backToSetup} disabled={submitting || run.deckConfirmed}>← Setup</button>
		</div>

		<!-- Deck map: slot 10 sources, 11 tips, 12 trash; one two-slot rack per used row. -->
		<div class="grid grid-cols-3 gap-1 text-[11px]">
			<div class="rounded border border-[var(--color-tron-cyan)]/60 bg-[var(--color-tron-cyan)]/10 p-2"><strong>10</strong> · 15-tube rack<br />{used.map((s) => s.well).join(', ') || '—'} = 15 mL source{used.length === 1 ? '' : 's'}</div>
			<div class="rounded border border-[var(--color-tron-cyan)]/60 bg-[var(--color-tron-cyan)]/10 p-2"><strong>11</strong> · {spec.tiprackLabel}</div>
			<div class="rounded border border-[var(--color-tron-border)] p-2 text-[var(--color-tron-text-secondary)]"><strong>12</strong> · trash</div>
			{#each DILUENT_DEST_SLOTS as slot, i (slot)}
				{@const s = run.sources[i]}
				{@const on = s && s.tubesPlanned > 0}
				<div class="col-span-2 rounded border p-2 {on ? 'border-emerald-500/60 bg-emerald-900/15' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}">
					<strong>{slot}</strong> · heat-frame rack {i + 1}
					{#if on}— {s.tubesPlanned} empty 2 mL tubes in the 40 defined holes (every other one) ← source {s.well}{:else}— empty{/if}
				</div>
				<div class="rounded border border-dashed border-[var(--color-tron-border)]/50 p-2 text-[var(--color-tron-text-secondary)]">{slot + 2} (covered)</div>
			{/each}
		</div>

		<ul class="space-y-1 text-sm text-[var(--color-tron-text)]">
			<li>• {spec.label} is mounted; <strong>{spec.tiprackLabel}</strong> rack in slot 11, full or with its first column free.</li>
			{#each used as s (s.well)}
				<li>• <strong>{s.well}</strong>: 15 mL tube with <strong>{s.loadedMl} mL</strong> of {s.reagentLotBarcode ?? 'the reagent lot'}{s.templateName ? ` (${s.templateName})` : ''} — needs ≥ {ulToMlUp(diluentMinSourceUl(run.pipette, s.tubesPlanned, run.diluentVolumeUl))} mL for {s.tubesPlanned} tubes.</li>
			{/each}
			<li>• Caps off every tube. Nothing in slots 3, 6, 9 — the racks cover them.</li>
		</ul>

		{#if !run.deckConfirmed}
			<div class="flex flex-wrap gap-2">
				<button type="button" class={btnPrimary} onclick={confirmDeck} disabled={submitting}>Deck loaded as above ✓</button>
				<button type="button" class={btnDanger} onclick={cancelSetup} disabled={submitting}>Cancel run</button>
			</div>
		{:else}
			<!-- ── 3. Start ─────────────────────────────────────────────────── -->
			<h2 class="text-sm font-semibold uppercase tracking-wide text-[var(--color-tron-cyan)]">3. Start</h2>
			{#if run.startInterrupted}
				<p class="rounded border border-amber-500/40 bg-amber-900/10 p-2 text-xs text-amber-200">{run.startInterrupted}</p>
			{/if}
			{#if data.robotProtocols.length === 0}
				<p class="text-sm text-amber-200">No diluent protocol on this robot — import <code>Sample_Diluent_Fill_v2.py</code> on <a class="underline" href={resolve('/opentrons-clone/[robotId]/protocols', { robotId: data.robotId })}>its protocols page</a>, then reload.</p>
			{:else}
				<ProtocolStartPanel
					robot={{ _id: data.opentronsRobotId, name: robotName || 'Robot' }}
					protocols={data.robotProtocols}
					contextValues={rtp}
					contextReadonly={Object.keys(rtp)}
					lastTipState={data.lastTipState}
					{submitting}
					formAction={act('startRun')}
					extraHidden={{ runId: run.runId }}
					onSubmitIntercept={startRun}
					submitLabel="Start diluent fill"
				/>
			{/if}
			<div class="flex flex-wrap gap-2">
				<button type="button" class={btnGhost} onclick={cancelSetup} disabled={submitting}>Cancel run</button>
			</div>
		{/if}
	</div>

{:else if stage === 'Running'}
	<!-- ── 4. Running ────────────────────────────────────────────────────────── -->
	{@const used = run.sources.filter((s) => s.tubesPlanned > 0)}
	{@const finished = robotFinished || runFinishedLocal}
	<div class="{card} space-y-3">
		<div class="flex flex-wrap items-baseline justify-between gap-2">
			<h2 class="text-sm font-semibold uppercase tracking-wide text-[var(--color-tron-cyan)]">Diluent fill running</h2>
			<span class="text-xs text-[var(--color-tron-text-secondary)]">started {fmtTime(run.runStartTime)} · about {fmtTime(run.runEndTime)} done</span>
		</div>
		<p class="text-sm text-[var(--color-tron-text)]">
			{diluentTubesTotal(run.sources)} tubes × {run.diluentVolumeUl} µL with the {DILUENT_PIPETTES[run.pipette].label}:
			{#each used as s, i (s.well)}{i > 0 ? ' · ' : ''}{s.well} → slot {DILUENT_DEST_SLOTS[DILUENT_SOURCE_WELLS.indexOf(s.well as any)]} ({s.tubesPlanned}){/each}
		</p>

		{#if run.opentronsRunId && data.opentronsRobotId}
			<EmbeddedRunController
				robotId={data.opentronsRobotId}
				robotName={robotName || 'Diluent fill'}
				opentronsRunId={run.opentronsRunId}
				onStatusChange={(s) => { robotStatus = s; }}
				onComplete={(status) => recordRunFinished(status)}
			/>
		{:else}
			<p class="text-sm text-[var(--color-tron-text-secondary)]">Starting — waiting for the robot's run id…</p>
		{/if}

		{#if finished}
			{#if run.opentronsRunFinalStatus === 'succeeded'}
				<p class="rounded border border-emerald-500/40 bg-emerald-900/10 p-3 text-sm text-emerald-200">
					Run finished. Recording the lot{run.diluentLotNumber ? ` ${run.diluentLotNumber}` : ''}…
				</p>
			{:else}
				<div class="space-y-2 rounded border border-amber-500/40 bg-amber-900/10 p-3 text-sm text-amber-100">
					<p>The robot ended this run in <strong>{run.opentronsRunFinalStatus ?? robotStatus}</strong>. Count the tubes that actually got diluent and complete the run, or abort it.</p>
					<div class="flex flex-wrap gap-3">
						{#each used as s (s.well)}
							<label class="text-xs">
								{s.well} → slot {DILUENT_DEST_SLOTS[DILUENT_SOURCE_WELLS.indexOf(s.well as any)]} (of {s.tubesPlanned})
								<input class={input} type="number" min="0" max={s.tubesPlanned} step="1" bind:value={filledCounts[s.well]} placeholder="0" />
							</label>
						{/each}
					</div>
					<div class="flex flex-wrap gap-2">
						<button type="button" class={btnPrimary} onclick={completeDespiteFailure} disabled={submitting}>Complete with these counts</button>
						<button type="button" class={btnDanger} onclick={() => stopRun('abort')} disabled={submitting}>Abort — no lot</button>
					</div>
				</div>
			{/if}
		{:else}
			<div class="flex flex-wrap gap-2">
				<button type="button" class={btnDanger} onclick={() => stopRun('abort')} disabled={submitting}>Abort run</button>
				<button type="button" class={btnGhost} onclick={() => stopRun('cancel')} disabled={submitting}>Cancel run</button>
			</div>
		{/if}
	</div>
{/if}
