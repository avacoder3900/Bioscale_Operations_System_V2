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
	let observationConcerns = $state<Record<string, boolean>>({});
	let stepNote = $state('');
	// `dirty` flips to true when the operator touches an input. Cleared when
	// the step entry is saved or when activeStep changes (re-init from saved).
	let dirty = $state(false);

	// Finalize barcode-capture state. Chemists physically label output tubes
	// then scan their barcodes here. One row per tube. Empty barcodes are
	// dropped at submit. Zero rows = finalize a failed run (no inventory
	// created, lot still locks). Each tube can map to a different output spec
	// when the template declares outputSpecs[]; defaults to the first when
	// only one spec exists.
	type PendingTube = {
		barcode: string;
		outputSpecKey: string;
		concentration: string;
		concentrationUnit: string;
		volume: string;
		volumeUnit: string;
		notes: string;
	};
	function blankTube(defaults: { specKey?: string; concUnit?: string; volUnit?: string } = {}): PendingTube {
		return {
			barcode: '',
			outputSpecKey: defaults.specKey ?? '',
			concentration: '',
			concentrationUnit: defaults.concUnit ?? '',
			volume: '',
			volumeUnit: defaults.volUnit ?? '',
			notes: ''
		};
	}
	let pendingTubes = $state<PendingTube[]>([blankTube()]);

	const outputSpecs = $derived(
		((template.outputSpecs ?? []) as Array<{
			key: string;
			productName?: string;
			catalogId?: string;
			concentrationUnit?: string;
			volumeUnit?: string;
		}>)
	);
	const hasMultipleSpecs = $derived(outputSpecs.length > 1);
	const defaultSpecKey = $derived(outputSpecs[0]?.key ?? '');
	const defaultConcUnit = $derived(
		outputSpecs[0]?.concentrationUnit ?? template.outputSpec?.concentrationUnit ?? ''
	);
	const defaultVolUnit = $derived(
		outputSpecs[0]?.volumeUnit ?? template.outputSpec?.volumeUnit ?? ''
	);

	// Build the JSON payload from current pendingTubes, filtering blank barcodes.
	const outputsPayload = $derived(
		pendingTubes
			.map((t) => ({ ...t, barcode: (t.barcode ?? '').trim() }))
			.filter((t) => t.barcode.length > 0)
			.map((t) => ({
				barcode: t.barcode,
				outputSpecKey: t.outputSpecKey || defaultSpecKey || '',
				concentration: t.concentration === '' ? undefined : Number(t.concentration),
				concentrationUnit: t.concentrationUnit || defaultConcUnit || '',
				volume: t.volume === '' ? undefined : Number(t.volume),
				volumeUnit: t.volumeUnit || defaultVolUnit || '',
				notes: t.notes || ''
			}))
	);
	const outputsJson = $derived(JSON.stringify(outputsPayload));
	const tubeCount = $derived(outputsPayload.length);

	function addTubeRow() {
		pendingTubes = [
			...pendingTubes,
			blankTube({ specKey: defaultSpecKey, concUnit: defaultConcUnit, volUnit: defaultVolUnit })
		];
	}
	function removeTubeRow(idx: number) {
		pendingTubes = pendingTubes.filter((_, i) => i !== idx);
		if (pendingTubes.length === 0) pendingTubes = [blankTube()];
	}

	$effect(() => {
		if (!activeStep) return;
		const next: Record<string, any> = {};
		for (const c of activeStep.qcCheckpoints ?? []) {
			const saved = activeEntry?.qcReadings?.find((r: any) => r.checkpointKey === c.key);
			next[c.key] = saved?.value ?? '';
		}
		readings = next;
		const obsNext: Record<string, string> = {};
		const concernNext: Record<string, boolean> = {};
		for (const p of activeStep.observationPrompts ?? []) {
			const saved = activeEntry?.observations?.find((o: any) => o.promptKey === p.key);
			obsNext[p.key] = saved?.body ?? '';
			concernNext[p.key] = !!saved?.concern;
		}
		observations = obsNext;
		observationConcerns = concernNext;
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

	// — Setup-tab editable state (lot barcode, parameters, input lots, stock barcodes) —
	// Initialized from the saved lot on load; the operator can change anything
	// until the lot is finalized. Stock entries are layered on top of any
	// existing inputLot for that material (so editing preserves prior values).
	const preparedMaterials = $derived(
		(template.materials ?? []).filter((m: any) => m.type === 'prepared')
	);
	const stockMaterials = $derived(
		(template.materials ?? []).filter((m: any) => m.type === 'stock' || m.type === 'reused')
	);
	function candidatesFor(material: any) {
		const allowed: string[] = material?.canSourceFromSlugs ?? [];
		if (!allowed.length) return [];
		return (data.candidateLots ?? []).filter((c: any) => allowed.includes(c.templateSlug));
	}

	let editedLotBarcode = $state(lot.lotBarcode ?? '');
	let editedParams = $state<Record<string, any>>({});
	let editedPreparedPicks = $state<Record<string, { sourceId: string; label: string }>>({});
	let editedStockEntries = $state<Record<string, { barcode: string; concentration: string }>>({});

	$effect(() => {
		// Initialize once from the lot snapshot — re-runs when lot reloads after save.
		editedLotBarcode = lot.lotBarcode ?? '';
		const pNext: Record<string, any> = {};
		for (const p of template.parameters ?? []) {
			const saved = (lot.parameterValues ?? []).find((v: any) => v.key === p.key);
			pNext[p.key] = saved?.value ?? p.defaultValue ?? '';
		}
		editedParams = pNext;
		const prepNext: Record<string, { sourceId: string; label: string }> = {};
		const stockNext: Record<string, { barcode: string; concentration: string }> = {};
		for (const il of lot.inputLots ?? []) {
			if (il.source === 'reagent_lot' && il.sourceId) {
				prepNext[il.materialKey] = { sourceId: il.sourceId, label: il.label ?? '' };
			} else if (il.source === 'manual' || il.source === 'receiving_lot') {
				stockNext[il.materialKey] = {
					barcode: il.barcode ?? '',
					concentration: il.concentration != null ? String(il.concentration) : ''
				};
			}
		}
		editedPreparedPicks = prepNext;
		editedStockEntries = stockNext;
	});

	function buildSetupParamsPayload(): string {
		return JSON.stringify(
			Object.entries(editedParams).map(([key, value]) => {
				const def = template.parameters?.find((p: any) => p.key === key);
				return { key, value: def?.type === 'number' && value !== '' ? Number(value) : value, unit: def?.unit };
			})
		);
	}
	function buildSetupInputLotsPayload(): string {
		const prep = Object.entries(editedPreparedPicks)
			.filter(([, v]) => v && v.sourceId)
			.map(([materialKey, v]) => ({ materialKey, source: 'reagent_lot', sourceId: v.sourceId, label: v.label }));
		const stock = Object.entries(editedStockEntries)
			.filter(([, v]) => v && (v.barcode?.trim() || v.concentration?.trim()))
			.map(([materialKey, v]) => {
				const m = template.materials?.find((mm: any) => mm.key === materialKey);
				return {
					materialKey,
					source: 'manual',
					barcode: v.barcode?.trim() || undefined,
					concentration: v.concentration?.trim() ? Number(v.concentration) : undefined,
					concentrationUnit: m?.defaultConcentrationUnit
				};
			});
		return JSON.stringify([...prep, ...stock]);
	}

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
				.filter((p: any) => observations[p.key] || observationConcerns[p.key])
				.map((p: any) => {
					const saved = activeEntry?.observations?.find((o: any) => o.promptKey === p.key);
					return {
						_id: saved?._id,
						promptKey: p.key,
						body: observations[p.key] ?? '',
						concern: !!observationConcerns[p.key]
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

	function fmtDuration(ms: number): string {
		if (!Number.isFinite(ms) || ms < 0) return '—';
		const sec = Math.floor(ms / 1000);
		if (sec < 60) return `${sec}s`;
		const min = Math.floor(sec / 60);
		if (min < 60) return `${min} min`;
		const hr = Math.floor(min / 60);
		const rem = min % 60;
		if (hr < 24) return rem ? `${hr}h ${rem}m` : `${hr}h`;
		const days = Math.floor(hr / 24);
		const remHr = hr % 24;
		return remHr ? `${days}d ${remHr}h` : `${days}d`;
	}

	function elapsedBetween(start: string | Date | null | undefined, end: string | Date | null | undefined): string {
		if (!start || !end) return '—';
		return fmtDuration(new Date(end).getTime() - new Date(start).getTime());
	}

	// Live clock tick — only when the lot is in_progress, so the active step's
	// elapsed counter updates without HMR. Cleared automatically by Svelte on
	// component unmount or status change.
	let now = $state(Date.now());
	$effect(() => {
		if (!isEditable || isVoided || isFinalized) return;
		const t = setInterval(() => { now = Date.now(); }, 1000);
		return () => clearInterval(t);
	});

	// Quick-log mode — toggleable; persists during the session only.
	// Minimal first-pass: stacked-vertical view of every step with a note
	// textarea and a mark-complete checkbox per step. QC reading + observation
	// inputs stay in step-by-step mode because their UI is per-checkpoint.
	let quickLogMode = $state(false);
	let quickNotes = $state<Record<string, string>>({});
	let quickComplete = $state<Record<string, boolean>>({});
	$effect(() => {
		const n: Record<string, string> = {};
		const c: Record<string, boolean> = {};
		for (const s of template.steps ?? []) {
			const e = lot.stepEntries?.find((x: any) => x.stepKey === s.key);
			n[s.key] = e?.note ?? '';
			c[s.key] = !!e?.completedAt;
		}
		quickNotes = n;
		quickComplete = c;
	});
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
			<div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--color-tron-text-secondary)]">
				<span class="font-mono">{lot.lotBarcode}</span>
				<span>·</span>
				<span>operator <strong class="text-[var(--color-tron-text)]">{lot.operator?.username ?? '—'}</strong></span>
				<span>·</span>
				<span>started {fmtDate(lot.startedAt)}</span>
				{#if lot.finalizedAt}
					<span>· finalized {fmtDate(lot.finalizedAt)}</span>
					<span>· elapsed <strong class="text-[var(--color-tron-text)]">{elapsedBetween(lot.startedAt, lot.finalizedAt)}</strong></span>
				{:else if isEditable}
					<span>· running <strong class="text-[var(--color-tron-cyan)]">{fmtDuration(now - new Date(lot.startedAt).getTime())}</strong></span>
				{/if}
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
				<button type="button"
					onclick={() => quickLogMode = !quickLogMode}
					class="rounded-md border border-[var(--color-tron-border)] px-3 py-1.5 text-xs {quickLogMode ? 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]' : 'text-[var(--color-tron-text-secondary)]'} hover:bg-[var(--color-tron-surface)]"
					title="Toggle between step-by-step runner and a single stacked form (good for catching up on a lot you didn't record live)">
					{quickLogMode ? '↻ Step-by-step' : '⇣ Quick log'}
				</button>
				<details class="relative">
					<summary class="cursor-pointer list-none rounded-md bg-emerald-500/20 px-3 py-1.5 text-sm font-medium text-emerald-300 hover:bg-emerald-500/30">
						Finalize Lot
					</summary>
					<form method="POST" action="?/finalize" use:enhance
						class="absolute right-0 z-10 mt-1 w-[420px] space-y-3 rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-3 shadow-lg">
						<div>
							<p class="text-xs font-semibold uppercase tracking-wide text-[var(--color-tron-text)]">Output tubes</p>
							<p class="mt-1 text-[11px] text-[var(--color-tron-text-secondary)]">
								Scan the barcode of each physically labelled output tube. Each scanned
								barcode becomes a row in reagent inventory linked back to this lot.
								Leave empty for a failed run (lot still finalizes, no inventory created).
							</p>
						</div>

						{#each pendingTubes as tube, idx (idx)}
							<div class="space-y-1.5 rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-2">
								<div class="flex items-center gap-2">
									<span class="text-[10px] text-[var(--color-tron-text-secondary)]">Tube {idx + 1}</span>
									<input
										type="text"
										placeholder="Scan or type barcode"
										bind:value={pendingTubes[idx].barcode}
										class="flex-1 rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs text-[var(--color-tron-text)]" />
									{#if pendingTubes.length > 1 || pendingTubes[0].barcode}
										<button type="button" onclick={() => removeTubeRow(idx)}
											class="rounded-md border border-rose-500/40 px-1.5 py-0.5 text-[10px] text-rose-300 hover:bg-rose-500/10">
											✕
										</button>
									{/if}
								</div>

								{#if hasMultipleSpecs}
									<div>
										<label class="block text-[10px] text-[var(--color-tron-text-secondary)]" for="spec-{idx}">Output spec</label>
										<select id="spec-{idx}" bind:value={pendingTubes[idx].outputSpecKey}
											class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs text-[var(--color-tron-text)]">
											{#each outputSpecs as s}
												<option value={s.key}>{s.productName ?? s.key}</option>
											{/each}
										</select>
									</div>
								{/if}

								<div class="grid grid-cols-2 gap-1.5">
									<div>
										<label class="block text-[10px] text-[var(--color-tron-text-secondary)]" for="conc-{idx}">Conc</label>
										<input id="conc-{idx}" type="number" step="any"
											bind:value={pendingTubes[idx].concentration}
											placeholder="—"
											class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-1.5 py-1 text-xs text-[var(--color-tron-text)]" />
									</div>
									<div>
										<label class="block text-[10px] text-[var(--color-tron-text-secondary)]" for="cunit-{idx}">Unit</label>
										<input id="cunit-{idx}" type="text"
											bind:value={pendingTubes[idx].concentrationUnit}
											placeholder={defaultConcUnit || 'mg/mL'}
											class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-1.5 py-1 text-xs text-[var(--color-tron-text)]" />
									</div>
									<div>
										<label class="block text-[10px] text-[var(--color-tron-text-secondary)]" for="vol-{idx}">Vol</label>
										<input id="vol-{idx}" type="number" step="any"
											bind:value={pendingTubes[idx].volume}
											placeholder="—"
											class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-1.5 py-1 text-xs text-[var(--color-tron-text)]" />
									</div>
									<div>
										<label class="block text-[10px] text-[var(--color-tron-text-secondary)]" for="vunit-{idx}">Unit</label>
										<input id="vunit-{idx}" type="text"
											bind:value={pendingTubes[idx].volumeUnit}
											placeholder={defaultVolUnit || 'mL'}
											class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-1.5 py-1 text-xs text-[var(--color-tron-text)]" />
									</div>
								</div>

								<div>
									<label class="block text-[10px] text-[var(--color-tron-text-secondary)]" for="notes-{idx}">Tube notes</label>
									<input id="notes-{idx}" type="text"
										bind:value={pendingTubes[idx].notes}
										placeholder="optional"
										class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-1.5 py-1 text-xs text-[var(--color-tron-text)]" />
								</div>
							</div>
						{/each}

						<button type="button" onclick={addTubeRow}
							class="w-full rounded-md border border-[var(--color-tron-border)] px-2 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-surface)]">
							+ Add another tube
						</button>

						<!-- Hidden field carrying the filtered, validated payload. -->
						<input type="hidden" name="outputs" value={outputsJson} />

						<button type="submit"
							class="w-full rounded-md bg-emerald-500/20 px-2 py-1.5 text-sm font-medium text-emerald-300 hover:bg-emerald-500/30">
							{#if tubeCount === 0}
								Finalize with no output (failed run)
							{:else if tubeCount === 1}
								Finalize &amp; register 1 tube
							{:else}
								Finalize &amp; register {tubeCount} tubes
							{/if}
						</button>
					</form>
				</details>
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
			<details class="relative">
				<summary class="cursor-pointer list-none rounded-md border border-rose-700/50 px-3 py-1.5 text-sm text-rose-400 hover:bg-rose-700/15">
					Delete
				</summary>
				<form method="POST" action="?/deleteLot" use:enhance
					class="absolute right-0 mt-1 w-72 space-y-2 rounded-md border border-rose-700/50 bg-[var(--color-tron-bg)] p-2 shadow">
					<p class="text-[10px] text-[var(--color-tron-text-secondary)]">
						Soft-delete this lot (record stays in Mongo for audit). Re-enter your password to confirm.
					</p>
					<label class="block text-xs text-[var(--color-tron-text-secondary)]" for="del-password">Admin password</label>
					<input id="del-password" name="adminPassword" type="password" required
						class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs text-[var(--color-tron-text)]" />
					<label class="block text-xs text-[var(--color-tron-text-secondary)]" for="del-reason">Reason (optional)</label>
					<input id="del-reason" name="reason" type="text"
						class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs text-[var(--color-tron-text)]" />
					<button type="submit" class="w-full rounded-md bg-rose-700/30 px-2 py-1 text-xs text-rose-200 hover:bg-rose-700/50">
						Delete Lot
					</button>
				</form>
			</details>
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
					{@const stepDuration = done ? elapsedBetween(entry.startedAt, entry.completedAt) : null}
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
									<span class="h-1.5 w-1.5 rounded-full bg-amber-400" title="flagged readings or operator concern"></span>
								{:else if done}
									<span class="text-emerald-400">✓</span>
								{/if}
							</div>
							{#if stepDuration}
								<div class="ml-4 mt-0.5 text-[10px] opacity-60">
									{stepDuration}
									{#if entry.completedBy?.username && entry.completedBy.username !== lot.operator?.username}
										· {entry.completedBy.username}
									{/if}
								</div>
							{/if}
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
					Setup &amp; Lineage
				</a>
			</div>
		</aside>

		<!-- Main step body -->
		<section class="space-y-3 rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-4">
			{#if quickLogMode}
				<div class="flex items-center justify-between">
					<h2 class="text-base font-semibold text-[var(--color-tron-text)]">Quick Log</h2>
					<p class="text-xs text-[var(--color-tron-text-secondary)]">
						Stacked view — drop notes + mark steps complete fast.
						For QC checkpoint readings + observations, switch back to step-by-step.
					</p>
				</div>
				{#each template.steps as s}
					{@const entry = lot.stepEntries.find((e: any) => e.stepKey === s.key)}
					{@const done = entry?.completedAt}
					<form method="POST" action="?/saveStep" use:enhance
						class="rounded-md border {done ? 'border-emerald-500/30 bg-emerald-500/[0.03]' : 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]'} p-2 space-y-2">
						<input type="hidden" name="stepKey" value={s.key} />
						<input type="hidden" name="stepNumber" value={s.number} />
						<input type="hidden" name="stepTitle" value={s.title} />
						<input type="hidden" name="readings" value="[]" />
						<input type="hidden" name="observations" value="[]" />

						<div class="flex items-center justify-between gap-2">
							<div class="text-sm font-semibold text-[var(--color-tron-text)]">
								<span class="font-mono opacity-60">{s.number}.</span>
								{s.title}
								{#if entry?.flagged}
									<span class="ml-1 text-amber-300">⚠</span>
								{/if}
							</div>
							{#if done}
								<span class="text-[10px] text-emerald-400">
									✓ {fmtDate(entry.completedAt)}
									{#if entry.completedBy?.username}· {entry.completedBy.username}{/if}
									{#if entry.startedAt}· {elapsedBetween(entry.startedAt, entry.completedAt)}{/if}
								</span>
							{/if}
						</div>

						{#if s.timing && (s.timing.durationMinutes || s.timing.intervalMinutes || s.timing.temperatureC !== undefined || s.timing.rpm)}
							<div class="flex flex-wrap gap-2 text-[10px] text-[var(--color-tron-cyan)]">
								{#if s.timing.durationMinutes}<span>⏱ {s.timing.durationMinutes} min</span>{/if}
								{#if s.timing.intervalMinutes}<span>↻ every {s.timing.intervalMinutes} min</span>{/if}
								{#if s.timing.temperatureC !== undefined}<span>🌡 {s.timing.temperatureC}°C</span>{/if}
								{#if s.timing.rpm}<span>⟳ {s.timing.rpm} rpm</span>{/if}
							</div>
						{/if}

						<details class="text-xs">
							<summary class="cursor-pointer text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">
								Instructions
							</summary>
							<div class="mt-1 whitespace-pre-wrap text-[var(--color-tron-text)]">{s.instructions}</div>
						</details>

						<textarea name="note" rows="2" bind:value={quickNotes[s.key]}
							placeholder={`Notes for step ${s.number}…`}
							disabled={!isEditable}
							class="w-full resize-y rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]"></textarea>

						{#if isEditable}
							<div class="flex items-center justify-between">
								<label class="flex items-center gap-2 text-xs text-[var(--color-tron-text)]">
									<input type="checkbox" name="markCompleted" bind:checked={quickComplete[s.key]} />
									Mark complete
								</label>
								<button type="submit"
									class="rounded-md bg-[var(--color-tron-cyan)]/20 px-2 py-1 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/30">
									Save step {s.number}
								</button>
							</div>
						{/if}
					</form>
				{/each}
			{:else if activeStepKey === '__overview__'}
				<h2 class="text-base font-semibold text-[var(--color-tron-text)]">Setup &amp; Lineage</h2>
				<p class="text-xs text-[var(--color-tron-text-secondary)]">
					Everything here stays editable until the lot is finalized. Nothing is required — leave blanks
					where you don't have data and add a note instead.
				</p>

				<form method="POST" action="?/saveSetup" use:enhance class="space-y-4">
					<input type="hidden" name="parameterValues" value={buildSetupParamsPayload()} />
					<input type="hidden" name="inputLots" value={buildSetupInputLotsPayload()} />

					<div>
						<label for="setup-lot-barcode" class="block text-xs font-semibold uppercase tracking-wide text-[var(--color-tron-text-secondary)]">Lot Barcode</label>
						<input id="setup-lot-barcode" name="lotBarcode" type="text"
							bind:value={editedLotBarcode} disabled={!isEditable}
							class="mt-1 w-full max-w-sm rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 font-mono text-sm text-[var(--color-tron-text)]" />
					</div>

					{#if template.parameters?.length}
						<div>
							<h3 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-tron-text-secondary)]">Key Parameters</h3>
							<div class="mt-1 grid gap-2 sm:grid-cols-2">
								{#each template.parameters as p}
									<div>
										<label for={`sp-${p.key}`} class="block text-xs text-[var(--color-tron-text-secondary)]">
											{p.label} {#if p.unit}<span class="opacity-60">({p.unit})</span>{/if}
										</label>
										<input id={`sp-${p.key}`}
											type={p.type === 'number' ? 'number' : 'text'} step="any"
											bind:value={editedParams[p.key]} disabled={!isEditable}
											class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]" />
									</div>
								{/each}
							</div>
						</div>
					{/if}

					{#if preparedMaterials.length}
						<div>
							<h3 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-tron-text-secondary)]">Upstream Lots (Prepared Materials)</h3>
							<div class="mt-1 space-y-1">
								{#each preparedMaterials as m}
									{@const cands = candidatesFor(m)}
									<div class="grid grid-cols-[1fr_2fr] items-center gap-2 rounded-md bg-[var(--color-tron-surface)] p-2">
										<div class="text-xs font-semibold text-[var(--color-tron-text)]">{m.label}</div>
										{#if cands.length}
											<select disabled={!isEditable}
												onchange={(e) => {
													const val = (e.target as HTMLSelectElement).value;
													if (val) {
														const lotc = data.candidateLots.find((l: any) => l._id === val);
														editedPreparedPicks[m.key] = { sourceId: val, label: lotc?.lotBarcode ?? '' };
													} else {
														delete editedPreparedPicks[m.key];
														editedPreparedPicks = { ...editedPreparedPicks };
													}
												}}
												class="rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs text-[var(--color-tron-text)]">
												<option value="">— no upstream lot —</option>
												{#each cands as c}
													<option value={c._id} selected={editedPreparedPicks[m.key]?.sourceId === c._id}>
														{c.lotBarcode} ({c.templateName})
													</option>
												{/each}
											</select>
										{:else}
											<p class="text-[10px] text-[var(--color-tron-text-secondary)]">No upstream protocol declared — log in a note instead.</p>
										{/if}
									</div>
								{/each}
							</div>
						</div>
					{/if}

					{#if stockMaterials.length}
						<div>
							<h3 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-tron-text-secondary)]">Stock Materials</h3>
							<p class="text-[10px] text-[var(--color-tron-text-secondary)]">
								Optional — scan or type a supplier-lot barcode and/or override the concentration. Blank uses template defaults.
							</p>
							<div class="mt-1 space-y-1">
								{#each stockMaterials as m}
									{@const entry = editedStockEntries[m.key] ?? { barcode: '', concentration: '' }}
									<div class="grid grid-cols-[1fr_auto_auto] items-center gap-2 rounded-md bg-[var(--color-tron-surface)] p-2">
										<div class="text-xs">
											<div class="font-semibold text-[var(--color-tron-text)]">{m.label}</div>
											<div class="text-[10px] text-[var(--color-tron-text-secondary)]">
												default: {m.defaultConcentration ?? '—'} {m.defaultConcentrationUnit ?? ''}
											</div>
										</div>
										<input type="text" placeholder="scan/type barcode"
											value={entry.barcode} disabled={!isEditable}
											oninput={(e) => {
												const v = (e.target as HTMLInputElement).value;
												editedStockEntries[m.key] = { ...(editedStockEntries[m.key] ?? { barcode: '', concentration: '' }), barcode: v };
											}}
											class="w-44 rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 font-mono text-xs text-[var(--color-tron-text)]" />
										<input type="number" step="any" placeholder={m.defaultConcentration ? `${m.defaultConcentration}` : 'conc'}
											value={entry.concentration} disabled={!isEditable}
											oninput={(e) => {
												const v = (e.target as HTMLInputElement).value;
												editedStockEntries[m.key] = { ...(editedStockEntries[m.key] ?? { barcode: '', concentration: '' }), concentration: v };
											}}
											class="w-24 rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 font-mono text-xs text-[var(--color-tron-text)]" />
									</div>
								{/each}
							</div>
						</div>
					{/if}

					{#if isEditable}
						<div class="flex justify-end">
							<button type="submit"
								class="rounded-md bg-[var(--color-tron-cyan)]/20 px-3 py-1.5 text-sm text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/30">
								Save Setup
							</button>
						</div>
					{/if}
				</form>

				{#snippet lineageNode(node: any, depth: number)}
					<div class="ml-{depth * 4} pl-2 border-l border-[var(--color-tron-border)] py-1">
						<div class="flex flex-wrap items-center gap-2 text-xs">
							{#if node.materialKey}
								<span class="rounded bg-[var(--color-tron-surface)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)]">{node.materialKey}</span>
							{/if}
							<a href={`/manufacturing/reagent-lots/${node._id}`} class="font-mono text-[var(--color-tron-cyan)] hover:underline">{node.lotBarcode}</a>
							<span class="text-[var(--color-tron-text-secondary)]">— {node.templateName}</span>
							<span class="text-[10px] text-[var(--color-tron-text-secondary)]">{node.operator} · {node.status}</span>
							{#if node.startedAt && node.finalizedAt}
								<span class="text-[10px] text-[var(--color-tron-text-secondary)]">· elapsed {elapsedBetween(node.startedAt, node.finalizedAt)}</span>
							{/if}
						</div>
						{#if node.depthCapped}
							<div class="text-[10px] text-[var(--color-tron-text-secondary)] italic">↻ depth cap reached — open the lot to see further ancestry</div>
						{/if}
						{#each node.children as child}
							{@render lineageNode(child, depth + 1)}
						{/each}
					</div>
				{/snippet}

				{#if data.lineage?.children?.length}
					<div>
						<h3 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-tron-text-secondary)]">Lineage Tree</h3>
						<p class="text-[10px] text-[var(--color-tron-text-secondary)] mb-1">Walks upstream through every prepared-material parent, capped at depth 4.</p>
						<div class="rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-2">
							{#each data.lineage.children as child}
								{@render lineageNode(child, 0)}
							{/each}
						</div>
					</div>
				{/if}

				<div>
					<h3 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-tron-text-secondary)]">Flags</h3>
					{#if lot.flags?.length}
						<ul class="mt-1 space-y-1 text-sm">
							{#each lot.flags as f}
								<li class="rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1 text-xs text-amber-200">
									{#if f.source === 'observation'}🚩{:else}⚠{/if}
									Step {f.stepKey ?? '—'} · {f.reason}
								</li>
							{/each}
						</ul>
					{:else}
						<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">No out-of-range readings or concerns recorded.</p>
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
							<div class="text-right text-xs">
								<div class="text-emerald-400">✓ completed {fmtDate(activeEntry.completedAt)}</div>
								<div class="text-[var(--color-tron-text-secondary)]">
									duration {elapsedBetween(activeEntry.startedAt, activeEntry.completedAt)}
									{#if activeEntry.completedBy?.username}
										· by {activeEntry.completedBy.username}
									{/if}
								</div>
							</div>
						{/if}
					</div>

					{#if activeStep.timing && (activeStep.timing.durationMinutes || activeStep.timing.intervalMinutes || activeStep.timing.temperatureC !== undefined || activeStep.timing.rpm)}
						{@const expectedMs = (activeStep.timing.durationMinutes ?? 0) * 60_000}
						{@const stepElapsed = activeEntry?.startedAt && !activeEntry?.completedAt ? now - new Date(activeEntry.startedAt).getTime() : null}
						<div class="rounded-md border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/5 p-2 text-xs text-[var(--color-tron-text)]">
							<div class="flex flex-wrap gap-3 text-[var(--color-tron-text)]">
								{#if activeStep.timing.durationMinutes}
									<span>⏱ Expected duration: <strong class="text-[var(--color-tron-cyan)]">{activeStep.timing.durationMinutes} min</strong></span>
								{/if}
								{#if activeStep.timing.intervalMinutes}
									<span>↻ Check every <strong class="text-[var(--color-tron-cyan)]">{activeStep.timing.intervalMinutes} min</strong></span>
								{/if}
								{#if activeStep.timing.temperatureC !== undefined}
									<span>🌡 <strong class="text-[var(--color-tron-cyan)]">{activeStep.timing.temperatureC} °C</strong></span>
								{/if}
								{#if activeStep.timing.rpm}
									<span>⟳ <strong class="text-[var(--color-tron-cyan)]">{activeStep.timing.rpm} rpm</strong></span>
								{/if}
								{#if activeStep.timing.notes}
									<span class="text-[var(--color-tron-text-secondary)]">— {activeStep.timing.notes}</span>
								{/if}
							</div>
							{#if stepElapsed !== null}
								{@const remainingMs = expectedMs - stepElapsed}
								<div class="mt-1 flex items-center gap-2">
									<span>Step started {fmtDate(activeEntry.startedAt)} ·</span>
									<strong class={remainingMs < 0 ? 'text-amber-300' : 'text-[var(--color-tron-cyan)]'}>
										{fmtDuration(stepElapsed)} elapsed
									</strong>
									{#if expectedMs > 0}
										<span class="text-[var(--color-tron-text-secondary)]">
											({remainingMs > 0 ? `${fmtDuration(remainingMs)} remaining` : `${fmtDuration(-remainingMs)} over`})
										</span>
									{/if}
								</div>
							{/if}
						</div>
					{/if}

					<div class="rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 text-sm text-[var(--color-tron-text)] whitespace-pre-wrap">
						{activeStep.instructions}
					</div>

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
									<div class="rounded-md border {observationConcerns[p.key] ? 'border-amber-500/60 bg-amber-500/5' : 'border-transparent'} p-1">
										<div class="flex items-center justify-between gap-2">
											<label class="text-xs text-[var(--color-tron-text-secondary)]" for={`o-${p.key}`}>{p.label}</label>
											<label class="flex items-center gap-1 text-[10px] text-amber-300" title="Mark this observation as a concern — bubbles up to the lot's flag count">
												<input type="checkbox" bind:checked={observationConcerns[p.key]} disabled={!isEditable} onchange={markDirty} />
												flag as concern
											</label>
										</div>
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
