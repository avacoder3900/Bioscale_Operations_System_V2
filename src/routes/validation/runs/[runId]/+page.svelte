<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import ThermoFileUpload from '$lib/components/validation/thermocouple/ThermoFileUpload.svelte';

	type Channel = 'A' | 'B' | 'C';
	type RatioByChannel = Record<Channel, number | null>;

	interface OpticalCartridge {
		barcode: string;
		serialNumber: string | null;
		status: string;
		assignedAt: string | null;
		ranAt: string | null;
		readingCount: number;
		ratioByChannel: RatioByChannel;
		crossWellCv: number | null;
		rogueChannel: Channel | null;
		warning: boolean;
		reasons: string[];
	}

	interface OpticalSummary {
		cartridges: OpticalCartridge[];
		meanByChannel: RatioByChannel;
		warningCount: number;
		latestRanAt: string | null;
	}

	interface StepCell {
		status: string;
		sessionId?: string;
		result?: {
			min?: number; max?: number; mode?: number; average?: number;
			readingCount?: number; fileName?: string | null;
			// optical_confirmation verdict snapshot
			meanByChannel?: RatioByChannel;
			cartridgeCount?: number;
			warningCount?: number;
			judgedAt?: string | null;
		};
		evaluation?: { criteria: { minTemp: number; maxTemp: number }; passed: boolean; failureReasons: string[] } | null;
		completedAt?: string | null;
		completedBy?: { username?: string } | null;
		notes?: string | null;
		previous?: StepCell[];
	}

	interface Member {
		spuId: string;
		udi: string;
		addedAt?: string;
		removedAt?: string | null;
		steps?: Record<string, StepCell>;
	}

	interface Props {
		data: {
			run: {
				_id: string;
				runNumber: string;
				name?: string | null;
				status: string;
				steps: string[];
				spus: Member[];
				startedAt?: string;
				completedAt?: string | null;
				abortReason?: string | null;
				createdBy?: { username?: string } | null;
			};
			sessionById: Record<string, { id: string; type: string; status: string; barcode: string | null }>;
			spuById: Record<string, {
				udi: string;
				status: string;
				finalized: boolean;
				prior: Record<string, { status: string; sessionId: string | null; completedAt: string | null; failureReasons: string[] } | null>;
			}>;
			opticalByUdi: Record<string, OpticalSummary>;
			thermoCriteria: { minTemp: number; maxTemp: number } | null;
			otherActiveRuns: { id: string; runNumber: string; name: string | null }[];
		};
		form: {
			error?: string;
			spuId?: string;
			success?: boolean;
			uploaded?: boolean;
			evaluated?: boolean;
			passed?: boolean | null;
		} | null;
	}

	let { data, form }: Props = $props();

	const STEP_LABELS: Record<string, string> = {
		magnetometer: 'Magnetometer',
		thermocouple: 'Thermocouple',
		optical_confirmation: 'Optical Confirmation'
	};

	let run = $derived(data.run);
	let members = $derived((run.spus ?? []).filter(m => !m.removedAt));
	let inProgress = $derived(run.status === 'in_progress');

	// Which step tab is open on each SPU card, keyed by spuId. Unset means
	// "first step still needing attention" — see tabFor().
	let activeTab = $state<Record<string, string>>({});
	// One expandable sub-form at a time, keyed `${spuId}:${step}:${mode}`
	let openPanel = $state<string | null>(null);
	let showAbort = $state(false);
	let editingName = $state(false);

	// Per-SPU parsed thermo file (readings JSON + name) for the upload forms
	let thermoParsed = $state<Record<string, { readingsJson: string; fileName: string; count: number }>>({});

	// Live refresh: re-fetch run data every 10s (when the tab is visible) so
	// validations completed elsewhere — another tab, another operator, the
	// instrument pages, a finished optical cartridge — appear without a manual
	// reload. Local UI state (open tab, panels, parsed files) survives it.
	let lastRefreshed = $state<Date | null>(null);
	onMount(() => {
		const id = setInterval(async () => {
			if (document.hidden) return;
			await invalidateAll();
			lastRefreshed = new Date();
		}, 10000);
		return () => clearInterval(id);
	});

	function cellFor(m: Member, step: string): StepCell {
		return m.steps?.[step] ?? { status: 'not_started' };
	}

	// Prior validation result stored on the SPU itself (spu.validation.*) —
	// e.g. a magnetometer pass recorded before this run existed.
	function priorFor(m: Member, step: string) {
		return data.spuById[m.spuId]?.prior?.[step] ?? null;
	}

	function opticalFor(m: Member): OpticalSummary | null {
		return data.opticalByUdi?.[m.udi] ?? null;
	}

	function sessionHref(sessionId: string): string {
		const s = data.sessionById[sessionId];
		if (s?.type === 'mag') return `/validation/magnetometer/${sessionId}`;
		if (s?.type === 'spec') return `/validation/spectrophotometer/${sessionId}`;
		return `/validation/thermocouple/${sessionId}`;
	}

	function fmtShortDate(d: string | null | undefined): string {
		return d ? new Date(d).toLocaleDateString() : '';
	}

	function fmtDate(d: string | null | undefined): string {
		return d ? new Date(d).toLocaleString() : '—';
	}

	function fmtDateTimeShort(d: string | null | undefined): string {
		if (!d) return '—';
		const date = new Date(d);
		return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
	}

	// analyzeCartridge always reports the three wells, so the columns are fixed.
	const CHANNELS: Channel[] = ['A', 'B', 'C'];

	function fmtRatio(v: number | null | undefined): string {
		return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(3) : '—';
	}

	function fmtPct(v: number | null | undefined): string {
		return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)}%` : '—';
	}

	// Effective status: the run cell if it has state, else the SPU's prior
	// device-record result — a prior mag pass counts toward Overall.
	function effectiveStatus(m: Member, step: string): string {
		const cell = cellFor(m, step);
		if (cell.status !== 'not_started') return cell.status;
		return priorFor(m, step)?.status ?? 'not_started';
	}

	function passedCount(m: Member): number {
		return (run.steps ?? []).filter(s => effectiveStatus(m, s) === 'passed').length;
	}

	function allPassed(m: Member): boolean {
		return (run.steps ?? []).every(s => effectiveStatus(m, s) === 'passed');
	}

	// A step is "waiting on a person" when the data is in but no verdict is:
	// an uploaded thermo file, or optical cartridges that have already run.
	function awaitingVerdict(m: Member, step: string): boolean {
		if (effectiveStatus(m, step) === 'uploaded') return true;
		if (step === 'optical_confirmation') {
			return cellFor(m, step).status === 'not_started' && (opticalFor(m)?.cartridges.length ?? 0) > 0;
		}
		return false;
	}

	function tabFor(m: Member): string {
		const steps = run.steps ?? [];
		const explicit = activeTab[m.spuId];
		if (explicit && steps.includes(explicit)) return explicit;
		// Default to the first step that still needs someone: a pending verdict
		// first, then anything not yet decided.
		return steps.find(s => awaitingVerdict(m, s))
			?? steps.find(s => !['passed', 'skipped'].includes(effectiveStatus(m, s)))
			?? steps[0]
			?? '';
	}

	function selectTab(m: Member, step: string) {
		activeTab[m.spuId] = step;
		openPanel = null;
	}

	// Whole-run rollup for the header summary and the complete-run warning
	let stepTotals = $derived.by(() => {
		const t = { passed: 0, failed: 0, uploaded: 0, remaining: 0, cells: 0 };
		for (const m of members) {
			for (const s of run.steps ?? []) {
				t.cells++;
				const st = effectiveStatus(m, s);
				if (st === 'passed') t.passed++;
				else if (st === 'failed') t.failed++;
				else if (st === 'uploaded') t.uploaded++;
				else if (st !== 'skipped') t.remaining++;
			}
		}
		return t;
	});

	function chip(status: string): string {
		if (status === 'passed') return 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]';
		if (status === 'failed') return 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]';
		if (status === 'uploaded') return 'bg-[var(--color-tron-orange)]/20 text-[var(--color-tron-orange)]';
		if (status === 'skipped') return 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)]';
		return 'bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-text-secondary)]';
	}

	function chipLabel(status: string): string {
		if (status === 'not_started') return 'Not started';
		if (status === 'in_progress') return 'In progress';
		return status.charAt(0).toUpperCase() + status.slice(1);
	}

	function stepMark(status: string): string {
		if (status === 'passed') return '✓';
		if (status === 'failed') return '✗';
		if (status === 'uploaded') return '↑';
		if (status === 'skipped') return '–';
		return '·';
	}

	function markClass(status: string): string {
		if (status === 'passed') return 'text-[var(--color-tron-green)]';
		if (status === 'failed') return 'text-[var(--color-tron-red)]';
		if (status === 'uploaded') return 'text-[var(--color-tron-orange)]';
		return 'tron-text-muted';
	}

	function togglePanel(key: string) {
		openPanel = openPanel === key ? null : key;
	}

	const submitAndClose = () => {
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			openPanel = null;
		};
	};
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-start justify-between gap-4">
		<div>
			<a href="/validation/runs" class="tron-text-muted text-sm transition-colors hover:text-[var(--color-tron-cyan)]">← All runs</a>
			<div class="mt-1 flex items-center gap-3">
				<h1 class="tron-heading text-2xl font-bold">{run.runNumber}</h1>
				<span class="rounded-full px-3 py-1 text-xs font-medium
					{run.status === 'in_progress'
						? 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]'
						: run.status === 'completed'
							? 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]'
							: 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]'}">
					{run.status === 'in_progress' ? 'In Progress' : run.status === 'completed' ? 'Completed' : 'Aborted'}
				</span>
			</div>
			{#if editingName && inProgress}
				<form method="POST" action="?/updateName" use:enhance={submitAndClose} class="mt-2 flex items-center gap-2">
					<input type="text" name="name" value={run.name ?? ''} placeholder="Run name" class="tron-input rounded-lg px-3 py-1.5 text-sm" />
					<button type="submit" class="rounded-lg bg-[var(--color-tron-cyan)] px-3 py-1.5 text-xs font-semibold text-[var(--color-tron-bg-primary)]">Save</button>
					<button type="button" onclick={() => editingName = false} class="tron-text-muted text-xs hover:text-[var(--color-tron-red)]">Cancel</button>
				</form>
			{:else}
				<p class="tron-text-muted mt-1">
					{run.name ?? 'Unnamed run'}
					{#if inProgress}
						<button type="button" onclick={() => editingName = true} class="ml-2 text-xs text-[var(--color-tron-cyan)] hover:underline">edit</button>
					{/if}
				</p>
			{/if}
			<p class="tron-text-muted mt-1 text-sm">
				Started {fmtDate(run.startedAt)}{#if run.createdBy?.username}&nbsp;by {run.createdBy.username}{/if}
				{#if run.completedAt}&nbsp;· ended {fmtDate(run.completedAt)}{/if}
				<span class="ml-2 inline-flex items-center gap-1 text-xs">
					<span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-tron-green)]"></span>
					live{#if lastRefreshed}&nbsp;· updated {lastRefreshed.toLocaleTimeString()}{/if}
				</span>
			</p>
			<!-- At-a-glance rollup so the state of the whole run is readable
			     without opening every card -->
			<p class="mt-1 text-sm">
				<span class="font-medium text-[var(--color-tron-green)]">{stepTotals.passed}/{stepTotals.cells} passed</span>
				{#if stepTotals.failed > 0}
					<span class="tron-text-muted">·</span> <span class="text-[var(--color-tron-red)]">{stepTotals.failed} failed</span>
				{/if}
				{#if stepTotals.uploaded > 0}
					<span class="tron-text-muted">·</span> <span class="text-[var(--color-tron-orange)]">{stepTotals.uploaded} awaiting verdict</span>
				{/if}
				{#if stepTotals.remaining > 0}
					<span class="tron-text-muted">· {stepTotals.remaining} not started</span>
				{/if}
			</p>
			{#if run.abortReason}
				<p class="mt-1 text-sm text-[var(--color-tron-red)]">Aborted: {run.abortReason}</p>
			{/if}
		</div>

		<div class="flex items-center gap-2">
			{#if data.otherActiveRuns.length > 0}
				<select
					class="tron-input rounded-lg px-3 py-2 text-sm"
					onchange={(e) => { const id = e.currentTarget.value; if (id) goto(`/validation/runs/${id}`); }}
				>
					<option value="" selected>Switch run…</option>
					{#each data.otherActiveRuns as other (other.id)}
						<option value={other.id}>{other.runNumber}{other.name ? ` — ${other.name}` : ''}</option>
					{/each}
				</select>
			{/if}
			{#if inProgress}
				<form
					method="POST"
					action="?/completeRun"
					use:enhance={({ cancel }) => {
						const open = stepTotals.cells - stepTotals.passed;
						if (open > 0 && !confirm(`${open} of ${stepTotals.cells} steps have not passed yet. Complete this run anyway?`)) {
							cancel();
						}
					}}
				>
					<button type="submit" class="rounded-lg bg-[var(--color-tron-green)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-green)]/90">
						Complete Run
					</button>
				</form>
				<button type="button" onclick={() => showAbort = !showAbort} class="rounded-lg border border-[var(--color-tron-red)]/50 px-4 py-2 text-sm font-semibold text-[var(--color-tron-red)] transition-all hover:bg-[var(--color-tron-red)]/10">
					Abort…
				</button>
			{/if}
		</div>
	</div>

	{#if showAbort && inProgress}
		<form method="POST" action="?/abortRun" use:enhance class="tron-card flex items-center gap-3 p-4">
			<input type="text" name="reason" required placeholder="Reason for aborting this run" class="tron-input flex-1 rounded-lg px-3 py-2 text-sm" />
			<button type="submit" class="rounded-lg bg-[var(--color-tron-red)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg-primary)]">Abort Run</button>
		</form>
	{/if}

	{#if form?.error}
		<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-[var(--color-tron-red)]">
			{form.error}
		</div>
	{/if}

	<!-- One card per SPU. Steps are tabs inside the card, so a step gets the
	     full width for its data instead of a cramped table cell. -->
	<div class="space-y-4">
		{#each members as member (member.spuId)}
			{@const step = tabFor(member)}
			{@const cell = cellFor(member, step)}
			{@const prior = cell.status === 'not_started' ? priorFor(member, step) : null}
			{@const panelKey = `${member.spuId}:${step}`}
			{@const optical = opticalFor(member)}
			<div class="tron-card overflow-hidden">
				<!-- Card header: identity + overall verdict for this SPU -->
				<div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-tron-border)] p-4">
					<div class="flex items-baseline gap-3">
						<a href="/spu/{member.spuId}" class="tron-heading text-lg font-semibold hover:text-[var(--color-tron-cyan)] hover:underline">{member.udi}</a>
						{#if data.spuById[member.spuId]?.finalized}
							<span class="tron-text-muted text-xs">finalized</span>
						{/if}
						<span class="tron-text-muted text-sm">{passedCount(member)}/{run.steps.length} passed</span>
					</div>
					<div class="flex items-center gap-3">
						{#if allPassed(member) && data.spuById[member.spuId]?.status === 'validating'}
							<form method="POST" action="?/markValidated" use:enhance>
								<input type="hidden" name="spuId" value={member.spuId} />
								<button type="submit" class="rounded-lg bg-[var(--color-tron-green)] px-3 py-1.5 text-xs font-semibold text-[var(--color-tron-bg-primary)] hover:bg-[var(--color-tron-green)]/90">
									Mark validated
								</button>
							</form>
						{:else if data.spuById[member.spuId]?.status === 'validated'}
							<span class="text-xs text-[var(--color-tron-green)]">validated ✓</span>
						{/if}
						{#if inProgress}
							<form method="POST" action="?/removeSpu" use:enhance>
								<input type="hidden" name="spuId" value={member.spuId} />
								<button type="submit" class="tron-text-muted text-xs hover:text-[var(--color-tron-red)]" title="Remove from run">
									Remove
								</button>
							</form>
						{/if}
					</div>
				</div>

				<!-- Step tabs -->
				<div role="tablist" aria-label="Validation steps for {member.udi}" class="flex flex-wrap gap-1 border-b border-[var(--color-tron-border)] px-4 pt-3">
					{#each run.steps as s (s)}
						{@const st = effectiveStatus(member, s)}
						<button
							type="button"
							role="tab"
							aria-selected={s === step}
							onclick={() => selectTab(member, s)}
							class="flex items-center gap-2 rounded-t-lg border-b-2 px-4 py-2 text-sm font-medium transition-colors
								{s === step
									? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
									: 'border-transparent text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]'}"
						>
							<span class={markClass(st)}>{stepMark(st)}</span>
							{STEP_LABELS[s] ?? s}
							{#if awaitingVerdict(member, s)}
								<span class="rounded-full bg-[var(--color-tron-orange)]/20 px-2 py-0.5 text-[10px] font-semibold text-[var(--color-tron-orange)]">
									needs verdict
								</span>
							{/if}
						</button>
					{/each}
				</div>

				<!-- Active step panel -->
				<div class="space-y-4 p-4">
					<div class="flex flex-wrap items-center gap-3">
						<span class="rounded-full px-3 py-1 text-xs font-medium {chip(prior ? prior.status : cell.status)}">
							{chipLabel(prior ? prior.status : cell.status)}{prior ? ' · prior' : ''}
						</span>
						{#if cell.completedAt && !prior}
							<span class="tron-text-muted text-xs">
								{fmtDate(cell.completedAt)}{#if cell.completedBy?.username}&nbsp;· {cell.completedBy.username}{/if}
							</span>
						{/if}
						{#if cell.sessionId && data.sessionById[cell.sessionId]}
							<a href={sessionHref(cell.sessionId)} class="text-xs text-[var(--color-tron-cyan)] hover:underline">
								{data.sessionById[cell.sessionId].barcode ?? 'session'} →
							</a>
						{/if}
					</div>

					{#if prior}
						<!-- Carried over from the SPU's DHR (spu.validation.*) -->
						<div class="rounded-lg border border-[var(--color-tron-border)] p-3">
							<p class="tron-text-muted text-xs">
								Recorded on the device record{#if prior.completedAt}&nbsp;· {fmtShortDate(prior.completedAt)}{/if}
							</p>
							{#if prior.status === 'failed' && prior.failureReasons?.length}
								<p class="mt-1 text-xs text-[var(--color-tron-red)]">{prior.failureReasons.join('; ')}</p>
							{/if}
							<div class="mt-2 flex items-center gap-3">
								{#if prior.sessionId && data.sessionById[prior.sessionId]}
									<a href={sessionHref(prior.sessionId)} class="text-xs text-[var(--color-tron-cyan)] hover:underline">
										{data.sessionById[prior.sessionId].barcode ?? 'session'} →
									</a>
								{/if}
								{#if inProgress}
									<form method="POST" action="?/recordStepResult" use:enhance>
										<input type="hidden" name="spuId" value={member.spuId} />
										<input type="hidden" name="step" value={step} />
										<input type="hidden" name="outcome" value={prior.status} />
										<input type="hidden" name="sessionId" value={prior.sessionId ?? ''} />
										<input type="hidden" name="notes" value="Carried over from prior validation" />
										<button type="submit" class="rounded-lg border border-[var(--color-tron-cyan)]/50 px-3 py-1.5 text-xs font-semibold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10">
											Use this result
										</button>
									</form>
								{/if}
							</div>
						</div>
					{/if}

					{#if step === 'thermocouple'}
						{#if !data.thermoCriteria}
							<p class="rounded-lg border border-[var(--color-tron-orange)]/30 bg-[var(--color-tron-orange)]/10 p-3 text-xs text-[var(--color-tron-orange)]">
								No standard acceptance range is configured — uploads park at <span class="font-semibold">uploaded</span> and are judged by review below.
							</p>
						{:else}
							<p class="tron-text-muted text-xs">
								Acceptance range: {data.thermoCriteria.minTemp}°C – {data.thermoCriteria.maxTemp}°C
							</p>
						{/if}

						{#if cell.result && (cell.result.min != null || cell.result.mode != null)}
							<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
								{#each [['Min', cell.result.min], ['Max', cell.result.max], ['Mode', cell.result.mode], ['Average', cell.result.average]] as [label, value] (label)}
									<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-3">
										<div class="tron-text-muted text-xs">{label}</div>
										<div class="tron-heading text-lg font-semibold">
											{typeof value === 'number' ? `${value.toFixed(1)}°C` : '—'}
										</div>
									</div>
								{/each}
							</div>
							<p class="tron-text-muted text-xs">
								{cell.result.readingCount ?? 0} readings{#if cell.result.fileName}&nbsp;· {cell.result.fileName}{/if}
							</p>
						{/if}

						{#if cell.evaluation}
							<p class="tron-text-muted text-xs">
								Evaluated vs {cell.evaluation.criteria.minTemp}–{cell.evaluation.criteria.maxTemp}°C
							</p>
						{/if}
						{#if cell.status === 'failed' && cell.evaluation?.failureReasons?.length}
							<p class="text-xs text-[var(--color-tron-red)]">{cell.evaluation.failureReasons.join('; ')}</p>
						{/if}

						{#if cell.status === 'uploaded' && inProgress}
							<!-- Verdict on the displayed values (manual until the
							     larger-dataset acceptance range is defined) -->
							<div class="flex flex-wrap gap-2">
								<form method="POST" action="?/recordStepResult" use:enhance>
									<input type="hidden" name="spuId" value={member.spuId} />
									<input type="hidden" name="step" value={step} />
									<input type="hidden" name="outcome" value="passed" />
									<input type="hidden" name="notes" value="Approved on mode/min/max review" />
									<button type="submit" class="rounded-lg bg-[var(--color-tron-green)] px-4 py-2 text-xs font-semibold text-[var(--color-tron-bg-primary)] hover:bg-[var(--color-tron-green)]/90">
										Approve
									</button>
								</form>
								<form method="POST" action="?/recordStepResult" use:enhance>
									<input type="hidden" name="spuId" value={member.spuId} />
									<input type="hidden" name="step" value={step} />
									<input type="hidden" name="outcome" value="failed" />
									<input type="hidden" name="notes" value="Rejected on mode/min/max review" />
									<button type="submit" class="rounded-lg border border-[var(--color-tron-red)]/50 px-4 py-2 text-xs font-semibold text-[var(--color-tron-red)] hover:bg-[var(--color-tron-red)]/10">
										Reject
									</button>
								</form>
								{#if data.thermoCriteria}
									<form method="POST" action="?/evaluateThermo" use:enhance>
										<input type="hidden" name="spuId" value={member.spuId} />
										<button type="submit" class="rounded-lg border border-[var(--color-tron-cyan)]/50 px-4 py-2 text-xs font-semibold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10">
											Evaluate against range
										</button>
									</form>
								{/if}
							</div>
						{/if}

					{:else if step === 'optical_confirmation'}
						<!-- Ratios are pulled live from the optical cartridges this SPU
						     ran since joining the run — no upload, no manual entry. -->
						{#if !optical || optical.cartridges.length === 0}
							<p class="tron-text-muted rounded-lg border border-dashed border-[var(--color-tron-border)] p-4 text-sm">
								No optical cartridge has finished on {member.udi} since this run started
								({fmtShortDate(member.addedAt ?? run.startedAt)}). Results appear here automatically
								once a cartridge completes.
							</p>
						{:else}
							{#if optical.warningCount > 0}
								<p class="rounded-lg border border-[var(--color-tron-orange)]/30 bg-[var(--color-tron-orange)]/10 p-3 text-xs text-[var(--color-tron-orange)]">
									{optical.warningCount} of {optical.cartridges.length} cartridge(s) flagged by the analysis — read the reasons below before ruling.
								</p>
							{/if}
							<div class="overflow-x-auto rounded-lg border border-[var(--color-tron-border)]">
								<table class="w-full text-sm">
									<thead>
										<tr class="border-b border-[var(--color-tron-border)] text-left">
											<th class="tron-text-muted p-3 font-medium">Cartridge</th>
											<th class="tron-text-muted p-3 font-medium">Ran</th>
											{#each CHANNELS as ch (ch)}
												<th class="tron-text-muted p-3 text-right font-medium">Ch {ch} (F7/F3)</th>
											{/each}
											<th class="tron-text-muted p-3 text-right font-medium">Cross-well CV</th>
											<th class="tron-text-muted p-3 font-medium">Flag</th>
										</tr>
									</thead>
									<tbody class="divide-y divide-[var(--color-tron-border)]">
										{#each optical.cartridges as cart (cart.barcode)}
											<tr class={cart.warning ? 'bg-[var(--color-tron-orange)]/5' : ''}>
												<td class="p-3">
													<a href="/validation/optical-confirmation/{cart.barcode}" class="font-mono text-xs text-[var(--color-tron-cyan)] hover:underline" title={cart.barcode}>
														{cart.barcode.slice(0, 8)}…
													</a>
													{#if cart.serialNumber}
														<span class="tron-text-muted ml-2 text-xs">{cart.serialNumber}</span>
													{/if}
												</td>
												<td class="tron-text-muted p-3 text-xs">{fmtDateTimeShort(cart.ranAt)}</td>
												{#each CHANNELS as ch (ch)}
													<td class="p-3 text-right font-mono {cart.rogueChannel === ch ? 'text-[var(--color-tron-orange)]' : 'tron-heading'}">
														{fmtRatio(cart.ratioByChannel[ch])}
													</td>
												{/each}
												<td class="tron-text-muted p-3 text-right font-mono text-xs">{fmtPct(cart.crossWellCv)}</td>
												<td class="p-3 text-xs">
													{#if cart.warning}
														<span class="text-[var(--color-tron-orange)]">flagged</span>
													{:else}
														<span class="text-[var(--color-tron-green)]">clean</span>
													{/if}
												</td>
											</tr>
										{/each}
										{#if optical.cartridges.length > 1}
											<tr class="bg-[var(--color-tron-bg-tertiary)]">
												<td class="tron-text-muted p-3 text-xs font-semibold" colspan="2">
													Mean of {optical.cartridges.length} cartridges
												</td>
												{#each CHANNELS as ch (ch)}
													<td class="tron-heading p-3 text-right font-mono font-semibold">{fmtRatio(optical.meanByChannel[ch])}</td>
												{/each}
												<td colspan="2"></td>
											</tr>
										{/if}
									</tbody>
								</table>
							</div>
							{#if optical.warningCount > 0}
								<ul class="space-y-1 text-xs text-[var(--color-tron-orange)]">
									{#each optical.cartridges.filter((c) => c.warning) as cart (cart.barcode)}
										<li><span class="font-mono">{cart.barcode.slice(0, 8)}…</span> — {cart.reasons.join('; ')}</li>
									{/each}
								</ul>
							{/if}
							<p class="tron-text-muted text-xs">
								F7/F3 per well over the analysis endpoint window, from the shared optical
								analysis engine — the same numbers the cartridge page shows.
							</p>

							{#if cell.result?.meanByChannel && cell.status !== 'not_started'}
								<!-- What the recorded verdict was actually judged on -->
								<p class="tron-text-muted text-xs">
									Verdict recorded on {cell.result.cartridgeCount ?? 0} cartridge(s){#if cell.result.warningCount}, {cell.result.warningCount} flagged{/if}:
									{#each CHANNELS as ch (ch)}
										<span class="ml-2">Ch {ch} {fmtRatio(cell.result.meanByChannel[ch])}</span>
									{/each}
								</p>
							{/if}

							{#if inProgress}
								<form method="POST" action="?/recordOpticalVerdict" use:enhance class="flex flex-wrap items-center gap-2 border-t border-[var(--color-tron-border)] pt-4">
									<input type="hidden" name="spuId" value={member.spuId} />
									<input type="text" name="notes" placeholder="Notes (optional)" class="tron-input min-w-48 flex-1 rounded-lg px-3 py-2 text-xs" />
									<button type="submit" name="outcome" value="passed" class="rounded-lg bg-[var(--color-tron-green)] px-4 py-2 text-xs font-semibold text-[var(--color-tron-bg-primary)] hover:bg-[var(--color-tron-green)]/90">
										{cell.status === 'not_started' ? 'Pass device' : 'Change to pass'}
									</button>
									<button type="submit" name="outcome" value="failed" class="rounded-lg border border-[var(--color-tron-red)]/50 px-4 py-2 text-xs font-semibold text-[var(--color-tron-red)] hover:bg-[var(--color-tron-red)]/10">
										{cell.status === 'not_started' ? 'Fail device' : 'Change to fail'}
									</button>
								</form>
							{/if}
						{/if}
					{/if}

					{#if cell.notes}
						<p class="tron-text-muted text-xs italic">{cell.notes}</p>
					{/if}

					{#if cell.previous?.length}
						<p class="tron-text-muted text-xs">
							Earlier attempts:
							{#each cell.previous as prev, pi (pi)}
								{#if prev.sessionId && data.sessionById[prev.sessionId]}
									<a href={sessionHref(prev.sessionId)} class="ml-1 hover:underline {prev.status === 'failed' ? 'text-[var(--color-tron-red)]' : prev.status === 'passed' ? 'text-[var(--color-tron-green)]' : ''}">
										{prev.status === 'failed' ? '✗' : prev.status === 'passed' ? '✓' : '•'} {data.sessionById[prev.sessionId].barcode ?? prev.status}
									</a>
								{:else}
									<span class="ml-1 {prev.status === 'failed' ? 'text-[var(--color-tron-red)]' : prev.status === 'passed' ? 'text-[var(--color-tron-green)]' : ''}">
										{prev.status === 'failed' ? '✗ failed' : prev.status === 'passed' ? '✓ passed' : prev.status}
									</span>
								{/if}
							{/each}
						</p>
					{/if}

					{#if inProgress}
						<div class="flex flex-wrap items-center gap-4 border-t border-[var(--color-tron-border)] pt-3">
							{#if step === 'thermocouple'}
								<button type="button" onclick={() => togglePanel(`${panelKey}:upload`)} class="text-xs text-[var(--color-tron-orange)] hover:underline">
									{cell.status === 'not_started' ? 'Upload data' : cell.status === 'uploaded' ? 'Re-upload' : 'Run again'}
								</button>
							{:else if step === 'magnetometer'}
								<a href="/validation/magnetometer?udi={encodeURIComponent(member.udi)}&runId={run._id}" class="text-xs text-[var(--color-tron-orange)] hover:underline">
									{cell.status === 'not_started' || cell.status === 'in_progress' ? 'Run test →' : 'Run again →'}
								</a>
							{:else if step === 'optical_confirmation'}
								<a href="/validation/optical-confirmation?udi={encodeURIComponent(member.udi)}&runId={run._id}" class="text-xs text-[var(--color-tron-orange)] hover:underline">
									Assign cartridges →
								</a>
							{/if}
							<button type="button" onclick={() => togglePanel(`${panelKey}:record`)} class="tron-text-muted text-xs hover:text-[var(--color-tron-cyan)]">
								Record result manually
							</button>
						</div>
					{/if}

					<!-- Thermo upload panel -->
					{#if openPanel === `${panelKey}:upload` && step === 'thermocouple' && inProgress}
						<form method="POST" action="?/uploadThermo" use:enhance={submitAndClose} class="w-full max-w-md space-y-2 rounded-lg border border-[var(--color-tron-border)] p-3">
							<input type="hidden" name="spuId" value={member.spuId} />
							<input type="hidden" name="readings" value={thermoParsed[member.spuId]?.readingsJson ?? ''} />
							<input type="hidden" name="fileName" value={thermoParsed[member.spuId]?.fileName ?? ''} />
							<ThermoFileUpload
								compact
								onparsed={(p) => thermoParsed[member.spuId] = { readingsJson: p.readingsJson, fileName: p.fileName, count: p.readings.length }}
								onclear={() => delete thermoParsed[member.spuId]}
							/>
							<button
								type="submit"
								disabled={!thermoParsed[member.spuId]}
								class="w-full rounded-lg bg-[var(--color-tron-orange)] px-3 py-2 text-xs font-semibold text-[var(--color-tron-bg-primary)] disabled:cursor-not-allowed disabled:opacity-50"
							>
								Upload for {member.udi}
							</button>
						</form>
					{/if}

					<!-- Manual record panel -->
					{#if openPanel === `${panelKey}:record` && inProgress}
						<form method="POST" action="?/recordStepResult" use:enhance={submitAndClose} class="w-full max-w-md space-y-2 rounded-lg border border-[var(--color-tron-border)] p-3">
							<input type="hidden" name="spuId" value={member.spuId} />
							<input type="hidden" name="step" value={step} />
							<select name="outcome" required class="tron-input w-full rounded-lg px-2 py-1.5 text-xs">
								<option value="" disabled selected>Outcome…</option>
								<option value="passed">Passed</option>
								<option value="failed">Failed</option>
								<option value="skipped">Skipped</option>
							</select>
							<input type="text" name="notes" placeholder="Notes (optional)" class="tron-input w-full rounded-lg px-2 py-1.5 text-xs" />
							<button type="submit" class="w-full rounded-lg bg-[var(--color-tron-cyan)] px-3 py-2 text-xs font-semibold text-[var(--color-tron-bg-primary)]">
								Save result
							</button>
						</form>
					{/if}
				</div>
			</div>
		{/each}

		{#if members.length === 0}
			<p class="tron-text-muted tron-card p-6 text-sm">All SPUs have been removed from this run.</p>
		{/if}
	</div>

	{#if (run.spus ?? []).some(m => m.removedAt)}
		<div class="tron-card p-4">
			<h3 class="tron-text-muted mb-2 text-sm font-medium">Removed from this run</h3>
			<div class="flex flex-wrap gap-2">
				{#each (run.spus ?? []).filter(m => m.removedAt) as m (m.spuId)}
					<span class="tron-text-muted rounded-full bg-[var(--color-tron-bg-tertiary)] px-3 py-1 text-xs">
						{m.udi} · removed {fmtDate(m.removedAt)}
					</span>
				{/each}
			</div>
		</div>
	{/if}

	<a href="/validation/runs" class="inline-block text-sm text-[var(--color-tron-cyan)] hover:underline">← All validation runs</a>
</div>
