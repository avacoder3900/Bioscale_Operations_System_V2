<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/stores';
	import { beforeNavigate } from '$app/navigation';
	import type { PageData, ActionData } from './$types';

	interface Props { data: PageData; form: ActionData }
	let { data, form }: Props = $props();

	const lot = $derived(data.lot);
	const template = $derived(data.template);
	const isFinalized = $derived(lot.status === 'finalized');
	const isVoided = $derived(lot.status === 'voided');
	const isEditable = $derived(!isFinalized && !isVoided);

	// Active step is driven by ?step=<key>; defaults to first incomplete or first step
	const activeStepKey = $derived.by(() => {
		const fromUrl = $page.url.searchParams.get('step');
		if (fromUrl) return fromUrl;
		const firstIncomplete = template.steps.find(
			(s: any) => !lot.stepEntries.some((e: any) => e.stepKey === s.key && e.completedAt)
		);
		return firstIncomplete?.key ?? template.steps[0]?.key ?? '';
	});

	const activeStep = $derived(template.steps.find((s: any) => s.key === activeStepKey));
	const activeEntry = $derived(lot.stepEntries.find((e: any) => e.stepKey === activeStepKey));

	// Parameter lookup for inline formula display
	const paramMap = $derived(
		Object.fromEntries((lot.parameterValues ?? []).map((p: any) => [p.key, p.value]))
	);

	function evalFormula(formula: string): string {
		// First-pass: just show the formula as documentation. Real eval comes later.
		return formula;
	}

	function flagFor(value: any, checkpoint: any): 'in-range' | 'out-of-range' | 'unmeasured' | 'qualitative' {
		if (checkpoint.type !== 'quantitative') return value ? 'qualitative' : 'unmeasured';
		if (value === '' || value === null || value === undefined) return 'unmeasured';
		const n = Number(value);
		if (Number.isNaN(n)) return 'unmeasured';
		const min = checkpoint.expectedMin;
		const max = checkpoint.expectedMax;
		if ((min !== undefined && n < min) || (max !== undefined && n > max)) return 'out-of-range';
		return 'in-range';
	}

	// Working state for the active step (initialized from saved entry on step change)
	let readings = $state<Record<string, any>>({});
	let observations = $state<Record<string, string>>({});
	let stepNote = $state('');
	// `dirty` flips to true when the operator touches an input. Cleared when
	// the step entry is saved or when activeStep changes (re-init from saved).
	let dirty = $state(false);

	$effect(() => {
		if (!activeStep) return;
		const next: Record<string, any> = {};
		for (const c of activeStep.qcCheckpoints ?? []) {
			const saved = activeEntry?.qcReadings?.find((r: any) => r.checkpointKey === c.key);
			next[c.key] = saved?.value ?? '';
		}
		readings = next;
		const obsNext: Record<string, string> = {};
		for (const p of activeStep.observationPrompts ?? []) {
			const saved = activeEntry?.observations?.find((o: any) => o.promptKey === p.key);
			obsNext[p.key] = saved?.body ?? '';
		}
		observations = obsNext;
		stepNote = activeEntry?.note ?? '';
		dirty = false;
	});

	function markDirty() { dirty = true; }

	// Guard nav: confirm before discarding unsaved edits on the current step.
	beforeNavigate((nav) => {
		if (!dirty) return;
		const ok = confirm('You have unsaved changes on this step. Leave anyway?');
		if (!ok) nav.cancel();
	});

	function buildReadingsPayload(): string {
		if (!activeStep) return '[]';
		return JSON.stringify(
			(activeStep.qcCheckpoints ?? []).map((c: any) => ({
				checkpointKey: c.key,
				label: c.label,
				value: readings[c.key],
				unit: c.unit,
				flag: flagFor(readings[c.key], c)
			}))
		);
	}

	function buildObservationsPayload(): string {
		if (!activeStep) return '[]';
		return JSON.stringify(
			(activeStep.observationPrompts ?? [])
				.filter((p: any) => observations[p.key])
				.map((p: any) => {
					// Echo the saved _id so the server doesn't regenerate one
					// on every save — keeps the observation's identity stable
					// for audit and future per-observation edit/delete actions.
					const saved = activeEntry?.observations?.find((o: any) => o.promptKey === p.key);
					return {
						_id: saved?._id,
						promptKey: p.key,
						body: observations[p.key]
					};
				})
		);
	}

	// New lot note draft
	let newNoteBody = $state('');

	function statusClass(s: string): string {
		switch (s) {
			case 'in_progress': return 'bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]';
			case 'finalized': return 'bg-emerald-500/15 text-emerald-400';
			case 'voided': return 'bg-rose-500/15 text-rose-400';
			default: return 'bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)]';
		}
	}

	function flagClass(flag: string): string {
		if (flag === 'out-of-range') return 'border-amber-500/60 bg-amber-500/10 text-amber-300';
		if (flag === 'in-range') return 'border-emerald-500/40 bg-emerald-500/5 text-emerald-300';
		return 'border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] text-[var(--color-tron-text)]';
	}

	function fmtDate(d: string | Date | null | undefined): string {
		return d ? new Date(d).toLocaleString() : '—';
	}
