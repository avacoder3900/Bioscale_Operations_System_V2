<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import ThermoFileUpload from '$lib/components/validation/thermocouple/ThermoFileUpload.svelte';

	interface StepCell {
		status: string;
		sessionId?: string;
		result?: { min?: number; max?: number; mode?: number; average?: number; readingCount?: number; fileName?: string | null };
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
			thermoCriteria: { minTemp: number; maxTemp: number } | null;
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

	// One expandable panel at a time, keyed `${spuId}:${step}:${mode}`
	let openPanel = $state<string | null>(null);
	let showAbort = $state(false);
	let editingName = $state(false);

	// Per-SPU parsed thermo file (readings JSON + name) for the upload forms
	let thermoParsed = $state<Record<string, { readingsJson: string; fileName: string; count: number }>>({});

	// Live refresh: re-fetch run data every 10s (when the tab is visible) so
	// validations completed elsewhere — another tab, another operator, the
	// instrument pages — appear without a manual reload. Local UI state
	// (open panels, parsed files) survives invalidation.
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

	function sessionHref(sessionId: string): string {
		const s = data.sessionById[sessionId];
		if (s?.type === 'mag') return `/validation/magnetometer/${sessionId}`;
		if (s?.type === 'spec') return `/validation/spectrophotometer/${sessionId}`;
		return `/validation/thermocouple/${sessionId}`;
	}

	function fmtShortDate(d: string | null): string {
		return d ? new Date(d).toLocaleDateString() : '';
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

	function togglePanel(key: string) {
		openPanel = openPanel === key ? null : key;
	}

	function fmtDate(d: string | null | undefined): string {
		return d ? new Date(d).toLocaleString() : '—';
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
			<div class="flex items-center gap-3">
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
			{#if run.abortReason}
				<p class="mt-1 text-sm text-[var(--color-tron-red)]">Aborted: {run.abortReason}</p>
			{/if}
		</div>

		{#if inProgress}
			<div class="flex items-center gap-2">
				<form method="POST" action="?/completeRun" use:enhance>
					<button type="submit" class="rounded-lg bg-[var(--color-tron-green)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-green)]/90">
						Complete Run
					</button>
				</form>
				<button type="button" onclick={() => showAbort = !showAbort} class="rounded-lg border border-[var(--color-tron-red)]/50 px-4 py-2 text-sm font-semibold text-[var(--color-tron-red)] transition-all hover:bg-[var(--color-tron-red)]/10">
					Abort…
				</button>
			</div>
		{/if}
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

	{#if !data.thermoCriteria}
		<div class="rounded-lg border border-[var(--color-tron-orange)]/30 bg-[var(--color-tron-orange)]/10 p-4 text-sm text-[var(--color-tron-orange)]">
			The standard thermocouple acceptance range is not configured yet — uploads are recorded as
			<span class="font-semibold">uploaded</span> and can be evaluated once the range is set.
		</div>
	{:else}
		<p class="tron-text-muted text-sm">
			Thermocouple acceptance range: {data.thermoCriteria.minTemp}°C – {data.thermoCriteria.maxTemp}°C
		</p>
	{/if}

	<!-- SPU × step matrix -->
	<div class="tron-card overflow-x-auto">
		<table class="w-full text-sm">
			<thead>
				<tr class="border-b border-[var(--color-tron-border)] text-left">
					<th class="tron-text-muted p-3 font-medium">UDI</th>
					{#each run.steps as step (step)}
						<th class="tron-text-muted p-3 font-medium">{STEP_LABELS[step] ?? step}</th>
					{/each}
					<th class="tron-text-muted p-3 font-medium">Overall</th>
					<th class="p-3"></th>
				</tr>
			</thead>
			<tbody class="divide-y divide-[var(--color-tron-border)]">
				{#each members as member (member.spuId)}
					<tr class="align-top">
						<td class="p-3">
							<a href="/spu/{member.spuId}" class="tron-heading font-medium hover:text-[var(--color-tron-cyan)] hover:underline">{member.udi}</a>
							{#if data.spuById[member.spuId]?.finalized}
								<span class="tron-text-muted block text-xs">finalized</span>
							{/if}
						</td>

						{#each run.steps as step (step)}
							{@const cell = cellFor(member, step)}
							{@const prior = cell.status === 'not_started' ? priorFor(member, step) : null}
							{@const panelKey = `${member.spuId}:${step}`}
							<td class="p-3 {cell.status === 'passed' ? 'bg-[var(--color-tron-green)]/10' : cell.status === 'failed' ? 'bg-[var(--color-tron-red)]/5' : ''}">
								<div class="flex flex-col items-start gap-1.5">
									{#if prior}
										<!-- Carried over from the SPU's DHR (spu.validation.*) -->
										<span class="rounded-full px-2 py-1 text-xs font-medium {chip(prior.status)}">{chipLabel(prior.status)} · prior</span>
										<span class="tron-text-muted text-xs">
											from device record{#if prior.completedAt}&nbsp;· {fmtShortDate(prior.completedAt)}{/if}
										</span>
										{#if prior.status === 'failed' && prior.failureReasons?.length}
											<span class="max-w-56 text-xs text-[var(--color-tron-red)]">{prior.failureReasons.join('; ')}</span>
										{/if}
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
												<button type="submit" class="text-xs text-[var(--color-tron-cyan)] hover:underline">Use this result</button>
											</form>
										{/if}
									{:else}
										<span class="rounded-full px-2 py-1 text-xs font-medium {chip(cell.status)}">{chipLabel(cell.status)}</span>
									{/if}

									{#if step === 'thermocouple' && cell.result}
										<span class="tron-text-muted text-xs">
											{#if cell.result.min != null && cell.result.max != null}
												min {cell.result.min.toFixed(1)} · max {cell.result.max.toFixed(1)}°C
											{/if}
											{#if cell.result.mode != null}
												· mode {cell.result.mode.toFixed(1)}°C
											{/if}
											{#if cell.result.fileName}
												· {cell.result.fileName}
											{/if}
										</span>
									{/if}
									{#if step === 'thermocouple' && cell.status === 'uploaded' && inProgress}
										<!-- Verdict on the displayed values (manual until the
										     larger-dataset acceptance range is defined) -->
										<div class="flex gap-2">
											<form method="POST" action="?/recordStepResult" use:enhance>
												<input type="hidden" name="spuId" value={member.spuId} />
												<input type="hidden" name="step" value={step} />
												<input type="hidden" name="outcome" value="passed" />
												<input type="hidden" name="notes" value="Approved on mode/min/max review" />
												<button type="submit" class="rounded-lg bg-[var(--color-tron-green)] px-3 py-1.5 text-xs font-semibold text-[var(--color-tron-bg-primary)] hover:bg-[var(--color-tron-green)]/90">
													Approve
												</button>
											</form>
											<form method="POST" action="?/recordStepResult" use:enhance>
												<input type="hidden" name="spuId" value={member.spuId} />
												<input type="hidden" name="step" value={step} />
												<input type="hidden" name="outcome" value="failed" />
												<input type="hidden" name="notes" value="Rejected on mode/min/max review" />
												<button type="submit" class="rounded-lg border border-[var(--color-tron-red)]/50 px-3 py-1.5 text-xs font-semibold text-[var(--color-tron-red)] hover:bg-[var(--color-tron-red)]/10">
													Reject
												</button>
											</form>
										</div>
									{/if}
									{#if cell.evaluation}
										<span class="tron-text-muted text-xs">
											vs {cell.evaluation.criteria.minTemp}–{cell.evaluation.criteria.maxTemp}°C
										</span>
									{/if}
									{#if cell.status === 'failed' && cell.evaluation?.failureReasons?.length}
										<span class="max-w-56 text-xs text-[var(--color-tron-red)]">
											{cell.evaluation.failureReasons.join('; ')}
										</span>
									{/if}
									{#if cell.previous?.length}
										<span class="tron-text-muted text-xs">
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
										</span>
									{/if}
									{#if cell.sessionId && data.sessionById[cell.sessionId]}
										<a href={sessionHref(cell.sessionId)} class="text-xs text-[var(--color-tron-cyan)] hover:underline">
											{data.sessionById[cell.sessionId].barcode ?? 'session'} →
										</a>
									{/if}
									{#if cell.notes}
										<span class="tron-text-muted text-xs italic">{cell.notes}</span>
									{/if}

									{#if inProgress}
										<div class="flex flex-wrap gap-2">
											{#if step === 'thermocouple'}
												<button type="button" onclick={() => togglePanel(`${panelKey}:upload`)} class="text-xs text-[var(--color-tron-orange)] hover:underline">
													{cell.status === 'not_started' ? 'Upload data' : cell.status === 'uploaded' ? 'Re-upload' : 'Run again'}
												</button>
												{#if cell.status === 'uploaded' && data.thermoCriteria}
													<form method="POST" action="?/evaluateThermo" use:enhance>
														<input type="hidden" name="spuId" value={member.spuId} />
														<button type="submit" class="text-xs text-[var(--color-tron-cyan)] hover:underline">Evaluate</button>
													</form>
												{/if}
											{:else if step === 'magnetometer'}
												<a href="/validation/magnetometer?udi={encodeURIComponent(member.udi)}&runId={run._id}" class="text-xs text-[var(--color-tron-orange)] hover:underline">
													{cell.status === 'not_started' || cell.status === 'in_progress' ? 'Run test →' : 'Run again →'}
												</a>
											{:else if step === 'optical_confirmation'}
												<a href="/validation/optical-confirmation?udi={encodeURIComponent(member.udi)}&runId={run._id}" class="text-xs text-[var(--color-tron-orange)] hover:underline">
													{cell.status === 'not_started' || cell.status === 'in_progress' ? 'Open →' : 'Run again →'}
												</a>
											{/if}
											<button type="button" onclick={() => togglePanel(`${panelKey}:record`)} class="tron-text-muted text-xs hover:text-[var(--color-tron-cyan)]">
												Record result
											</button>
										</div>
									{/if}

									<!-- Thermo upload panel -->
									{#if openPanel === `${panelKey}:upload` && step === 'thermocouple' && inProgress}
										<form method="POST" action="?/uploadThermo" use:enhance={submitAndClose} class="mt-2 w-64 space-y-2 rounded-lg border border-[var(--color-tron-border)] p-3">
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
										<form method="POST" action="?/recordStepResult" use:enhance={submitAndClose} class="mt-2 w-64 space-y-2 rounded-lg border border-[var(--color-tron-border)] p-3">
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
							</td>
						{/each}

						<td class="p-3">
							<span class="tron-heading font-medium">{passedCount(member)}/{run.steps.length}</span>
							{#if allPassed(member) && data.spuById[member.spuId]?.status === 'validating'}
								<form method="POST" action="?/markValidated" use:enhance class="mt-1">
									<input type="hidden" name="spuId" value={member.spuId} />
									<button type="submit" class="rounded-lg bg-[var(--color-tron-green)] px-3 py-1.5 text-xs font-semibold text-[var(--color-tron-bg-primary)] hover:bg-[var(--color-tron-green)]/90">
										Mark validated
									</button>
								</form>
							{:else if data.spuById[member.spuId]?.status === 'validated'}
								<span class="block text-xs text-[var(--color-tron-green)]">validated ✓</span>
							{/if}
						</td>

						<td class="p-3 text-right">
							{#if inProgress}
								<form method="POST" action="?/removeSpu" use:enhance>
									<input type="hidden" name="spuId" value={member.spuId} />
									<button type="submit" class="tron-text-muted text-xs hover:text-[var(--color-tron-red)]" title="Remove from run">
										Remove
									</button>
								</form>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>

		{#if members.length === 0}
			<p class="tron-text-muted p-6 text-sm">All SPUs have been removed from this run.</p>
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
