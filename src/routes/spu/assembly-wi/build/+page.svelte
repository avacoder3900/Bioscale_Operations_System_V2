<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount, tick } from 'svelte';
	import type { SubmitFunction } from '@sveltejs/kit';
	import {
		buildProgress,
		buildStatus,
		currentStep,
		deducts,
		firstOpenSection,
		bucketLabel,
		normalizeBucketCode,
		partsOf,
		partsProgress,
		scanKey,
		sectionConfirmed,
		stepTitle,
		tabLabel,
		toolsOf,
		type BuildTone
	} from '$lib/spu-build/progress';

	let { data } = $props();

	type Msg = { kind: 'ok' | 'warn'; text: string };
	type Operator = { name: string; badgeCode: string | null };

	// ── view state ────────────────────────────────────────────────────────────
	let operator = $state<Operator | null>(null);
	let nameDraft = $state('');
	let gateError = $state<string | null>(null);
	let view = $state<'board' | 'build'>('board');
	let activeId = $state<string | null>(null);
	let activeSection = $state<number>(0);
	let scan = $state('');
	let msg = $state<Msg | null>(null);
	// An unknown QR code waiting for "Add as Bucket N" (from the scan bar), and the "Add a new bucket" panel.
	let pending = $state<{ code: string; number: number } | null>(null);
	let addingBucket = $state(false);
	let newQr = $state('');
	let newQrInput = $state<HTMLInputElement | null>(null);
	let busy = $state(false);
	let scanInput = $state<HTMLInputElement | null>(null);
	let scanForm = $state<HTMLFormElement | null>(null);
	let registerForm = $state<HTMLFormElement | null>(null);
	// The current step's own scan box (only that step has one), and the section's confirm panel.
	let stepScan = $state('');
	let stepInput = $state<HTMLInputElement | null>(null);
	let confirmPanel = $state<HTMLElement | null>(null);
	// Scans that arrive while the last one is still saving run next, in order, instead of being dropped.
	const queued: string[] = [];
	// The operator lives in page state, so the gate must not submit before the
	// page is interactive (a fast scanner can beat hydration). With its only
	// submit button disabled, Enter in the field doesn't submit the form either.
	let ready = $state(false);
	onMount(() => (ready = true));

	// ── corrections (undo a scan, reopen a section, cancel a build) ───────────
	type CorrectionKind = 'scan' | 'section' | 'cancel';
	const REASONS: Record<CorrectionKind, string[]> = {
		scan: ['Wrong bag scanned', 'Scanned for the wrong SPU', 'Part not used', 'Other'],
		section: ['Confirmed by mistake', 'Work has to be redone', 'Other'],
		cancel: ['Started by mistake', 'Wrong bucket', 'Build abandoned', 'Other']
	};
	let correcting = $state<{ kind: CorrectionKind; id: string } | null>(null);
	let reasonPick = $state('');
	let reasonNote = $state('');
	let cancelParts = $state<'return' | 'keep'>('return');
	const reasonOk = $derived(Boolean(reasonPick) && (reasonPick !== 'Other' || Boolean(reasonNote.trim())));
	function startCorrection(kind: CorrectionKind, id: string) {
		correcting = { kind, id };
		reasonPick = '';
		reasonNote = '';
		cancelParts = 'return';
	}
	const isCorrecting = (kind: CorrectionKind, id: string) => correcting?.kind === kind && correcting.id === id;

	const sections = $derived<any[]>(data.wi?.sections ?? []);
	const wiLike = $derived({ sections });
	const totalSteps = $derived(sections.reduce((n, s) => n + s.steps.length, 0));
	const active = $derived<any | null>(view === 'build' ? (data.builds.find((b: any) => b._id === activeId) ?? null) : null);
	const section = $derived<any | null>(sections.find((s) => s.number === activeSection) ?? sections[0] ?? null);
	const canAct = $derived(Boolean(data.canBuild && operator && active?.status === 'in_progress'));
	// Corrections also work on a completed build (it reopens); a cancelled one only allows returning parts.
	const canCorrect = $derived(Boolean(data.canBuild && operator && active && active.status !== 'cancelled'));
	const deductedOnActive = $derived((active?.scans ?? []).filter((s: any) => s.status === 'recorded' && s.deducted).length);
	const openBuilds = $derived(data.builds.filter((b: any) => b.status === 'in_progress' || b._id === activeId));

	// stepId|materialId → live (not undone) scan, and stepId → completion, for the active build
	const scanFor = $derived.by(() => {
		const map = new Map<string, any>();
		for (const s of active?.scans ?? []) if (s.status !== 'undone') map.set(scanKey(s.stepId, s.materialId), s);
		return map;
	});
	const doneFor = $derived.by(() => new Map<string, any>((active?.completedSteps ?? []).map((c: any) => [c.stepId, c])));
	// The step whose parts are scanned now (parts go in step by step), and whether this section is confirmed.
	const current = $derived<any | null>(active && section ? currentStep(section, active) : null);
	const confirmed = $derived(Boolean(active && section && sectionConfirmed(section, active)));
	const sectionRec = $derived<any | null>(section ? (section.steps.map((st: any) => doneFor.get(st._id)).find(Boolean) ?? null) : null);
	const sectionPartsLeft = $derived(active && section ? partsProgress([section], active).total - partsProgress([section], active).scanned : 0);

	// Every recorded or undone scan across the builds on the board, newest event first.
	const eventAt = (s: any) => new Date(s.undoneAt ?? s.scannedAt).getTime();
	const deductions = $derived.by(() =>
		data.builds
			.flatMap((b: any) => (b.scans ?? []).filter((s: any) => s.status === 'recorded' || s.status === 'undone').map((s: any) => ({ ...s, build: b })))
			.sort((a: any, b: any) => eventAt(b) - eventAt(a))
			.slice(0, 15)
	);

	// ── helpers ───────────────────────────────────────────────────────────────
	function fmt(d: string | null | undefined) {
		return d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
	}
	function sectionName(n: number | null | undefined) {
		const s = sections.find((x) => x.number === n);
		return s ? tabLabel(s) : `Section ${n}`;
	}
	function onHand(m: any): number | null {
		return m.partDefinitionId && m.partDefinitionId in data.stock ? data.stock[m.partDefinitionId] : null;
	}
	function toolList(step: any) {
		return toolsOf(step).map((m: any) => (m.partNumber ? `${m.name} (${m.partNumber})` : m.name)).join(', ');
	}
	const toneClass: Record<BuildTone, string> = {
		done: 'border-green-500/40 bg-green-900/20 text-green-300',
		idle: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]',
		active: 'border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/10 text-[var(--color-tron-cyan)]',
		cancelled: 'border-red-500/30 bg-red-900/10 text-red-300'
	};
	const msgClass = (m: Msg) =>
		m.kind === 'ok' ? 'border-green-500/30 bg-green-900/20 text-green-300' : 'border-amber-500/30 bg-amber-900/20 text-amber-200';

	/**
	 * Put the cursor where the next scan goes: the current step's scan box, or the
	 * bucket scan bar when nothing in this section needs scanning. 'next' (after a
	 * part is scanned) also scrolls to that step — or, once the section's parts are
	 * all in, to its confirm button. The confirm button itself never takes focus,
	 * so a scanner's Enter can't confirm a section by accident.
	 */
	async function focusScan(mode: 'stay' | 'next' = 'stay') {
		await tick();
		if (view === 'build' && canAct && current && stepInput) {
			stepInput.focus({ preventScroll: true });
			if (mode === 'next') stepInput.closest('article')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
			return;
		}
		scanInput?.focus({ preventScroll: view === 'build' });
		if (mode === 'next' && view === 'build' && canAct && !confirmed) confirmPanel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}

	function openBuild(b: any, text?: string) {
		activeId = b._id;
		view = 'build';
		activeSection = firstOpenSection(wiLike, b)?.number ?? sections[0]?.number ?? 0;
		pending = null;
		msg = text ? { kind: 'ok', text } : null;
		focusScan();
	}

	function goBoard() {
		view = 'board';
		msg = null;
		focusScan();
	}

	function changeOperator() {
		operator = null;
		nameDraft = '';
		gateError = null;
		pending = null;
		addingBucket = false;
		msg = null;
	}

	async function startAddingBucket() {
		addingBucket = true;
		newQr = '';
		pending = null;
		msg = null;
		await tick();
		newQrInput?.focus();
	}

	function applyResult(result: any) {
		if (result.type === 'success') msg = { kind: result.data?.kind === 'warn' ? 'warn' : 'ok', text: result.data?.message ?? 'Done.' };
		else if (result.type === 'failure') msg = { kind: 'warn', text: result.data?.error ?? 'That did not work.' };
		else if (result.type === 'error') msg = { kind: 'warn', text: 'Something went wrong. Reload the page and check Inventory deductions before scanning again.' };
	}

	// ── forms ─────────────────────────────────────────────────────────────────
	// The gate: a typed name stays on this page; a badge (BDG-…) is resolved by the server.
	const identifyEnhance: SubmitFunction = ({ cancel }) => {
		const value = nameDraft.trim();
		gateError = null;
		if (!value) return cancel();
		if (!/^BDG-/i.test(value)) {
			cancel();
			operator = { name: value, badgeCode: null };
			focusScan();
			return;
		}
		busy = true;
		return async ({ result }) => {
			busy = false;
			if (result.type === 'success' && result.data?.operator) {
				operator = result.data.operator as Operator;
				nameDraft = '';
				focusScan();
			} else if (result.type === 'failure') {
				gateError = (result.data?.error as string) ?? 'That badge could not be read.';
			} else {
				gateError = 'That badge could not be read. Try again or type your name.';
			}
		};
	};

	function runNextQueued() {
		const next = queued.shift();
		if (next == null) return;
		scan = next;
		tick().then(() => scanForm?.requestSubmit());
	}

	// The scan bar. A bucket whose SPU is already on this page opens straight away;
	// every other code goes to the server, which decides what it is (see
	// handleScan): a registered bucket (opens or starts its SPU), an unknown QR
	// code (offered as the next bucket number), or a bag lot label to deduct.
	const scanEnhance: SubmitFunction = ({ cancel }) => {
		const code = scan.trim();
		// Confirm a new bucket: Enter on the empty field, or the same QR code scanned again.
		if (pending && (!code || normalizeBucketCode(code) === pending.code)) {
			cancel();
			scan = '';
			registerForm?.requestSubmit();
			return;
		}
		if (!code) return cancel();
		scan = ''; // the form data is already taken; clear now so the next scan starts clean
		if (busy) {
			cancel();
			queued.push(code);
			return;
		}
		const local = normalizeBucketCode(code);
		const found = local ? data.builds.find((b: any) => b.status === 'in_progress' && b.bucketCode === local) : null;
		if (found) {
			cancel();
			openBuild(found, `${bucketLabel(found)} scanned. Now working on SPU ${found.buildNumber}.`);
			return;
		}
		pending = null;
		busy = true;
		return afterScan;
	};

	// After any scan: open a bucket's build, offer a new bucket, or show what the part scan did —
	// then move the cursor to where the next scan goes (the same step, the next step, or the confirm button).
	async function afterScan({ result, update }: any) {
		await update({ reset: false });
		busy = false;
		const d: any = result.type === 'success' ? result.data : null;
		if (d?.action === 'open') {
			const b = data.builds.find((x: any) => x._id === d.buildId);
			if (b) openBuild(b, d.message);
			else applyResult(result);
		} else if (d?.action === 'register-bucket') {
			pending = { code: d.bucketCode, number: d.bucketNumber };
			msg = d.message ? { kind: 'warn', text: d.message } : null;
		} else {
			applyResult(result);
		}
		await focusScan(d?.action ? 'stay' : 'next');
		runNextQueued();
	}

	// The current step's scan box: bag barcodes for that step's parts. The server
	// files each part against the current step and refuses parts from later steps.
	const stepScanEnhance: SubmitFunction = ({ cancel }) => {
		const code = stepScan.trim();
		if (!code) return cancel();
		stepScan = ''; // the form data is already taken
		if (busy) {
			cancel();
			queued.push(code);
			return;
		}
		busy = true;
		return afterScan;
	};

	// "Confirm <section> complete": on success, go to the next section still to do.
	const sectionEnhance: SubmitFunction = () => {
		busy = true;
		return async ({ result, update }) => {
			await update({ reset: false });
			busy = false;
			applyResult(result);
			if (result.type === 'success' && active && result.data?.kind === 'ok') {
				const at = sections.findIndex((s) => s.number === activeSection);
				const next = [...sections.slice(at + 1), ...sections.slice(0, at)].find((s) => !sectionConfirmed(s, active));
				if (next) {
					activeSection = next.number;
					await tick();
					window.scrollTo({ top: 0, behavior: 'smooth' });
				}
			}
			focusScan();
		};
	};

	// Adding a bucket: from the scan bar (start=1, opens the new SPU) or the "Add a new bucket" panel (register only).
	const registerEnhance: SubmitFunction = () => {
		busy = true;
		return async ({ result, update }) => {
			await update({ reset: false });
			busy = false;
			applyResult(result);
			if (result.type === 'success') {
				pending = null;
				addingBucket = false;
				newQr = '';
				const id = result.data?.buildId as string | undefined;
				const b = id ? data.builds.find((x: any) => x._id === id) : null;
				if (b) openBuild(b, result.data?.message as string);
			}
			focusScan();
		};
	};

	const actionEnhance: SubmitFunction = () => {
		busy = true;
		return async ({ result, update }) => {
			await update({ reset: false });
			busy = false;
			applyResult(result);
			focusScan('next');
		};
	};

	// Corrections close their panel on success; on failure it stays open with the message above.
	const correctionEnhance: SubmitFunction = () => {
		busy = true;
		return async ({ result, update }) => {
			await update({ reset: false });
			busy = false;
			applyResult(result);
			if (result.type === 'success') correcting = null;
			focusScan('next');
		};
	};