</script>

<div class="space-y-3">
	<!-- Header -->
	<div class="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-tron-border)] pb-3">
		<div>
			<a href="/manufacturing/reagent-lots" class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">
				← All lots
			</a>
			<h1 class="mt-1 text-xl font-semibold text-[var(--color-tron-text)]">
				{template.name} <span class="text-sm text-[var(--color-tron-text-secondary)]">v{lot.templateVersion}</span>
			</h1>
			<div class="mt-1 flex items-center gap-2 text-xs text-[var(--color-tron-text-secondary)]">
				<span class="font-mono">{lot.lotBarcode}</span>
				<span>·</span>
				<span>{lot.operator?.username ?? '—'}</span>
				<span>·</span>
				<span>started {fmtDate(lot.startedAt)}</span>
				<span class="rounded px-2 py-0.5 text-xs {statusClass(lot.status)}">{lot.status}</span>
				{#if lot.flags?.length}
					<span class="rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-400">
						{lot.flags.length} flag{lot.flags.length === 1 ? '' : 's'}
					</span>
				{/if}
			</div>
		</div>
		<div class="flex items-center gap-2">
			{#if isEditable}
				<form method="POST" action="?/finalize" use:enhance>
					<button type="submit"
						class="rounded-md bg-emerald-500/20 px-3 py-1.5 text-sm font-medium text-emerald-300 hover:bg-emerald-500/30">
						Finalize Lot
					</button>
				</form>
				<details class="relative">
					<summary class="cursor-pointer list-none rounded-md border border-rose-500/40 px-3 py-1.5 text-sm text-rose-300 hover:bg-rose-500/10">
						Void
					</summary>
					<form method="POST" action="?/void" use:enhance
						class="absolute right-0 mt-1 w-64 space-y-2 rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-2 shadow">
						<label class="block text-xs text-[var(--color-tron-text-secondary)]" for="void-reason">Reason</label>
						<input id="void-reason" name="reason" type="text" required
							class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs text-[var(--color-tron-text)]" />
						<button type="submit" class="w-full rounded-md bg-rose-500/20 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/30">
							Confirm Void
						</button>
					</form>
				</details>
			{/if}
		</div>
	</div>

	{#if isFinalized}
		<div class="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-300">
			Finalized {fmtDate(lot.finalizedAt)}. Edits go through corrections only.
		</div>
	{/if}
	{#if isVoided}
		<div class="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
			Voided {fmtDate(lot.voidedAt)}: {lot.voidReason}
		</div>
	{/if}

	{#if form?.error}
		<div class="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
			{form.error}
		</div>
	{/if}

	<div class="grid gap-4 lg:grid-cols-[220px_1fr]">
		<!-- Step rail -->
		<aside class="space-y-2">
			<h2 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-tron-text-secondary)]">Steps</h2>
			<ol class="space-y-0.5">
				{#each template.steps as s}
					{@const entry = lot.stepEntries.find((e: any) => e.stepKey === s.key)}
					{@const done = entry?.completedAt}
					{@const flagged = entry?.flagged}
					<li>
						<a href={`?step=${s.key}`}
							class="block rounded-md px-2 py-1.5 text-xs transition-colors
								{activeStepKey === s.key
									? 'bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]'
									: 'text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-surface)] hover:text-[var(--color-tron-text)]'}">
							<div class="flex items-center gap-1">
								<span class="font-mono opacity-60">{s.number}.</span>
								<span class="grow truncate">{s.title}</span>
								{#if flagged}
									<span class="h-1.5 w-1.5 rounded-full bg-amber-400" title="flagged readings"></span>
								{:else if done}
									<span class="text-emerald-400">✓</span>
								{/if}
							</div>
						</a>
					</li>
				{/each}
			</ol>

			<div class="border-t border-[var(--color-tron-border)] pt-2">
				<a href="?step=__final__"
					class="block rounded-md px-2 py-1.5 text-xs
						{activeStepKey === '__final__'
							? 'bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]'
							: 'text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-surface)] hover:text-[var(--color-tron-text)]'}">
					Final: Outputs &amp; Observations
				</a>
				<a href="?step=__notes__"
					class="block rounded-md px-2 py-1.5 text-xs
						{activeStepKey === '__notes__'
							? 'bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]'
							: 'text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-surface)] hover:text-[var(--color-tron-text)]'}">
					Lot Notes ({lot.lotNotes?.length ?? 0})
				</a>
				<a href="?step=__overview__"
					class="block rounded-md px-2 py-1.5 text-xs
						{activeStepKey === '__overview__'
							? 'bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]'
							: 'text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-surface)] hover:text-[var(--color-tron-text)]'}">
					Overview &amp; Lineage
				</a>
			</div>
		</aside>

		<!-- Main step body -->
		<section class="space-y-3 rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-4">
			{#if activeStepKey === '__overview__'}
				<h2 class="text-base font-semibold text-[var(--color-tron-text)]">Overview &amp; Lineage</h2>

				<div class="grid gap-4 sm:grid-cols-2">
					<div>
						<h3 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-tron-text-secondary)]">Key Parameters</h3>
						<dl class="mt-1 space-y-0.5 text-sm">
							{#each lot.parameterValues as p}
								<div class="flex justify-between gap-2 text-[var(--color-tron-text)]">
									<dt class="text-[var(--color-tron-text-secondary)]">{p.key}</dt>
									<dd class="font-mono">{p.value}{p.unit ? ` ${p.unit}` : ''}</dd>
								</div>
							{/each}
						</dl>
					</div>

					<div>
						<h3 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-tron-text-secondary)]">Input Lots</h3>
						{#if lot.inputLots?.length}
							<ul class="mt-1 space-y-1 text-sm">
								{#each lot.inputLots as il}
									<li class="flex justify-between gap-2 text-[var(--color-tron-text)]">
										<span class="text-[var(--color-tron-text-secondary)]">{il.materialKey}</span>
										<a href={`/manufacturing/reagent-lots/${il.sourceId}`}
											class="font-mono text-[var(--color-tron-cyan)] hover:underline">{il.label}</a>
									</li>
								{/each}
							</ul>
						{:else}
							<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">No upstream lots — stock-fed run.</p>
						{/if}
					</div>
				</div>

				<div>
					<h3 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-tron-text-secondary)]">Flags</h3>
					{#if lot.flags?.length}
						<ul class="mt-1 space-y-1 text-sm">
							{#each lot.flags as f}
								<li class="rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1 text-xs text-amber-200">
									Step {f.stepKey} · {f.reason}
								</li>
							{/each}
						</ul>
					{:else}
						<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">No out-of-range readings recorded.</p>
					{/if}
				</div>

			{:else if activeStepKey === '__notes__'}
				<h2 class="text-base font-semibold text-[var(--color-tron-text)]">Lot Notes</h2>
				<p class="text-xs text-[var(--color-tron-text-secondary)]">
					Free-text observations tied to this lot. Editable until the lot is finalized.
				</p>

				{#each lot.lotNotes ?? [] as n}
					<form method="POST" action="?/saveLotNote" use:enhance class="rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-2">
						<input type="hidden" name="noteId" value={n._id} />
						<textarea name="body" rows="2" disabled={!isEditable}
							class="w-full resize-y rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]">{n.body}</textarea>
						<div class="mt-1 flex items-center justify-between">
							<span class="text-xs text-[var(--color-tron-text-secondary)]">
								{n.author?.username ?? '—'} · {fmtDate(n.createdAt)}
								{#if n.updatedAt && n.updatedAt !== n.createdAt}(edited){/if}
							</span>
							{#if isEditable}
								<div class="flex gap-1">
									<button type="submit" class="rounded-md bg-[var(--color-tron-cyan)]/20 px-2 py-0.5 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/30">Save</button>
									<button type="submit" name="remove" value="on"
										class="rounded-md border border-rose-500/40 px-2 py-0.5 text-xs text-rose-300 hover:bg-rose-500/10">Delete</button>
								</div>
							{/if}
						</div>
					</form>
				{/each}

				{#if isEditable}
					<form method="POST" action="?/saveLotNote"
						use:enhance={() => ({ result, update }) => { newNoteBody = ''; update(); }}
						class="space-y-2 rounded-md border border-dashed border-[var(--color-tron-border)] p-2">
						<textarea name="body" rows="2" bind:value={newNoteBody} placeholder="Add a new observation..."
							class="w-full resize-y rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]"></textarea>
						<button type="submit"
							class="rounded-md bg-[var(--color-tron-cyan)]/20 px-3 py-1 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/30">
							Add Note
						</button>
					</form>
				{/if}

			{:else if activeStepKey === '__final__'}
				<form method="POST" action="?/saveFinal" use:enhance class="space-y-4">
					<h2 class="text-base font-semibold text-[var(--color-tron-text)]">Final Outputs &amp; Observations</h2>

					<div class="grid gap-3 sm:grid-cols-2">
						<div>
							<label class="block text-xs text-[var(--color-tron-text-secondary)]" for="final-concentration">Final Concentration</label>
							<div class="flex gap-1">
								<input id="final-concentration" name="concentration" type="number" step="any" disabled={!isEditable}
									value={lot.finalOutputs?.concentration ?? template.outputSpec?.expectedConcentration ?? ''}
									class="grow rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]" />
								<input name="concentrationUnit" type="text" disabled={!isEditable}
									value={lot.finalOutputs?.concentrationUnit ?? template.outputSpec?.concentrationUnit ?? ''}
									class="w-20 rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]" />
							</div>
						</div>
						<div>
							<label class="block text-xs text-[var(--color-tron-text-secondary)]" for="final-volume">Final Volume</label>
							<div class="flex gap-1">
								<input id="final-volume" name="volume" type="number" step="any" disabled={!isEditable}
									value={lot.finalOutputs?.volume ?? ''}
									class="grow rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]" />
								<input name="volumeUnit" type="text" disabled={!isEditable}
									value={lot.finalOutputs?.volumeUnit ?? template.outputSpec?.volumeUnit ?? ''}
									class="w-20 rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]" />
							</div>
						</div>
					</div>

					<div>
						<label class="block text-xs text-[var(--color-tron-text-secondary)]" for="output-notes">Output Notes</label>
						<textarea id="output-notes" name="outputNotes" rows="2" disabled={!isEditable}
							class="w-full resize-y rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]">{lot.finalOutputs?.notes ?? ''}</textarea>
					</div>

					<div>
						<label class="block text-xs text-[var(--color-tron-text-secondary)]" for="final-observations">
							Final Observations (tied to the lot — editable until finalized)
						</label>
						<textarea id="final-observations" name="finalObservations" rows="4" disabled={!isEditable}
							class="w-full resize-y rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]">{lot.finalObservations ?? ''}</textarea>
					</div>

					{#if isEditable}
						<button type="submit"
							class="rounded-md bg-[var(--color-tron-cyan)]/20 px-3 py-1.5 text-sm text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/30">
							Save Final
						</button>
					{/if}
				</form>

			{:else if activeStep}
				<form method="POST" action="?/saveStep"
					use:enhance={() => ({ result, update }) => { dirty = false; update(); }}
					class="space-y-4">
					<input type="hidden" name="stepKey" value={activeStep.key} />
					<input type="hidden" name="stepNumber" value={activeStep.number} />
					<input type="hidden" name="stepTitle" value={activeStep.title} />

					<div class="flex items-start justify-between gap-2">
						<h2 class="text-base font-semibold text-[var(--color-tron-text)]">
							Step {activeStep.number} — {activeStep.title}
							{#if dirty}
								<span class="ml-2 align-middle text-xs text-amber-300" title="Unsaved changes on this step">● unsaved</span>
							{/if}
						</h2>
						{#if activeEntry?.completedAt}
							<span class="text-xs text-emerald-400">✓ completed {fmtDate(activeEntry.completedAt)}</span>
						{/if}
					</div>

					<div class="rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 text-sm text-[var(--color-tron-text)] whitespace-pre-wrap">
						{activeStep.instructions}
					</div>

					{#if activeStep.timing}
						<div class="flex flex-wrap gap-3 text-xs text-[var(--color-tron-text-secondary)]">
							{#if activeStep.timing.durationMinutes}
								<span>⏱ Duration: <strong class="text-[var(--color-tron-text)]">{activeStep.timing.durationMinutes} min</strong></span>
							{/if}
							{#if activeStep.timing.intervalMinutes}
								<span>↻ Check every <strong class="text-[var(--color-tron-text)]">{activeStep.timing.intervalMinutes} min</strong></span>
							{/if}
							{#if activeStep.timing.temperatureC !== undefined}
								<span>🌡 Temp: <strong class="text-[var(--color-tron-text)]">{activeStep.timing.temperatureC} °C</strong></span>
							{/if}
							{#if activeStep.timing.rpm}
								<span>↻ RPM: <strong class="text-[var(--color-tron-text)]">{activeStep.timing.rpm}</strong></span>
							{/if}
						</div>
					{/if}

					{#if activeStep.reagents?.length}
						<div>
							<h3 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-tron-text-secondary)]">Reagents</h3>
							<table class="mt-1 min-w-full text-sm">
								<thead class="text-xs text-[var(--color-tron-text-secondary)]">
									<tr>
										<th class="px-2 py-1 text-left">Reagent</th>
										<th class="px-2 py-1 text-left">Formula</th>
										<th class="px-2 py-1 text-left">Unit</th>
									</tr>
								</thead>
								<tbody>
									{#each activeStep.reagents as r}
										<tr class="border-t border-[var(--color-tron-border)]">
											<td class="px-2 py-1 text-[var(--color-tron-text)]">{r.label}</td>
											<td class="px-2 py-1 font-mono text-xs text-[var(--color-tron-text-secondary)]">{evalFormula(r.formula)}</td>
											<td class="px-2 py-1 text-xs text-[var(--color-tron-text-secondary)]">{r.unit}</td>
										</tr>
									{/each}
								</tbody>
							</table>
							<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
								Formula evaluation lands in a follow-up — for now compute by hand using the formula text.
							</p>
						</div>
					{/if}

					{#if activeStep.qcCheckpoints?.length}
						<div>
							<h3 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-tron-text-secondary)]">QC Checkpoints</h3>
							<div class="mt-1 grid gap-2 sm:grid-cols-2">
								{#each activeStep.qcCheckpoints as c}
									{@const flag = flagFor(readings[c.key], c)}
									<div class="rounded-md border px-2 py-1.5 {flagClass(flag)}">
										<label class="block text-xs" for={`r-${c.key}`}>{c.label}</label>
										<input id={`r-${c.key}`} type={c.type === 'quantitative' ? 'number' : 'text'} step="any"
											bind:value={readings[c.key]} disabled={!isEditable} oninput={markDirty}
											class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]" />
										<div class="mt-1 flex items-center justify-between text-[10px] text-[var(--color-tron-text-secondary)]">
											<span>
												{#if c.expectedMin !== undefined || c.expectedMax !== undefined}
													expected {c.expectedMin ?? '-∞'}–{c.expectedMax ?? '∞'} {c.unit ?? ''}
												{:else if c.expectedValue}
													expected {c.expectedValue} {c.unit ?? ''}
												{:else}
													{c.unit ?? ''}
												{/if}
											</span>
											{#if flag === 'out-of-range'}
												<span class="text-amber-300">⚠ flagged</span>
											{:else if flag === 'in-range'}
												<span class="text-emerald-300">in range</span>
											{/if}
										</div>
										{#if c.helpText}
											<p class="mt-0.5 text-[10px] text-[var(--color-tron-text-secondary)]">{c.helpText}</p>
										{/if}
									</div>
								{/each}
							</div>
						</div>
					{/if}

					{#if activeStep.observationPrompts?.length}
						<div>
							<h3 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-tron-text-secondary)]">Qualitative Observations</h3>
							<div class="mt-1 space-y-2">
								{#each activeStep.observationPrompts as p}
									<div>
										<label class="block text-xs text-[var(--color-tron-text-secondary)]" for={`o-${p.key}`}>{p.label}</label>
										<textarea id={`o-${p.key}`} rows="2" bind:value={observations[p.key]} disabled={!isEditable} oninput={markDirty}
											placeholder={p.helpText ?? ''}
											class="w-full resize-y rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]"></textarea>
									</div>
								{/each}
							</div>
						</div>
					{/if}

					<div>
						<label class="block text-xs text-[var(--color-tron-text-secondary)]" for="step-note">Step Note</label>
						<textarea id="step-note" name="note" rows="2" bind:value={stepNote} disabled={!isEditable} oninput={markDirty}
							placeholder="Anything else worth recording for this step..."
							class="w-full resize-y rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]"></textarea>
					</div>

					<input type="hidden" name="readings" value={buildReadingsPayload()} />
					<input type="hidden" name="observations" value={buildObservationsPayload()} />

					{#if isEditable}
						<div class="flex flex-wrap items-center justify-between gap-2 pt-2">
							<label class="flex items-center gap-2 text-sm text-[var(--color-tron-text)]">
								<input type="checkbox" name="markCompleted" checked={!!activeEntry?.completedAt} onchange={markDirty} />
								Mark step completed
							</label>
							<div class="flex gap-2">
								<button type="submit"
									class="rounded-md bg-[var(--color-tron-cyan)]/20 px-3 py-1.5 text-sm text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/30">
									Save Step
								</button>
							</div>
						</div>
					{/if}
				</form>
			{:else}
				<p class="text-sm text-[var(--color-tron-text-secondary)]">No step selected.</p>
			{/if}
		</section>
	</div>
</div>