</script>

<svelte:head><title>Build SPUs · BIMS</title></svelte:head>

{#snippet who()}
	<input type="hidden" name="operatorName" value={operator?.name ?? ''} />
	<input type="hidden" name="badge" value={operator?.badgeCode ?? ''} />
{/snippet}

{#snippet reasonFields(kind: CorrectionKind)}
	<label class="flex flex-col gap-1 text-xs font-semibold text-[var(--color-tron-text-secondary)]">
		Why
		<select name="reason" bind:value={reasonPick} required class="min-h-11 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 text-sm font-normal text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none">
			<option value="" disabled>Choose a reason</option>
			{#each REASONS[kind] as r (r)}<option value={r}>{r}</option>{/each}
		</select>
	</label>
	<label class="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs font-semibold text-[var(--color-tron-text-secondary)]">
		Note {reasonPick === 'Other' ? '(required)' : '(optional)'}
		<input name="note" bind:value={reasonNote} maxlength="160" autocomplete="off" class="min-h-11 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 text-sm font-normal text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none" />
	</label>
{/snippet}

{#snippet keepButton(label: string)}
	<button type="button" onclick={() => { correcting = null; focusScan(); }} class="min-h-11 rounded border border-[var(--color-tron-border)] px-4 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">{label}</button>
{/snippet}

<div class="space-y-5">
	<!-- ═══ Header ═══ -->
	<div class="flex flex-wrap items-center justify-between gap-4">
		<div>
			<p class="text-xs text-[var(--color-tron-text-secondary)]">
				<a href="/spu" class="hover:text-[var(--color-tron-cyan)] hover:underline">SPU</a>
				/ <a href="/spu/assembly-wi" class="hover:text-[var(--color-tron-cyan)] hover:underline">SPU Assembly WI</a>
				{#if data.wi}· <span class="font-mono">{data.wi.documentNumber} · v{data.wi.currentVersion}</span>{/if}
			</p>
			<h1 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Build SPUs</h1>
		</div>
		{#if operator}
			<div class="flex items-center gap-3">
				<span class="text-sm text-[var(--color-tron-text-secondary)]">Operator</span>
				<span class="font-semibold text-[var(--color-tron-text)]">{operator.name}</span>
				<button type="button" onclick={changeOperator} class="min-h-11 rounded border border-[var(--color-tron-border)] px-3 text-sm text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]">Change operator</button>
			</div>
		{/if}
	</div>

	{#if !data.wi}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 text-sm text-[var(--color-tron-text-secondary)]">
			No work instruction has been imported yet. <a href="/spu/assembly-wi" class="text-[var(--color-tron-cyan)] underline">Import the SPU Assembly WI</a> before building.
		</div>
	{:else}
		{#if !data.canBuild}
			<p class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]">
				You can follow builds here. Starting builds and scanning parts needs SPU write access.
			</p>
		{/if}

		<!-- ═══ Gate: who is building? ═══ -->
		{#if data.canBuild && !operator}
			<section class="mx-auto mt-10 max-w-md rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-8">
				<h2 class="text-2xl font-semibold text-[var(--color-tron-text)]">Who is building?</h2>
				<p class="mt-2 mb-6 text-sm text-[var(--color-tron-text-secondary)]">
					Enter your name or scan your badge before you start. It is recorded on every build you start, every step you complete and every part you scan.
				</p>
				<form method="POST" action="?/identify" use:enhance={identifyEnhance} class="flex flex-col gap-3">
					<label for="opname" class="text-sm font-semibold text-[var(--color-tron-text)]">Your name or badge</label>
					<input
						id="opname"
						name="badge"
						type="text"
						autocomplete="off"
						bind:value={nameDraft}
						class="min-h-12 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-4 text-lg text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
					/>
					{#if gateError}<p role="alert" class="text-sm text-amber-300">{gateError}</p>{/if}
					<button type="submit" disabled={!ready || !nameDraft.trim() || busy} class="min-h-12 rounded bg-[var(--color-tron-cyan)] font-semibold text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
						{busy ? 'Checking badge…' : 'Start building'}
					</button>
				</form>
			</section>
		{/if}

		<!-- ═══ Scan bar ═══ -->
		{#if data.canBuild && operator}
			<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-5 py-4">
				<form method="POST" action="?/scan" use:enhance={scanEnhance} bind:this={scanForm} class="flex flex-wrap items-end gap-3">
					{@render who()}
					<input type="hidden" name="buildId" value={active?.status === 'in_progress' ? active._id : ''} />
					<input type="hidden" name="sectionNumber" value={section?.number ?? ''} />
					<div class="flex min-w-[18rem] flex-1 flex-col gap-1.5">
						<label for="scan" class="text-sm font-semibold text-[var(--color-tron-text)]">Scan the Bucket Barcode</label>
						<input
							id="scan"
							name="code"
							type="text"
							autocomplete="off"
							placeholder="Scan the QR code on the bucket"
							bind:value={scan}
							bind:this={scanInput}
							class="min-h-12 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-4 font-mono text-lg text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
						/>
					</div>
					<!-- Never disabled: a disabled submit button also blocks Enter in the field, which drops scans. -->
					<button type="submit" class="min-h-12 rounded bg-[var(--color-tron-cyan)] px-5 font-semibold text-black hover:opacity-90">{busy ? 'Recording…' : 'Enter'}</button>
				</form>
				{#if msg && !(view === 'build' && canAct)}
					<p role="status" class="mt-3 rounded border px-4 py-2.5 text-sm font-medium {msgClass(msg)}">{msg.text}</p>
				{/if}
				{#if pending}
					<form method="POST" action="?/registerBucket" use:enhance={registerEnhance} bind:this={registerForm} class="mt-3 flex flex-wrap items-center justify-between gap-3 rounded border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/10 px-4 py-3">
						{@render who()}
						<input type="hidden" name="qrCode" value={pending.code} />
						<input type="hidden" name="start" value="1" />
						<span class="font-medium text-[var(--color-tron-text)]">
							This QR code isn't a bucket yet. Add it as <strong>Bucket {pending.number}</strong> and start SPU {data.nextBuildNumber} in it, with {operator.name} as the builder?
							<span class="block font-mono text-xs font-normal text-[var(--color-tron-text-secondary)]">{pending.code}</span>
							<span class="block text-sm font-normal text-[var(--color-tron-text-secondary)]">Scan it again or press Enter to add it.</span>
						</span>
						<div class="flex gap-2">
							<button type="submit" disabled={busy} class="min-h-11 rounded bg-[var(--color-tron-cyan)] px-4 font-semibold text-black hover:opacity-90 disabled:opacity-50">Add as Bucket {pending.number}</button>
							<button type="button" onclick={() => { pending = null; focusScan(); }} class="min-h-11 rounded border border-[var(--color-tron-border)] px-4 text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">Cancel</button>
						</div>
					</form>
				{/if}
			</section>
		{/if}

		<!-- ═══ Board ═══ -->
		{#if (!data.canBuild || operator) && view === 'board'}
			<section>
				<!-- Buckets: every registered QR code and what is in it -->
				<div class="mb-5 flex flex-wrap items-center gap-2">
					<span class="text-xs font-semibold text-[var(--color-tron-text-secondary)]">Buckets</span>
					{#each data.buckets as k (k._id)}
						{@const holder = data.builds.find((b: any) => b.status === 'in_progress' && b.bucketCode === k.qrCode)}
						<span title={k.qrCode} class="rounded border px-3 py-1.5 text-sm {holder ? 'border-[var(--color-tron-cyan)]/40 text-[var(--color-tron-text)]' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}">
							<span class="font-semibold text-[var(--color-tron-text)]">Bucket {k.number}</span> · {holder ? `SPU ${holder.buildNumber} in progress` : 'empty'}
						</span>
					{:else}
						<span class="text-sm text-[var(--color-tron-text-secondary)]">None yet.</span>
					{/each}
					{#if data.canBuild && operator && !addingBucket}
						<button type="button" onclick={startAddingBucket} class="min-h-11 rounded border border-dashed border-[var(--color-tron-cyan)]/60 px-3.5 text-sm font-semibold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10">+ Add a new bucket</button>
					{/if}
				</div>
				{#if data.canBuild && operator && addingBucket}
					<form method="POST" action="?/registerBucket" use:enhance={registerEnhance} class="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/10 px-5 py-4">
						{@render who()}
						<input type="hidden" name="start" value="0" />
						<div class="flex min-w-[18rem] flex-1 flex-col gap-1.5">
							<label for="newqr" class="text-sm font-semibold text-[var(--color-tron-text)]">Scan the new bucket's QR code. It becomes Bucket {data.nextBucketNumber}.</label>
							<input id="newqr" name="qrCode" type="text" autocomplete="off" bind:value={newQr} bind:this={newQrInput} class="min-h-12 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-4 font-mono text-lg text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none" />
						</div>
						<button type="submit" disabled={busy || !newQr.trim()} class="min-h-12 rounded bg-[var(--color-tron-cyan)] px-5 font-semibold text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">Add as Bucket {data.nextBucketNumber}</button>
						<button type="button" onclick={() => { addingBucket = false; focusScan(); }} class="min-h-12 rounded border border-[var(--color-tron-border)] px-4 text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">Cancel</button>
					</form>
				{/if}

				<h2 class="text-xl font-semibold text-[var(--color-tron-text)]">Builds in progress</h2>
				<p class="mt-1 mb-4 text-sm text-[var(--color-tron-text-secondary)]">One bucket per SPU. Scan a bucket's QR code to open its build steps; an empty bucket starts the next SPU.</p>
				{#if !data.builds.length}
					<div class="rounded-lg border border-dashed border-[var(--color-tron-border)] p-6 text-sm text-[var(--color-tron-text-secondary)]">
						No builds yet. Scan a bucket's QR code to start SPU {data.nextBuildNumber}.
					</div>
				{:else}
					<div class="overflow-x-auto rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
						<table class="w-full min-w-[56rem] text-left text-sm">
							<thead class="bg-[var(--color-tron-bg)] text-xs text-[var(--color-tron-text-secondary)]">
								<tr>
									<th scope="col" class="px-4 py-2.5 font-semibold">Bucket</th>
									<th scope="col" class="px-4 py-2.5 font-semibold">SPU</th>
									<th scope="col" class="px-4 py-2.5 font-semibold">Status</th>
									<th scope="col" class="px-4 py-2.5 font-semibold">Progress</th>
									<th scope="col" class="px-4 py-2.5 font-semibold">Started by</th>
									<th scope="col" class="px-4 py-2.5 font-semibold">Started</th>
									<th scope="col" class="px-4 py-2.5 font-semibold">Last activity</th>
									<th scope="col" class="px-4 py-2.5"><span class="sr-only">Open</span></th>
								</tr>
							</thead>
							<tbody>
								{#each data.builds as b (b._id)}
									{@const status = buildStatus(wiLike, b)}
									{@const p = buildProgress(wiLike, b)}
									{@const pp = partsProgress(sections, b)}
									<tr class="border-t border-[var(--color-tron-border)]">
										<td class="whitespace-nowrap px-4 py-3.5 font-semibold text-[var(--color-tron-text)]">{bucketLabel(b)}</td>
										<td class="whitespace-nowrap px-4 py-3.5 font-semibold text-[var(--color-tron-text)]">SPU {b.buildNumber}</td>
										<td class="whitespace-nowrap px-4 py-3.5"><span class="inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold {toneClass[status.tone]}">{status.label}</span></td>
										<td class="min-w-[11rem] px-4 py-3.5">
											<div class="h-2 overflow-hidden rounded bg-[var(--color-tron-border)]"><div class="h-2 bg-[var(--color-tron-cyan)]" style="width: {p.total ? Math.round((p.done / p.total) * 100) : 0}%"></div></div>
											<div class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">{p.done} of {p.total} steps{pp.total ? ` · ${pp.scanned} of ${pp.total} parts` : ''}</div>
										</td>
										<td class="px-4 py-3.5 text-[var(--color-tron-text)]">{b.startedBy?.name}</td>
										<td class="px-4 py-3.5 text-[var(--color-tron-text-secondary)]">{fmt(b.startedAt)}</td>
										<td class="px-4 py-3.5 text-[var(--color-tron-text-secondary)]">{b.lastActivityBy ? `${b.lastActivityBy} · ${fmt(b.lastActivityAt)}` : 'No activity yet'}</td>
										<td class="px-4 py-2">
											<button type="button" onclick={() => openBuild(b)} aria-label="Open SPU {b.buildNumber} in {bucketLabel(b)}" class="min-h-11 rounded border border-[var(--color-tron-cyan)]/50 px-4 font-semibold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10">Open</button>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</section>
		{/if}

		<!-- ═══ One build ═══ -->
		{#if (!data.canBuild || operator) && active && section}
			{@const status = buildStatus(wiLike, active)}
			{@const p = buildProgress(wiLike, active)}
			<section class="space-y-4">
				<div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
					<div>
						<h2 class="text-2xl font-semibold text-[var(--color-tron-text)]">SPU {active.buildNumber} · {bucketLabel(active)}</h2>
						<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">Started by {active.startedBy?.name} · {fmt(active.startedAt)} · {status.label} · {p.done} of {p.total} steps</p>
					</div>
					<div class="flex flex-wrap gap-2">
						{#if canAct && !isCorrecting('cancel', active._id)}
							<button type="button" onclick={() => startCorrection('cancel', active._id)} class="min-h-11 rounded border border-red-500/40 px-4 font-semibold text-red-300 hover:bg-red-900/20">Cancel build</button>
						{/if}
						<button type="button" onclick={goBoard} class="min-h-11 rounded border border-[var(--color-tron-border)] px-4 font-semibold text-[var(--color-tron-text)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]">All builds</button>
					</div>
				</div>

				{#if canAct && isCorrecting('cancel', active._id)}
					<form method="POST" action="?/cancelBuild" use:enhance={correctionEnhance} class="space-y-3 rounded-lg border border-red-500/40 bg-red-900/10 px-5 py-4">
						{@render who()}
						<input type="hidden" name="buildId" value={active._id} />
						<p class="font-semibold text-[var(--color-tron-text)]">Cancel SPU {active.buildNumber}? {bucketLabel(active)} is freed for a new build. The record stays, marked cancelled.</p>
						{#if deductedOnActive}
							<fieldset class="space-y-2 text-sm text-[var(--color-tron-text)]">
								<legend class="mb-1 text-xs font-semibold text-[var(--color-tron-text-secondary)]">{deductedOnActive} scanned part{deductedOnActive === 1 ? ' was' : 's were'} deducted from stock for this build</legend>
								<label class="flex min-h-11 items-center gap-3"><input type="radio" name="parts" value="return" bind:group={cancelParts} class="h-5 w-5" /> {deductedOnActive === 1 ? 'Put it back in stock (it goes back in its bag)' : 'Put them back in stock (they go back in their bags)'}</label>
								<label class="flex min-h-11 items-center gap-3"><input type="radio" name="parts" value="keep" bind:group={cancelParts} class="h-5 w-5" /> {deductedOnActive === 1 ? 'Leave it deducted (it was used or scrapped)' : 'Leave them deducted (they were used or scrapped)'}</label>
							</fieldset>
						{/if}
						<div class="flex flex-wrap items-end gap-3">
							{@render reasonFields('cancel')}
						</div>
						<div class="flex flex-wrap gap-2">
							<button type="submit" disabled={busy || !reasonOk} class="min-h-11 rounded bg-red-500 px-4 font-semibold text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">Cancel SPU {active.buildNumber}</button>
							{@render keepButton('Keep building')}
						</div>
					</form>
				{/if}

				{#if active.status === 'cancelled'}
					<p class="rounded border border-red-500/30 bg-red-900/10 px-4 py-2.5 text-sm text-red-200">
						Cancelled by {active.cancelledBy?.name} · {fmt(active.cancelledAt)} · {active.cancelReason}.
						{#if active.partsReturnedOnCancel === true}Its scanned parts went back in stock.{:else if active.partsReturnedOnCancel === false}Its scanned parts were left deducted; undo any that go back on the shelf.{/if}
					</p>
				{/if}

				{#if active.corrections?.length}
					<details class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-4 py-2.5 text-sm">
						<summary class="cursor-pointer text-xs font-semibold text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">Corrections ({active.corrections.length})</summary>
						<ul class="mt-2 space-y-1.5">
							{#each [...active.corrections].reverse() as c (c._id)}
								<li class="border-t border-[var(--color-tron-border)] pt-1.5">
									<span class="text-[var(--color-tron-text)]">{c.summary}</span>
									<span class="text-[var(--color-tron-text-secondary)]"> · {c.reason} · {c.operator?.name} · {fmt(c.at)}</span>
								</li>
							{/each}
						</ul>
					</details>
				{/if}

				{#if openBuilds.length > 1}
					<div class="flex flex-wrap items-center gap-2">
						<span class="text-xs text-[var(--color-tron-text-secondary)]">Switch bucket</span>
						{#each openBuilds as b (b._id)}
							<button
								type="button"
								onclick={() => openBuild(b)}
								aria-pressed={b._id === active._id}
								class="min-h-11 rounded border px-3.5 text-sm font-semibold {b._id === active._id ? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text)] hover:border-[var(--color-tron-cyan)]'}"
							>{bucketLabel(b)} · SPU {b.buildNumber}</button>
						{/each}
					</div>
				{/if}

				<div role="tablist" aria-label="Work instruction sections" class="flex flex-wrap gap-1.5">
					{#each sections as s (s._id)}
						{@const sel = s.number === section.number}
						{@const ok = sectionConfirmed(s, active)}
						{@const pp = partsProgress([s], active)}
						<button
							type="button"
							role="tab"
							aria-selected={sel}
							onclick={() => { activeSection = s.number; msg = null; focusScan(); }}
							title="{tabLabel(s)} — {s.title}"
							class="min-h-11 rounded border px-3.5 text-sm font-semibold {sel ? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)] text-black' : ok ? 'border-green-500/50 bg-green-900/20 text-green-300' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text)] hover:border-[var(--color-tron-cyan)]'}"
						>{tabLabel(s)} <span class="font-normal">{ok ? '· Done' : pp.total ? `${pp.scanned}/${pp.total}` : ''}</span></button>
					{/each}
				</div>

				<div class="flex flex-wrap items-start gap-5">
					<!-- steps: everything shown at once; parts are scanned step by step -->
					<div class="flex min-w-0 flex-[999_1_35rem] flex-col gap-3">
						<h3 class="text-lg font-semibold text-[var(--color-tron-text)]">{tabLabel(section)} — {section.title}</h3>
						{#if !section.steps.length}
							<p class="text-sm text-[var(--color-tron-text-secondary)]">No steps in this section.</p>
						{/if}
						{#each section.steps as step (step._id)}
							{@const parts = partsOf(step)}
							{@const left = parts.filter((m) => !scanFor.has(scanKey(step._id, m._id))).length}
							{@const isCurrent = canAct && current?._id === step._id}
							{@const tools = toolList(step)}
							<article class="rounded-lg border bg-[var(--color-tron-surface)] px-5 py-4 {isCurrent ? 'border-[var(--color-tron-cyan)] ring-1 ring-[var(--color-tron-cyan)]/40' : 'border-[var(--color-tron-border)]'}">
								<div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
									<h4 class="flex-[1_1_20rem] font-semibold text-[var(--color-tron-text)]">Step {step.stepNumber}. {stepTitle(step)}</h4>
									<div class="flex items-center gap-2">
										{#if step.requiresEsd}<span class="rounded-full border border-red-500/40 bg-red-900/20 px-2.5 py-0.5 text-xs font-semibold text-red-300">ESD</span>{/if}
										<span class="rounded-full border px-2.5 py-0.5 text-xs font-semibold {confirmed || (parts.length && !left) ? toneClass.done : isCurrent ? toneClass.active : toneClass.idle}">
											{confirmed ? 'Done' : !parts.length ? 'No parts to scan' : !left ? 'Parts scanned' : isCurrent ? `Scan now · ${left} of ${parts.length} left` : `${left} part${left === 1 ? '' : 's'} to scan`}
										</span>
									</div>
								</div>

								{#if step.instructionsHtml || step.images?.length}
									<div class="mt-3 grid gap-3 lg:grid-cols-5">
										<div class="wi-prose text-sm text-[var(--color-tron-text)] {step.images?.length ? 'lg:col-span-3' : 'lg:col-span-5'}">{@html step.instructionsHtml || ''}</div>
										{#if step.images?.length}
											<div class="grid grid-cols-2 gap-2 lg:col-span-2">
												{#each step.images as im, i (im._id)}
													<a href={im.url} target="_blank" rel="noopener" class="block overflow-hidden rounded border border-[var(--color-tron-border)] bg-black/30">
														<img src={im.url} alt={im.alt || im.caption || `Step ${step.stepNumber} photo ${i + 1}`} loading="lazy" class="h-32 w-full object-contain" />
													</a>
												{/each}
											</div>
										{/if}
									</div>
								{/if}
								{#if tools}
									<p class="mt-3 text-xs text-[var(--color-tron-text-secondary)]">Tools and supplies: {tools}</p>
								{/if}

								{#if parts.length}
									<div class="mt-3 flex flex-col gap-2">
										{#each parts as m (m._id)}
											{@const rec = scanFor.get(scanKey(step._id, m._id))}
											{@const stock = onHand(m)}
											{@const qty = Number(m.quantity) > 0 ? Number(m.quantity) : 1}
											{@const short = !rec && deducts(m) && stock != null && stock < qty}
											{@const note = [short ? 'Not enough on hand for this step.' : '', m.notes ?? ''].filter(Boolean).join(' ')}
											<div class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded border px-3 py-2.5 {rec ? 'border-green-500/30 bg-green-900/10' : 'border-[var(--color-tron-border)] bg-[var(--color-tron-bg)]'}">
												<div class="min-w-0 flex-[1_1_16rem]">
													<div class="font-semibold text-[var(--color-tron-text)]"><span class="font-mono text-[var(--color-tron-cyan)]">{m.partNumber ?? '—'}</span> · {m.name}</div>
													<div class="text-xs text-[var(--color-tron-text-secondary)]">
														Needs {qty} {m.unit || 'ea'} ·
														{#if !m.partDefinitionId}not linked to the inventory catalog{:else if m.deductFromInventory === false}not deducted from inventory{:else}{stock ?? 0} on hand{/if}
													</div>
													{#if note}<div class="text-xs font-medium text-amber-300">{note}</div>{/if}
												</div>
												{#if rec}
													{@const canUndo = rec.status === 'recorded' && data.canBuild && operator && (active.status !== 'cancelled' || rec.deducted)}
													<div class="flex flex-wrap items-center gap-3">
														<div class="text-sm font-semibold text-green-300">
															{#if rec.status === 'pending'}Recording…{:else if rec.status === 'undoing'}Undoing…{:else if rec.deducted}Scanned · {rec.lotLabel} · {rec.previousQuantity} → {rec.newQuantity} · {rec.operator?.name}{:else}{rec.lotLabel ? `Scanned · ${rec.lotLabel}` : 'Recorded'} · not deducted · {rec.operator?.name}{/if}
														</div>
														{#if canUndo && !isCorrecting('scan', rec._id)}
															<button type="button" onclick={() => startCorrection('scan', rec._id)} aria-label="Undo the scan of {m.partNumber ?? ''} {m.name}" class="min-h-11 rounded border border-[var(--color-tron-border)] px-3 text-sm text-[var(--color-tron-text-secondary)] hover:border-amber-500/60 hover:text-amber-300">Undo</button>
														{/if}
													</div>
													{#if canUndo && isCorrecting('scan', rec._id)}
														<form method="POST" action="?/undoScan" use:enhance={correctionEnhance} class="basis-full space-y-3 rounded border border-amber-500/40 bg-amber-900/10 px-4 py-3">
															{@render who()}
															<input type="hidden" name="buildId" value={active._id} />
															<input type="hidden" name="scanId" value={rec._id} />
															<p class="text-sm text-[var(--color-tron-text)]">
																Undo this scan of <span class="font-mono">{m.partNumber ?? m.name}</span>?
																{rec.deducted ? `${rec.quantity} ${rec.unit} goes back in stock.` : 'Nothing was deducted, so stock is unchanged.'}
																{#if active.status !== 'cancelled'}It has to be scanned again before step {step.stepNumber} is finished.{/if}
																{#if confirmed}{tabLabel(section)} will need confirming again.{/if}
																{#if active.status === 'completed'}SPU {active.buildNumber} goes back to in progress.{/if}
															</p>
															<div class="flex flex-wrap items-end gap-3">{@render reasonFields('scan')}</div>
															<div class="flex flex-wrap gap-2">
																<button type="submit" disabled={busy || !reasonOk} class="min-h-11 rounded bg-amber-400 px-4 font-semibold text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">Undo scan</button>
																{@render keepButton('Keep it')}
															</div>
														</form>
													{/if}
												{:else if isCurrent && !m.partDefinitionId}
													<form method="POST" action="?/recordPart" use:enhance={actionEnhance}>
														{@render who()}
														<input type="hidden" name="buildId" value={active._id} />
														<input type="hidden" name="sectionNumber" value={section.number} />
														<input type="hidden" name="stepId" value={step._id} />
														<input type="hidden" name="materialId" value={m._id} />
														<button type="submit" disabled={busy} aria-label="Record {m.partNumber ?? ''} {m.name} as used without a scan" class="min-h-11 rounded border border-[var(--color-tron-cyan)]/50 px-3.5 text-sm font-semibold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10 disabled:opacity-50">Record without scan</button>
													</form>
												{:else if isCurrent}
													<div class="text-xs text-[var(--color-tron-text-secondary)]">Scan its bag below</div>
												{/if}
											</div>
										{/each}
									</div>
								{/if}

								{#if isCurrent}
									<!-- the one place to scan right now: this step's part bags -->
									<form method="POST" action="?/scan" use:enhance={stepScanEnhance} class="mt-3 rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/5 px-4 py-3">
										{@render who()}
										<input type="hidden" name="buildId" value={active._id} />
										<input type="hidden" name="sectionNumber" value={section.number} />
										<div class="flex flex-wrap items-end gap-3">
											<div class="flex min-w-[16rem] flex-1 flex-col gap-1.5">
												<label for="stepscan" class="text-sm font-semibold text-[var(--color-tron-text)]">Scan the barcode on each part's bag for step {step.stepNumber}</label>
												<input
													id="stepscan"
													name="code"
													type="text"
													autocomplete="off"
													placeholder="{left} part{left === 1 ? '' : 's'} left in this step"
													bind:value={stepScan}
													bind:this={stepInput}
													class="min-h-12 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-4 font-mono text-lg text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
												/>
											</div>
											<!-- Never disabled: a disabled submit button also blocks Enter in the field, which drops scans. -->
											<button type="submit" class="min-h-12 rounded bg-[var(--color-tron-cyan)] px-5 font-semibold text-black hover:opacity-90">{busy ? 'Recording…' : 'Enter'}</button>
										</div>
										{#if msg}
											<p role="status" class="mt-3 rounded border px-4 py-2.5 text-sm font-medium {msgClass(msg)}">{msg.text}</p>
										{/if}
									</form>
								{/if}
							</article>
						{/each}

						<!-- one confirmation for the whole section, after its last step -->
						{#if section.steps.length}
							<section bind:this={confirmPanel} class="rounded-lg border px-5 py-4 {confirmed ? 'border-green-500/40 bg-green-900/10' : 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]'}">
								{#if confirmed}
									<div class="flex flex-wrap items-center justify-between gap-3">
										<p class="font-semibold text-green-300">{tabLabel(section)} confirmed complete{sectionRec ? ` by ${sectionRec.operator?.name} · ${fmt(sectionRec.completedAt)}` : ''}.</p>
										{#if canCorrect && !isCorrecting('section', section._id)}
											<button type="button" onclick={() => startCorrection('section', section._id)} class="min-h-11 rounded border border-[var(--color-tron-border)] px-3 text-sm text-[var(--color-tron-text-secondary)] hover:border-amber-500/60 hover:text-amber-300">Reopen {tabLabel(section)}</button>
										{/if}
									</div>
									{#if canCorrect && isCorrecting('section', section._id)}
										<form method="POST" action="?/reopenSection" use:enhance={correctionEnhance} class="mt-3 space-y-3 rounded border border-amber-500/40 bg-amber-900/10 px-4 py-3">
											{@render who()}
											<input type="hidden" name="buildId" value={active._id} />
											<input type="hidden" name="sectionNumber" value={section.number} />
											<p class="text-sm text-[var(--color-tron-text)]">
												Reopen {tabLabel(section)} on SPU {active.buildNumber}? Its scanned parts stay; it just needs confirming again.
												{#if active.status === 'completed'}SPU {active.buildNumber} goes back to in progress.{/if}
											</p>
											<div class="flex flex-wrap items-end gap-3">{@render reasonFields('section')}</div>
											<div class="flex flex-wrap gap-2">
												<button type="submit" disabled={busy || !reasonOk} class="min-h-11 rounded bg-amber-400 px-4 font-semibold text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">Reopen {tabLabel(section)}</button>
												{@render keepButton('Keep it confirmed')}
											</div>
										</form>
									{/if}
								{:else if canAct}
									<form method="POST" action="?/completeSection" use:enhance={sectionEnhance} class="flex flex-wrap items-center justify-between gap-3">
										{@render who()}
										<input type="hidden" name="buildId" value={active._id} />
										<input type="hidden" name="sectionNumber" value={section.number} />
										<p class="text-sm text-[var(--color-tron-text)]">
											{#if current}
												Scan every part above to finish {tabLabel(section)}: {sectionPartsLeft} left, starting with step {current.stepNumber}.
											{:else}
												{partsProgress([section], active).total ? `Every part for ${tabLabel(section)} is scanned. ` : ''}Confirm {tabLabel(section)} once every step above is done.
											{/if}
										</p>
										<button type="submit" disabled={busy || Boolean(current)} class="min-h-12 rounded bg-green-500 px-5 font-semibold text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">Confirm {tabLabel(section)} complete</button>
									</form>
									{#if msg && !current}
										<p role="status" class="mt-3 rounded border px-4 py-2.5 text-sm font-medium {msgClass(msg)}">{msg.text}</p>
									{/if}
								{:else}
									<p class="text-sm text-[var(--color-tron-text-secondary)]">{tabLabel(section)} is not confirmed.</p>
								{/if}
							</section>
						{/if}
					</div>

					<!-- deductions -->
					<aside class="min-w-0 flex-[1_1_20rem] rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-5 py-4">
						<h3 class="text-lg font-semibold text-[var(--color-tron-text)]">Inventory deductions</h3>
						<p class="mt-1 mb-3 text-xs text-[var(--color-tron-text-secondary)]">Every scan, across all buckets, newest first.</p>
						{#if !deductions.length}
							<p class="text-sm text-[var(--color-tron-text-secondary)]">No parts scanned yet.</p>
						{/if}
						<div class="flex flex-col gap-2.5">
							{#each deductions as t (t._id)}
								<div class="border-t border-[var(--color-tron-border)] pt-2.5 text-sm">
									<div class="font-semibold text-[var(--color-tron-text)]">
										<span class="font-mono text-[var(--color-tron-cyan)]">{t.partNumber ?? '—'}</span> ·
										{#if t.status === 'undone'}
											{#if t.deducted}<span class="text-green-300">+{t.quantity} {t.unit} returned</span> ({t.returnedQuantity != null ? `${t.returnedQuantity - t.quantity} → ${t.returnedQuantity}` : 'undone'}){:else}<span class="text-[var(--color-tron-text-secondary)]">undone</span>{/if}
										{:else if t.deducted}<span class="text-red-300">−{t.quantity} {t.unit}</span> ({t.previousQuantity} → {t.newQuantity}){:else}<span class="text-[var(--color-tron-text-secondary)]">not deducted</span>{/if}
									</div>
									<div class="text-xs text-[var(--color-tron-text)]">{t.name}{t.lotLabel ? ` · ${t.lotLabel}` : ''}</div>
									<div class="text-xs text-[var(--color-tron-text-secondary)]">SPU {t.build.buildNumber} · {bucketLabel(t.build)} · {sectionName(t.sectionNumber)} step {t.stepNumber}</div>
									{#if t.status === 'undone'}
										<div class="text-xs text-amber-300">Undone by {t.undoneBy?.name} · {fmt(t.undoneAt)} · {t.undoReason}</div>
										<div class="text-xs text-[var(--color-tron-text-secondary)]">Scanned by {t.operator?.name} · {fmt(t.scannedAt)}</div>
									{:else}
										<div class="text-xs text-[var(--color-tron-text-secondary)]">{t.operator?.name} · {fmt(t.scannedAt)}</div>
									{/if}
								</div>
							{/each}
						</div>
					</aside>
				</div>
			</section>
		{/if}
	{/if}
</div>

<style>
	.wi-prose :global(p) { margin: 0 0 0.5rem; }
	.wi-prose :global(p:last-child) { margin-bottom: 0; }
	.wi-prose :global(ul), .wi-prose :global(ol) { margin: 0.25rem 0 0.5rem 1.25rem; }
	.wi-prose :global(ul) { list-style: disc; }
	.wi-prose :global(ol) { list-style: decimal; }
	.wi-prose :global(strong) { color: var(--color-tron-text); font-weight: 600; }
	.wi-prose :global(table) { border-collapse: collapse; width: 100%; font-size: 0.8rem; }
	.wi-prose :global(td), .wi-prose :global(th) { border: 1px solid var(--color-tron-border); padding: 0.25rem 0.5rem; text-align: left; vertical-align: top; }
	.wi-prose :global(img) { max-width: 100%; height: auto; }
</style>
