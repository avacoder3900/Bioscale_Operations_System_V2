<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { TronCard, TronBadge, TronButton } from '$lib/components/ui';
	import SpuStatusBadge from '$lib/components/spu/SpuStatusBadge.svelte';

	let { data, form: _form } = $props();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const form = _form as any;

	// Which view tab is active.
	const TABS = [
		{ k: 'device', label: 'Device Information' },
		{ k: 'document', label: 'Full Document' },
		{ k: 'validation', label: 'Validation' }
	] as const;
	let view = $state<'device' | 'document' | 'validation'>('device');

	let showStateForm = $state(false);
	let updatingState = $state(false);
	let confirmingDelete = $state(false);
	let deleting = $state(false);
	let editingIdentifiers = $state(false);
	let savingIdentifiers = $state(false);
	let editUdi = $state(data.spu.udi);
	let editBarcode = $state(data.spu.barcode ?? '');
	let pinging = $state(false);
	let unlinking = $state(false);
	let renaming = $state(false);
	let showRenameForm = $state(false);

	let uploadingCsv = $state(false);
	let expandedAttachment = $state<string | null>(null);

	// Device journal (SPU-INV-06)
	let journalText = $state('');
	let addingJournal = $state(false);

	let showRecordHistory = $state(false);
	let transitionReason = $state('');

	const deviceId = $derived(data.particleLink?.particleDeviceId ?? data.spu.id);

	// Last known device vitals — the Particle console's "Last vitals" panel (SPU-INV-05).
	type Vitals = {
		updatedAt: string | null;
		signalStrength: number | null;
		signalQuality: number | null;
		operator: string | null;
		accessTechnology: string | null;
		cellGlobalIdentity: string | null;
		roundTripMs: number | null;
		ramUsed: number | null;
		ramTotal: number | null;
		disconnects: number | null;
		rateLimitedPublishes: number | null;
	};
	const vitalsDeviceId = $derived(data.particleLink?.particleDeviceId ?? null);
	let vitals = $state<Vitals | null>(null);
	let vitalsStatus = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');

	async function loadVitals() {
		if (!vitalsDeviceId) return;
		vitalsStatus = 'loading';
		try {
			const res = await fetch(`/api/particle/vitals/${vitalsDeviceId}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			vitals = await res.json();
			vitalsStatus = 'ready';
		} catch {
			vitalsStatus = 'error';
		}
	}

	onMount(() => {
		if (vitalsDeviceId) loadVitals();
	});

	function fmtBytes(n: number): string {
		if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
		return `${(n / 1024).toFixed(1)}kB`;
	}

	// Servicing
	let showServicing = $state(false);
	let submittingService = $state(false);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const serviceRecords = $derived(((data.spu as any).serviceRecords ?? []) as any[]);
	const openService = $derived(serviceRecords.find((r) => r.status === 'open') ?? null);
	const currentCycle = $derived(serviceRecords.filter((r) => r.status === 'returned').length);

	// Which service cycle a validation belongs to (0 = new device, k = post-service #k).
	function validationPhase(completedAt: string | Date | null | undefined): number | null {
		if (!completedAt) return null;
		const t = new Date(completedAt).getTime();
		return serviceRecords.filter((r) => r.status === 'returned' && r.returnedAt && new Date(r.returnedAt).getTime() <= t).length;
	}
	function phaseLabel(phase: number | null): string {
		if (phase === null) return '';
		return phase === 0 ? 'New device' : `Post-service #${phase}`;
	}

	// Overall validation status for the Validation tab summary badge
	const validationOverall = $derived((data.spu.validation as any)?.status ?? 'pending');
	// Count a test only if it passed AND was done in the current service cycle.
	const validationPassedCount = $derived(
		['magnetometer', 'spectrophotometer', 'thermocouple'].filter((k) => {
			const r = (data.spu.validation as any)?.[k];
			const passed = r?.status === 'passed' || r?.status === 'overridden';
			return passed && validationPhase(r?.completedAt) === currentCycle;
		}).length
	);

	const STATUS_OPTIONS = [
		'draft', 'assembling', 'assembled', 'validating', 'validated',
		'released-rnd', 'released-manufacturing', 'released-field',
		'deployed', 'servicing', 'retired', 'voided'
	] as const;

	function statusColor(status: string): string {
		if (['released-rnd', 'released-manufacturing', 'released-field', 'deployed'].includes(status)) return 'var(--color-tron-green)';
		if (['assembling', 'assembled'].includes(status)) return 'var(--color-tron-cyan)';
		if (['validating', 'validated'].includes(status)) return 'var(--color-tron-yellow, #fbbf24)';
		if (status === 'servicing') return 'var(--color-tron-orange, #f97316)';
		if (['retired', 'voided'].includes(status)) return 'var(--color-tron-red, #ef4444)';
		return 'var(--color-tron-text-secondary)';
	}

	function formatDate(date: Date | string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleString();
	}

	function formatBytes(bytes: number): string {
		if (!bytes) return '—';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	const fieldLabels: Record<string, string> = {
		status: 'Status',
		batchId: 'Batch'
	};

	function describeAuditEntry(entry: {
		action: string;
		reason: string | null;
		oldData: Record<string, unknown> | null;
		newData: Record<string, unknown> | null;
	}): string {
		if (entry.reason) return entry.reason;
		if (entry.action === 'INSERT') return 'SPU record created';
		if (entry.action === 'DELETE') return 'SPU record deleted';
		const oldData = entry.oldData ?? {};
		const newData = entry.newData ?? {};
		const keys = new Set([...Object.keys(oldData), ...Object.keys(newData)]);
		const changes: string[] = [];
		for (const key of keys) {
			const oldVal = JSON.stringify(oldData[key] ?? null);
			const newVal = JSON.stringify(newData[key] ?? null);
			if (oldVal !== newVal) {
				const label = fieldLabels[key] ?? key;
				const from = oldData[key] ?? '—';
				const to = newData[key] ?? '—';
				changes.push(`${label}: ${from} → ${to}`);
			}
		}
		return changes.length > 0 ? changes.join(', ') : 'Record updated';
	}

	$effect(() => {
		if (form?.success) {
			showStateForm = false;
			transitionReason = '';
			showServicing = false;
		}
	});
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h2 class="tron-text-primary font-mono text-2xl font-bold">{data.spu.udi}</h2>
			<p class="tron-text-muted">Device History Record</p>
		</div>
		<div class="flex items-center gap-2">
			<SpuStatusBadge status={data.spu.status} />
			<!-- Servicing: opens the quick service window (Phase A send / Phase B return) -->
			<TronButton
				variant="primary"
				onclick={() => (showServicing = true)}
				style="min-height: 40px; background: var(--color-tron-orange); border-color: var(--color-tron-orange);"
			>
				🔧 Servicing{#if openService} (open){/if}
			</TronButton>
		</div>
	</div>

	{#if form?.error}
		<div
			class="rounded border px-4 py-2 text-sm"
			style="border-color: var(--color-tron-error); color: var(--color-tron-error);"
		>
			{form.error}
		</div>
	{/if}

	<!-- View tabs -->
	<div class="flex flex-wrap items-center gap-2 border-b border-[var(--color-tron-border)] pb-3">
		{#each TABS as tab (tab.k)}
			<button
				type="button"
				onclick={() => (view = tab.k)}
				class="rounded-lg px-4 py-2 text-sm font-medium transition-colors"
				style={view === tab.k
					? 'background: var(--color-tron-cyan); color: var(--color-tron-bg);'
					: 'color: var(--color-tron-text-secondary);'}
			>
				{tab.label}{#if tab.k === 'validation'} ({validationPassedCount}/3){/if}
			</button>
		{/each}
		<a
			href="/validation"
			class="ml-auto inline-flex items-center gap-1 text-sm hover:underline"
			style="color: var(--color-tron-cyan);"
		>
			Validation (BIMS) ↗
		</a>
	</div>

	<!-- ═══════════════ DEVICE INFORMATION ═══════════════ -->
	{#if view === 'device'}
		<div class="grid grid-cols-1 gap-6 md:grid-cols-2">
			<!-- Device Information -->
			<TronCard>
				<div class="mb-4 flex items-center justify-between">
					<h3 class="tron-text-primary text-lg font-medium">Device Information</h3>
					{#if !editingIdentifiers}
						<TronButton variant="ghost" onclick={() => { editingIdentifiers = true; editUdi = data.spu.udi; editBarcode = data.spu.barcode ?? ''; }} style="font-size: 0.75rem; padding: 4px 8px;">
							✏️ Edit
						</TronButton>
					{/if}
				</div>
				<form
					method="POST"
					action="?/updateIdentifiers"
					use:enhance={() => {
						savingIdentifiers = true;
						return async ({ result, update }) => {
							savingIdentifiers = false;
							if (result.type === 'success') editingIdentifiers = false;
							await update();
						};
					}}
				>
					<dl class="space-y-3">
						<!-- While editing, non-editable rows grey out so it's obvious only
						     UDI and Barcode are typable. -->
						<div class="flex justify-between {editingIdentifiers ? 'opacity-40' : ''}">
							<dt class="tron-text-muted">Device ID</dt>
							<dd class="tron-text-primary font-mono text-sm break-all">{deviceId}</dd>
						</div>
						<div class="flex items-center justify-between gap-3">
							<dt class="tron-text-muted">
								{#if editingIdentifiers}<label for="edit-udi">UDI</label>{:else}UDI{/if}
							</dt>
							{#if editingIdentifiers}
								<input id="edit-udi" name="udi" type="text" class="tron-input font-mono text-sm" bind:value={editUdi} required style="min-height: 38px; max-width: 65%;" />
							{:else}
								<dd class="tron-text-primary font-mono">{data.spu.udi}</dd>
							{/if}
						</div>
						<div class="flex items-center justify-between gap-3">
							<dt class="tron-text-muted">
								{#if editingIdentifiers}<label for="edit-barcode">Barcode</label>{:else}Barcode{/if}
							</dt>
							{#if editingIdentifiers}
								<input id="edit-barcode" name="barcode" type="text" class="tron-input font-mono text-sm" bind:value={editBarcode} placeholder="Scan or enter barcode" style="min-height: 38px; max-width: 65%;" />
							{:else}
								<dd class="tron-text-primary font-mono">{data.spu.barcode ?? '—'}</dd>
							{/if}
						</div>
						<div class="flex justify-between {editingIdentifiers ? 'opacity-40' : ''}">
							<dt class="tron-text-muted">Batch</dt>
							<dd>
								{#if data.batch}
									<a href="/spu/batches/{data.batch.id}" class="font-mono underline" style="color: var(--color-tron-cyan);">{data.batch.batchNumber}</a>
								{:else}
									<span class="text-sm" style="color: var(--color-tron-orange);">Not associated with a production batch</span>
								{/if}
							</dd>
						</div>
						<div class="flex justify-between {editingIdentifiers ? 'opacity-40' : ''}">
							<dt class="tron-text-muted">Created</dt>
							<dd class="tron-text-primary">{formatDate(data.spu.createdAt)}</dd>
						</div>
						<div class="flex justify-between {editingIdentifiers ? 'opacity-40' : ''}">
							<dt class="tron-text-muted">Created By</dt>
							<dd class="tron-text-primary">{data.createdByName ?? '—'}</dd>
						</div>

						{#if data.spu.owner}
							<div class="flex justify-between {editingIdentifiers ? 'opacity-40' : ''}">
								<dt class="tron-text-muted">Owner</dt>
								<dd class="tron-text-primary">{data.spu.owner}</dd>
							</div>
						{/if}
						{#if data.spu.ownerNotes}
							<div class="flex justify-between {editingIdentifiers ? 'opacity-40' : ''}">
								<dt class="tron-text-muted">Owner Notes</dt>
								<dd class="tron-text-primary">{data.spu.ownerNotes}</dd>
							</div>
						{/if}
					</dl>
					{#if editingIdentifiers}
						<div class="mt-4 flex gap-2 border-t border-[var(--color-tron-border)] pt-4">
							<TronButton variant="primary" type="submit" disabled={savingIdentifiers} style="font-size: 0.75rem; padding: 4px 12px;">
								{savingIdentifiers ? 'Saving...' : 'Save'}
							</TronButton>
							<TronButton variant="ghost" type="button" onclick={() => { editingIdentifiers = false; }} style="font-size: 0.75rem; padding: 4px 12px;">
								Cancel
							</TronButton>
						</div>
					{/if}
				</form>
			</TronCard>

			<!-- Status Management -->
			<TronCard>
				<div class="mb-4 flex items-center justify-between">
					<h3 class="tron-text-primary text-lg font-medium">Status</h3>
					<SpuStatusBadge status={data.spu.status} />
				</div>

				{#if !showStateForm}
					<TronButton variant="primary" onclick={() => (showStateForm = true)} style="min-height: 44px; width: 100%;">
						Transition Status
					</TronButton>
				{:else}
					<form
						method="POST"
						action="?/transitionStatus"
						use:enhance={() => {
							updatingState = true;
							return async ({ result, update }) => {
								updatingState = false;
								await update();
							};
						}}
						class="space-y-4 rounded border border-[var(--color-tron-cyan)] bg-[rgba(0,255,255,0.03)] p-4"
					>
						<div>
							<label for="transition-status" class="tron-label">New Status</label>
							<select id="transition-status" name="status" class="tron-select w-full" required disabled={updatingState} style="min-height: 44px;">
								{#each STATUS_OPTIONS as opt (opt)}
									{#if opt !== data.spu.status}
										<option value={opt}>{opt}</option>
									{/if}
								{/each}
							</select>
						</div>
						<div>
							<label for="transition-reason" class="tron-label">Reason (optional)</label>
							<input id="transition-reason" name="reason" type="text" class="tron-input" placeholder="Why is the status changing?" bind:value={transitionReason} disabled={updatingState} style="min-height: 44px;" />
						</div>
						<div class="flex gap-3">
							<TronButton type="button" class="flex-1" onclick={() => (showStateForm = false)} disabled={updatingState}>Cancel</TronButton>
							<TronButton type="submit" variant="primary" class="flex-1" disabled={updatingState}>
								{updatingState ? 'Updating...' : 'Confirm Transition'}
							</TronButton>
						</div>
					</form>
				{/if}

				<!-- Delete SPU -->
				{#if !data.spu.finalizedAt}
					{#if !confirmingDelete}
						<button
							type="button"
							onclick={() => (confirmingDelete = true)}
							class="mt-4 w-full rounded border px-4 py-2 text-sm"
							style="border-color: var(--color-tron-red); color: var(--color-tron-red); background: transparent;"
						>
							🗑️ Delete SPU
						</button>
					{:else}
						<div class="mt-4 rounded border p-4 space-y-3" style="border-color: var(--color-tron-red); background: rgba(255,0,0,0.05);">
							<p class="text-sm" style="color: var(--color-tron-red);">Are you sure you want to permanently delete <strong>{data.spu.udi}</strong>? This cannot be undone.</p>
							<div class="flex gap-2">
								<form
									method="POST"
									action="?/deleteSpu"
									use:enhance={() => {
										deleting = true;
										return async ({ result }) => {
											deleting = false;
											if (result.type === 'success') {
												window.location.href = '/spu';
											}
										};
									}}
								>
									<button type="submit" disabled={deleting} class="rounded px-4 py-2 text-sm font-medium" style="background: var(--color-tron-red); color: white;">
										{deleting ? 'Deleting...' : 'Yes, Delete'}
									</button>
								</form>
								<button type="button" onclick={() => (confirmingDelete = false)} class="tron-text-muted rounded px-4 py-2 text-sm">Cancel</button>
							</div>
						</div>
					{/if}
				{/if}

				<!-- Immutable Status Transition Log -->
				<div class="mt-6 border-t pt-4" style="border-color: var(--color-tron-border);">
					<h4 class="tron-text-muted mb-3 text-sm font-medium uppercase tracking-wide">Status Transition Log</h4>
					{#if data.spu.statusTransitions && data.spu.statusTransitions.length > 0}
						<div class="space-y-0">
							{#each data.spu.statusTransitions as entry (entry.id)}
								<div class="flex items-start gap-3 border-l-2 py-3 pl-4" style="border-color: {statusColor(entry.to)};">
									<div class="-ml-[21px] mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full" style="background: var(--color-tron-bg); border: 2px solid {statusColor(entry.to)};">
										<span class="text-[8px]" style="color: {statusColor(entry.to)};">→</span>
									</div>
									<div class="min-w-0 flex-1">
										<div class="flex flex-wrap items-center gap-2">
											{#if entry.from}
												<span class="rounded px-2 py-0.5 text-[10px] font-bold uppercase" style="background: color-mix(in srgb, {statusColor(entry.from)} 20%, transparent); color: {statusColor(entry.from)};">{entry.from}</span>
												<span class="tron-text-muted text-xs">→</span>
											{/if}
											<span class="rounded px-2 py-0.5 text-[10px] font-bold uppercase" style="background: color-mix(in srgb, {statusColor(entry.to)} 20%, transparent); color: {statusColor(entry.to)};">{entry.to}</span>
										</div>
										{#if entry.reason}
											<p class="tron-text-muted mt-1 text-xs italic">"{entry.reason}"</p>
										{/if}
										<p class="mt-1 text-xs" style="color: var(--color-tron-cyan); opacity: 0.6;">
											{entry.changedBy} · {formatDate(entry.changedAt)}
										</p>
									</div>
								</div>
							{/each}
						</div>
					{:else}
						<p class="tron-text-muted py-4 text-center text-sm">No status transitions recorded yet.</p>
					{/if}
				</div>
			</TronCard>
		</div>

		<!-- Device Journal (SPU-INV-06): free-form, append-only story of the unit -->
		<TronCard>
			<h3 class="tron-text-primary mb-1 text-lg font-medium">Journal</h3>
			<p class="tron-text-muted mb-4 text-sm">
				Free-form log for this unit's story — observations, quirks, context the structured fields
				can't hold. Entries are permanent.
			</p>
			<form
				method="POST"
				action="?/addJournalEntry"
				use:enhance={() => {
					addingJournal = true;
					return async ({ result, update }) => {
						addingJournal = false;
						if (result.type === 'success') journalText = '';
						await update();
					};
				}}
				class="mb-5 space-y-3"
			>
				<textarea
					name="text"
					class="tron-input w-full"
					rows="3"
					maxlength="5000"
					placeholder="Write a journal entry… (e.g. “Ran hot during June pilot — thermals fine after re-seat, keep an eye on it”)"
					bind:value={journalText}
					disabled={addingJournal}
				></textarea>
				<div class="flex justify-end">
					<TronButton type="submit" variant="primary" disabled={addingJournal || !journalText.trim()} style="min-height: 40px;">
						{addingJournal ? 'Adding…' : 'Add Entry'}
					</TronButton>
				</div>
			</form>

			{#if data.spu.journal.length === 0}
				<p class="tron-text-muted py-4 text-center text-sm">
					No entries yet — start this unit's story above.
				</p>
			{:else}
				<div class="space-y-0">
					{#each data.spu.journal as entry (entry.id)}
						<div class="border-l-2 border-[var(--color-tron-cyan)] py-3 pl-4">
							<p class="tron-text-primary text-sm whitespace-pre-wrap">{entry.text}</p>
							<p class="mt-1 text-xs" style="color: var(--color-tron-cyan); opacity: 0.6;">
								{entry.createdByName ?? 'Unknown'} · {entry.createdAt ? new Date(entry.createdAt).toLocaleString() : '—'}
							</p>
						</div>
					{/each}
				</div>
			{/if}
		</TronCard>

		{#snippet vitalsPanel()}
			{#if vitalsDeviceId}
				<div class="mt-4 border-t border-[var(--color-tron-border)] pt-4">
					<div class="mb-3 flex items-center gap-2">
						<h4 class="tron-text-primary font-medium">Last Vitals</h4>
						<button
							type="button"
							class="tron-text-muted text-sm transition-colors hover:text-[var(--color-tron-cyan)]"
							onclick={loadVitals}
							disabled={vitalsStatus === 'loading'}
							title="Refresh vitals"
						>
							{vitalsStatus === 'loading' ? '…' : '⟳'}
						</button>
						{#if vitals?.updatedAt}
							<span class="tron-text-muted text-xs">{new Date(vitals.updatedAt).toLocaleString()}</span>
						{/if}
					</div>
					{#if vitalsStatus === 'error'}
						<p class="tron-text-muted text-sm">Vitals unavailable.</p>
					{:else if vitalsStatus === 'loading' && !vitals}
						<p class="tron-text-muted text-sm">Loading vitals…</p>
					{:else if vitals}
						<dl class="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4">
							{#if vitals.signalStrength !== null}
								<div>
									<dt class="tron-text-muted text-xs">Signal Strength</dt>
									<dd class="tron-text-primary text-lg font-bold">{vitals.signalStrength}%</dd>
								</div>
							{/if}
							{#if vitals.signalQuality !== null}
								<div>
									<dt class="tron-text-muted text-xs">Signal Quality</dt>
									<dd class="tron-text-primary text-lg font-bold">{vitals.signalQuality}%</dd>
								</div>
							{/if}
							{#if vitals.roundTripMs !== null}
								<div>
									<dt class="tron-text-muted text-xs">Round-Trip Time</dt>
									<dd class="tron-text-primary text-lg font-bold">{vitals.roundTripMs}ms</dd>
								</div>
							{/if}
							{#if vitals.ramUsed !== null}
								<div>
									<dt class="tron-text-muted text-xs">RAM Used</dt>
									<dd class="tron-text-primary text-lg font-bold">
										{fmtBytes(vitals.ramUsed)}{vitals.ramTotal !== null ? ` of ${fmtBytes(vitals.ramTotal)}` : ''}
									</dd>
								</div>
							{/if}
							{#if vitals.operator}
								<div>
									<dt class="tron-text-muted text-xs">Operator</dt>
									<dd class="tron-text-primary text-sm">{vitals.operator}</dd>
								</div>
							{/if}
							{#if vitals.accessTechnology}
								<div>
									<dt class="tron-text-muted text-xs">Access Technology</dt>
									<dd class="tron-text-primary text-sm">{vitals.accessTechnology}</dd>
								</div>
							{/if}
							{#if vitals.cellGlobalIdentity}
								<div>
									<dt class="tron-text-muted text-xs">Cell Global Identity</dt>
									<dd class="tron-text-primary font-mono text-sm break-all">{vitals.cellGlobalIdentity}</dd>
								</div>
							{/if}
							{#if vitals.disconnects !== null}
								<div>
									<dt class="tron-text-muted text-xs">Cloud Disconnects</dt>
									<dd class="tron-text-primary text-sm">{vitals.disconnects}</dd>
								</div>
							{/if}
							{#if vitals.rateLimitedPublishes !== null}
								<div>
									<dt class="tron-text-muted text-xs">Rate-Limited Publishes</dt>
									<dd class="tron-text-primary text-sm">{vitals.rateLimitedPublishes}</dd>
								</div>
							{/if}
						</dl>
					{/if}
				</div>
			{/if}
		{/snippet}

		{#if data.particleDevice}
			<TronCard>
				<div class="mb-4 flex items-center justify-between">
					<h3 class="tron-text-primary text-lg font-medium">Particle IoT Device</h3>
					<div class="flex items-center gap-2">
						{#if data.particleDevice.status === 'online'}
							<TronBadge variant="success">Online</TronBadge>
						{:else}
							<TronBadge variant="neutral">{data.particleDevice.status ?? 'Offline'}</TronBadge>
						{/if}
					</div>
				</div>
				<dl class="grid grid-cols-2 gap-4 md:grid-cols-3">
					<div>
						<dt class="tron-text-muted text-sm">Device Name</dt>
						<dd class="tron-text-primary font-mono">{data.particleDevice.name}</dd>
					</div>
					<div>
						<dt class="tron-text-muted text-sm">Particle Device ID</dt>
						<dd class="tron-text-primary font-mono text-xs break-all">{data.particleDevice.particleDeviceId}</dd>
					</div>
					{#if data.particleDevice.serialNumber}
						<div>
							<dt class="tron-text-muted text-sm">Serial</dt>
							<dd class="tron-text-primary font-mono">{data.particleDevice.serialNumber}</dd>
						</div>
					{/if}
					{#if data.particleDevice.firmwareVersion}
						<div>
							<dt class="tron-text-muted text-sm">Firmware</dt>
							<dd class="tron-text-primary font-mono">{data.particleDevice.firmwareVersion}</dd>
						</div>
					{/if}
					<div>
						<dt class="tron-text-muted text-sm">Last Heard</dt>
						<dd class="tron-text-primary">{formatDate(data.particleDevice.lastHeardAt)}</dd>
					</div>
				</dl>
				{@render vitalsPanel()}
				<div class="mt-4 flex flex-wrap items-center gap-3 border-t border-[var(--color-tron-border)] pt-4">
					<form method="POST" action="?/pingDevice" use:enhance={() => { pinging = true; return async ({ update }) => { pinging = false; await update(); }; }}>
						<TronButton type="submit" disabled={pinging} style="min-height: 44px;">{pinging ? 'Pinging...' : 'Ping Device'}</TronButton>
					</form>
					{#if !showRenameForm}
						<TronButton type="button" onclick={() => (showRenameForm = true)} style="min-height: 44px;">Rename</TronButton>
					{/if}
					<form method="POST" action="?/unlinkParticle" use:enhance={() => { unlinking = true; return async ({ update }) => { unlinking = false; await update(); }; }}>
						<TronButton type="submit" disabled={unlinking} style="min-height: 44px;">{unlinking ? 'Unlinking...' : 'Unlink Device'}</TronButton>
					</form>
				</div>
				{#if showRenameForm}
					<form method="POST" action="?/renameDevice" use:enhance={() => { renaming = true; return async ({ result, update }) => { renaming = false; if (result.type === 'success') showRenameForm = false; await update(); }; }} class="mt-3 flex items-center gap-3">
						<input name="name" type="text" class="tron-input flex-1" placeholder="New device name" value={data.particleDevice.name} required disabled={renaming} style="min-height: 44px;" />
						<TronButton type="submit" variant="primary" disabled={renaming} style="min-height: 44px;">{renaming ? 'Saving...' : 'Save'}</TronButton>
						<TronButton type="button" onclick={() => (showRenameForm = false)} disabled={renaming} style="min-height: 44px;">Cancel</TronButton>
					</form>
				{/if}
				{#if form?.message}
					<div class="mt-3 rounded border border-[var(--color-tron-green)] bg-[rgba(0,255,136,0.1)] p-3">
						<p class="text-sm text-[var(--color-tron-green)]">{form.message}</p>
					</div>
				{/if}
			</TronCard>
		{:else if data.particleLink}
			<TronCard>
				<h3 class="tron-text-primary mb-4 text-lg font-medium">Particle Link</h3>
				<dl class="grid grid-cols-2 gap-4 md:grid-cols-3">
					<div>
						<dt class="tron-text-muted text-sm">Serial</dt>
						<dd class="tron-text-primary font-mono">{data.particleLink.particleSerial}</dd>
					</div>
					<div>
						<dt class="tron-text-muted text-sm">Device ID</dt>
						<dd class="tron-text-primary font-mono">{data.particleLink.particleDeviceId ?? '—'}</dd>
					</div>
					<div>
						<dt class="tron-text-muted text-sm">Linked At</dt>
						<dd class="tron-text-primary">{formatDate(data.particleLink.linkedAt)}</dd>
					</div>
				</dl>
				{@render vitalsPanel()}
			</TronCard>
		{/if}

		<!-- Diagnostics Link -->
		{#if data.particleLink?.particleDeviceId}
			<TronCard>
				<div class="flex items-center justify-between">
					<div>
						<h3 class="tron-text-primary text-lg font-medium">Device Diagnostics</h3>
						<p class="tron-text-muted text-sm">Session logs, crash reports, webhook activity</p>
					</div>
					<a href="/spu/{data.spu.id}/diagnostics">
						<TronButton variant="primary" style="min-height: 44px;">
							View Diagnostics
						</TronButton>
					</a>
				</div>
			</TronCard>
		{/if}
	{/if}

	<!-- ═══════════════ VALIDATION ═══════════════ -->
	{#if view === 'validation'}
		<TronCard>
			<div class="mb-4 flex items-center justify-between">
				<h3 class="tron-text-primary text-lg font-medium">
					Validation
					<span
						class="ml-2 rounded-full px-2 py-0.5 text-xs font-bold align-middle"
						style="color: {validationPassedCount >= 3 ? 'var(--color-tron-green)' : 'var(--color-tron-red)'}; background: rgba(128,128,128,0.12);"
					>
						{validationPassedCount}/3
					</span>
					<span
						class="ml-1 rounded-full px-2 py-0.5 text-xs font-bold align-middle"
						style="color: {validationOverall === 'passed' ? 'var(--color-tron-green)' : validationOverall === 'failed' ? 'var(--color-tron-red)' : 'var(--color-tron-orange)'}; background: rgba(128,128,128,0.12);"
					>
						{validationOverall.toUpperCase()}
					</span>
				</h3>
				<a href="/validation" class="text-sm hover:underline" style="color: var(--color-tron-cyan);">Open in BIMS Validation ↗</a>
			</div>

			<div class="grid grid-cols-1 gap-3 md:grid-cols-3">
				{#each [
					{ name: 'Magnetometer', key: 'magnetometer', icon: '🧲' },
					{ name: 'Spectrophotometer', key: 'spectrophotometer', icon: '🔬' },
					{ name: 'Thermocouple', key: 'thermocouple', icon: '🌡️' }
				] as test (test.key)}
					{@const result = (data.spu.validation as any)?.[test.key]}
					<div class="rounded-lg border p-3" style="border-color: {result?.status === 'passed' || result?.status === 'overridden' ? 'var(--color-tron-green)' : result?.status === 'failed' ? 'var(--color-tron-red)' : 'var(--color-tron-border)'}; background: {result?.status === 'passed' || result?.status === 'overridden' ? 'rgba(0,255,100,0.05)' : result?.status === 'failed' ? 'rgba(255,0,0,0.05)' : 'var(--color-tron-bg-secondary)'};">
						<div class="text-center">
							<div class="text-lg">{test.icon}</div>
							<div class="tron-text-primary text-xs font-bold mt-1">{test.name}</div>
							<div class="mt-2">
								{#if result?.status === 'passed'}
									<span class="rounded-full px-2 py-0.5 text-xs font-bold" style="color: var(--color-tron-green); background: rgba(0,255,100,0.15);">PASS</span>
								{:else if result?.status === 'overridden'}
									<span class="rounded-full px-2 py-0.5 text-xs font-bold" style="color: var(--color-tron-yellow, #fbbf24); background: rgba(251,191,36,0.15);">OVERRIDDEN</span>
								{:else if result?.status === 'failed'}
									<span class="rounded-full px-2 py-0.5 text-xs font-bold" style="color: var(--color-tron-red); background: rgba(255,0,0,0.15);">FAIL</span>
								{:else}
									<span class="rounded-full px-2 py-0.5 text-xs font-bold tron-text-muted" style="background: rgba(128,128,128,0.15);">PENDING</span>
								{/if}
							</div>
							{#if result?.completedAt}
								<div class="tron-text-muted text-[10px] mt-1">{formatDate(result.completedAt)}</div>
									<div class="text-[10px] mt-0.5" style="color: {validationPhase(result.completedAt) === currentCycle ? 'var(--color-tron-cyan)' : 'var(--color-tron-text-secondary)'};">{phaseLabel(validationPhase(result.completedAt))}{#if validationPhase(result.completedAt) !== currentCycle} · not counted{/if}</div>
							{/if}
							{#if result?.sessionId}
								<a href="/validation/{test.key}/{result.sessionId}" class="text-[10px] underline mt-1 block" style="color: var(--color-tron-cyan);">View Session</a>
							{/if}
						</div>
						{#if result?.status === 'failed' && result?.failureReasons?.length > 0}
							<div class="mt-2 border-t pt-2 space-y-1" style="border-color: var(--color-tron-border);">
								{#each result.failureReasons as reason}
									<div class="text-[10px]" style="color: var(--color-tron-red);">✗ {reason}</div>
								{/each}
							</div>
						{/if}
						{#if result?.status === 'overridden'}
							<div class="mt-2 border-t pt-2" style="border-color: var(--color-tron-border);">
								<div class="text-[10px]" style="color: var(--color-tron-yellow, #fbbf24);">Override by {result.overriddenBy?.username ?? 'admin'}</div>
								{#if result.overrideReason}
									<div class="tron-text-muted text-[10px] italic mt-0.5">"{result.overrideReason}"</div>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</TronCard>

		<!-- Validation Session History -->
		{#if data.validationSessions?.length > 0}
			<TronCard>
				<h3 class="tron-text-primary mb-4 text-lg font-medium">Validation Session History</h3>
				<div class="space-y-4">
					{#each data.validationSessions as session (session.id)}
						{@const typeLabel = session.type === 'mag' ? 'Magnetometer' : session.type === 'thermo' ? 'Thermocouple' : session.type ?? 'Unknown'}
						{@const typeIcon = session.type === 'mag' ? '🧲' : session.type === 'thermo' ? '🌡️' : session.type === 'lux' ? '💡' : session.type === 'spec' ? '🔬' : '📋'}
						<details class="rounded-lg border" style="border-color: {session.overallPassed ? 'var(--color-tron-green)' : session.override ? 'var(--color-tron-yellow, #fbbf24)' : session.status === 'failed' ? 'var(--color-tron-red)' : 'var(--color-tron-border)'}; background: var(--color-tron-bg-secondary);">
							<summary class="flex items-center justify-between p-3 cursor-pointer">
								<div class="flex items-center gap-3">
									<span class="text-lg">{typeIcon}</span>
									<div>
										<span class="tron-text-primary text-sm font-bold">{typeLabel}</span>
										<span class="tron-text-muted text-xs ml-2">{formatDate(session.completedAt ?? session.startedAt)}</span>
										<span class="tron-text-muted text-xs ml-2">by {session.operatorName}</span>
									</div>
								</div>
								<div class="flex items-center gap-2">
									{#if session.override}
										<span class="rounded-full px-2 py-0.5 text-xs font-bold" style="color: var(--color-tron-yellow, #fbbf24); background: rgba(251,191,36,0.15);">OVERRIDDEN</span>
									{:else if session.overallPassed}
										<span class="rounded-full px-2 py-0.5 text-xs font-bold" style="color: var(--color-tron-green); background: rgba(0,255,100,0.15);">PASS</span>
									{:else if session.status === 'failed'}
										<span class="rounded-full px-2 py-0.5 text-xs font-bold" style="color: var(--color-tron-red); background: rgba(255,0,0,0.15);">FAIL</span>
									{:else}
										<span class="rounded-full px-2 py-0.5 text-xs font-bold tron-text-muted" style="background: rgba(128,128,128,0.15);">{session.status?.toUpperCase() ?? 'PENDING'}</span>
									{/if}
									<a href="/validation/{session.type === 'mag' ? 'magnetometer' : session.type === 'thermo' ? 'thermocouple' : session.type}/{session.id}" class="text-[10px] underline" style="color: var(--color-tron-cyan);" onclick={(e) => e.stopPropagation()}>View</a>
								</div>
							</summary>
							<div class="border-t p-3 space-y-3" style="border-color: var(--color-tron-border);">
								{#if session.override}
									<div class="rounded p-2" style="background: rgba(251,191,36,0.08); border: 1px solid rgba(251,191,36,0.3);">
										<div class="text-xs font-bold" style="color: var(--color-tron-yellow, #fbbf24);">Admin Override</div>
										<div class="tron-text-muted text-xs mt-1">By: {session.override.by?.username ?? 'admin'} · {formatDate(session.override.at)}</div>
										<div class="tron-text-muted text-xs italic mt-0.5">"{session.override.reason}"</div>
									</div>
								{/if}

								{#if session.failureReasons?.length > 0}
									<div class="space-y-1">
										<div class="text-xs font-bold" style="color: var(--color-tron-red);">Failure Reasons:</div>
										{#each session.failureReasons as reason}
											<div class="text-[10px]" style="color: var(--color-tron-red);">✗ {reason}</div>
										{/each}
									</div>
								{/if}

								{#if session.criteriaUsed}
									<div class="tron-text-muted text-xs">
										Criteria: {#if session.criteriaUsed.minZ}Z range {session.criteriaUsed.minZ} – {session.criteriaUsed.maxZ}{/if}{#if session.criteriaUsed.minTemp}Temp {session.criteriaUsed.minTemp}°C – {session.criteriaUsed.maxTemp}°C{/if}
									</div>
								{/if}

								{#if session.magResults?.length > 0}
									<div class="overflow-x-auto">
										<table class="tron-table text-xs">
											<thead>
												<tr>
													<th>Well</th>
													<th>Ch A (Z)</th>
													<th>Ch B (Z)</th>
													<th>Ch C (Z)</th>
												</tr>
											</thead>
											<tbody>
												{#each session.magResults as well}
													<tr>
														<td class="font-mono font-bold">{well.well}</td>
														{#each ['A', 'B', 'C'] as ch}
															{@const z = well[`ch${ch}_Z`]}
															{@const inRange = z !== null && z !== undefined && session.criteriaUsed && z >= session.criteriaUsed.minZ && z <= session.criteriaUsed.maxZ}
															<td class="font-mono" style="color: {z === null || z === undefined ? 'var(--color-tron-text-secondary)' : inRange ? 'var(--color-tron-green)' : 'var(--color-tron-red)'};">
																{z !== null && z !== undefined ? z : '—'}
																{#if z !== null && z !== undefined}
																	<span class="ml-1">{inRange ? '✓' : '✗'}</span>
																{/if}
															</td>
														{/each}
													</tr>
												{/each}
											</tbody>
										</table>
									</div>
								{/if}

								{#if session.rawData}
									<details>
										<summary class="tron-text-muted text-xs cursor-pointer hover:underline">Raw Device Output</summary>
										<pre class="mt-2 text-[10px] tron-text-muted overflow-x-auto p-2 rounded" style="background: var(--color-tron-bg); white-space: pre-wrap; word-break: break-all;">{session.rawData}</pre>
									</details>
								{/if}
							</div>
						</details>
					{/each}
				</div>
			</TronCard>
		{/if}
	{/if}

	<!-- ═══════════════ FULL DOCUMENT ═══════════════ -->
	{#if view === 'document'}
		<!-- Readable record summary -->
		<TronCard>
			<h3 class="tron-text-primary mb-4 text-lg font-medium">Record Summary</h3>
			<dl class="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
				<div class="flex justify-between gap-3"><dt class="tron-text-muted">UDI</dt><dd class="tron-text-primary font-mono break-all text-right">{data.spu.udi}</dd></div>
				<div class="flex justify-between gap-3"><dt class="tron-text-muted">Device ID</dt><dd class="tron-text-primary font-mono break-all text-right">{deviceId}</dd></div>
				<div class="flex justify-between gap-3"><dt class="tron-text-muted">Barcode</dt><dd class="tron-text-primary font-mono text-right">{data.spu.barcode ?? '—'}</dd></div>
				<div class="flex justify-between gap-3"><dt class="tron-text-muted">Status</dt><dd class="tron-text-primary text-right">{data.spu.status}</dd></div>
				<div class="flex justify-between gap-3"><dt class="tron-text-muted">Device State</dt><dd class="tron-text-primary text-right">{data.spu.deviceState || '—'}</dd></div>
				<div class="flex justify-between gap-3"><dt class="tron-text-muted">QC Status</dt><dd class="tron-text-primary text-right">{data.spu.qcStatus}</dd></div>
				<div class="flex justify-between gap-3"><dt class="tron-text-muted">Assembly Status</dt><dd class="tron-text-primary text-right">{data.spu.assemblyStatus}</dd></div>
				<div class="flex justify-between gap-3"><dt class="tron-text-muted">Validation</dt><dd class="tron-text-primary text-right">{validationPassedCount}/3 ({validationOverall})</dd></div>
				<div class="flex justify-between gap-3"><dt class="tron-text-muted">Batch</dt><dd class="tron-text-primary text-right">{data.batch?.batchNumber ?? '—'}</dd></div>
				<div class="flex justify-between gap-3"><dt class="tron-text-muted">Owner</dt><dd class="tron-text-primary text-right">{data.spu.owner ?? '—'}</dd></div>
				<div class="flex justify-between gap-3"><dt class="tron-text-muted">Created</dt><dd class="tron-text-primary text-right">{formatDate(data.spu.createdAt)}</dd></div>
				<div class="flex justify-between gap-3"><dt class="tron-text-muted">Updated</dt><dd class="tron-text-primary text-right">{formatDate(data.spu.updatedAt)}</dd></div>
				<div class="flex justify-between gap-3"><dt class="tron-text-muted">Created By</dt><dd class="tron-text-primary text-right">{data.createdByName ?? '—'}</dd></div>
				<div class="flex justify-between gap-3"><dt class="tron-text-muted">Finalized</dt><dd class="tron-text-primary text-right">{data.spu.finalizedAt ? formatDate(data.spu.finalizedAt) : 'No'}</dd></div>
			</dl>
		</TronCard>

		<!-- Service History -->
		{#if serviceRecords.length > 0}
			<TronCard>
				<h3 class="tron-text-primary mb-4 text-lg font-medium">Service History</h3>
				<div class="space-y-3">
					{#each [...serviceRecords].reverse() as rec (rec.id)}
						<div class="rounded-lg border p-3" style="border-color: {rec.status === 'open' ? 'var(--color-tron-orange)' : 'var(--color-tron-border)'};">
							<div class="flex items-center justify-between">
								<span class="tron-text-primary text-sm font-bold">Service #{rec.cycle}</span>
								<span class="rounded-full px-2 py-0.5 text-xs font-bold" style="color: {rec.status === 'open' ? 'var(--color-tron-orange)' : 'var(--color-tron-green)'}; background: rgba(128,128,128,0.12);">
									{rec.status === 'open' ? 'OUT FOR SERVICE' : 'RETURNED'}
								</span>
							</div>
							<dl class="mt-2 space-y-1 text-xs">
								<div><dt class="tron-text-muted inline">Issue:</dt> <dd class="tron-text-primary inline">{rec.issue}</dd></div>
								{#if rec.initialTestPlan}<div><dt class="tron-text-muted inline">Initial plan:</dt> <dd class="tron-text-primary inline">{rec.initialTestPlan}</dd></div>{/if}
								{#if rec.fix}<div><dt class="tron-text-muted inline">Fix:</dt> <dd class="tron-text-primary inline">{rec.fix}</dd></div>{/if}
								<div class="tron-text-muted">Opened {formatDate(rec.openedAt)}{#if rec.openedByName} by {rec.openedByName}{/if}{#if rec.returnedAt} · Returned {formatDate(rec.returnedAt)}{#if rec.returnedByName} by {rec.returnedByName}{/if}{/if}</div>
							</dl>
						</div>
					{/each}
				</div>
			</TronCard>
		{/if}

		<!-- Attachments — upload + view thermocouple CSVs per SPU -->
		<TronCard>
			<h3 class="tron-text-primary mb-4 text-lg font-medium">Attachments</h3>

			<!-- Upload form -->
			<form
				method="POST"
				action="?/uploadCsv"
				enctype="multipart/form-data"
				class="mb-4 flex flex-wrap items-center gap-3"
				use:enhance={() => {
					uploadingCsv = true;
					return async ({ update }) => {
						await update();
						uploadingCsv = false;
					};
				}}
			>
				<input type="file" name="file" accept=".csv,text/csv" required class="tron-text-secondary text-sm" />
				<TronButton type="submit" disabled={uploadingCsv}>
					{uploadingCsv ? 'Uploading…' : 'Upload CSV'}
				</TronButton>
				{#if form?.uploadSuccess}
					<span class="text-xs" style="color: var(--color-tron-green);">
						Uploaded {form.fileName} ({form.rowCount} rows)
					</span>
				{:else if form?.error}
					<span class="text-xs" style="color: var(--color-tron-red, #ef4444);">{form.error}</span>
				{/if}
			</form>

			{#if data.attachments.length > 0}
				<div class="overflow-x-auto">
					<table class="tron-table">
						<thead>
							<tr>
								<th>File</th>
								<th>Type</th>
								<th>Rows</th>
								<th>Size</th>
								<th>Uploaded</th>
								<th>By</th>
								<th>Actions</th>
							</tr>
						</thead>
						<tbody>
							{#each data.attachments as att (att.id)}
								<tr>
									<td class="font-mono">{att.fileName}</td>
									<td>{att.kind}</td>
									<td>{att.rowCount ?? '—'}</td>
									<td>{formatBytes(att.fileSize)}</td>
									<td>{formatDate(att.uploadedAt)}</td>
									<td>{att.uploadedByName ?? '—'}</td>
									<td>
										<div class="flex items-center gap-3">
											<button
												type="button"
												class="underline"
												style="color: var(--color-tron-cyan);"
												onclick={() => (expandedAttachment = expandedAttachment === att.id ? null : att.id)}
											>
												{expandedAttachment === att.id ? 'Hide' : 'View'}
											</button>
											<a
												href="/spu/{data.spu.id}/attachments/{att.id}"
												class="underline"
												style="color: var(--color-tron-cyan);"
												download={att.fileName}
											>
												Download
											</a>
											<form
												method="POST"
												action="?/deleteAttachment"
												use:enhance
												onsubmit={(e) => {
													if (!confirm('Delete this attachment?')) e.preventDefault();
												}}
											>
												<input type="hidden" name="attachmentId" value={att.id} />
												<button type="submit" class="underline" style="color: var(--color-tron-red, #ef4444);">
													Delete
												</button>
											</form>
										</div>
									</td>
								</tr>
								{#if expandedAttachment === att.id}
									<tr>
										<td colspan="7" style="background: rgba(0, 0, 0, 0.2);">
											{#if att.preview.header.length > 0}
												<div class="overflow-x-auto p-2">
													<table class="tron-table text-xs">
														<thead>
															<tr>
																{#each att.preview.header as col}
																	<th>{col}</th>
																{/each}
															</tr>
														</thead>
														<tbody>
															{#each att.preview.rows as row}
																<tr>
																	{#each row as cell}
																		<td class="font-mono">{cell}</td>
																	{/each}
																</tr>
															{/each}
														</tbody>
													</table>
													{#if att.preview.truncated}
														<p class="tron-text-muted mt-2 text-xs">
															Showing first 50 rows of {att.rowCount}. Download for the full file.
														</p>
													{/if}
												</div>
											{:else}
												<p class="tron-text-muted p-2 text-xs">No preview available — download to view.</p>
											{/if}
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<div class="py-6 text-center">
					<p class="tron-text-muted">No attachments yet.</p>
					<p class="mt-1 text-xs" style="color: var(--color-tron-cyan); opacity: 0.7;">
						Use the upload control above to attach a thermocouple CSV.
					</p>
				</div>
			{/if}
		</TronCard>

		<TronCard>
			<h3 class="tron-text-primary mb-4 text-lg font-medium">Parts Traceability</h3>
			{#if data.parts.length > 0}
				<div class="overflow-x-auto">
					<table class="tron-table">
						<thead>
							<tr>
								<th>Part #</th>
								<th>Name</th>
								<th>Lot #</th>
								<th>Qty</th>
								<th>Lot Expiration</th>
								<th>Recorded At</th>
								<th>Recorded By</th>
							</tr>
						</thead>
						<tbody>
							{#each data.parts as part (part.id)}
								<tr>
									<td><a href="/spu/parts/{part.partId}" class="font-mono underline" style="color: var(--color-tron-cyan);">{part.partNumber}</a></td>
									<td>{part.partName}</td>
									<td class="font-mono">{part.lotNumber ?? '—'}</td>
									<td>{part.quantityUsed}</td>
									<td><span class="tron-text-muted">N/A</span></td>
									<td>{formatDate(part.recordedAt)}</td>
									<td>{part.recordedByName}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<div class="py-6 text-center">
					<p class="tron-text-muted">No parts recorded yet.</p>
					<p class="mt-1 text-xs" style="color: var(--color-tron-cyan); opacity: 0.7;">Parts are recorded during the assembly process</p>
				</div>
			{/if}
		</TronCard>

		{#if data.sessions.length > 0}
			<TronCard>
				<h3 class="tron-text-primary mb-4 text-lg font-medium">Assembly Sessions</h3>
				<div class="overflow-x-auto">
					<table class="tron-table">
						<thead>
							<tr>
								<th>Started</th>
								<th>Completed</th>
								<th>Status</th>
								<th>Operator</th>
							</tr>
						</thead>
						<tbody>
							{#each data.sessions as session (session.id)}
								<tr>
									<td>{formatDate(session.startedAt)}</td>
									<td>{formatDate(session.completedAt)}</td>
									<td>
										{#if session.status === 'completed'}
											<TronBadge variant="success">Completed</TronBadge>
										{:else if session.status === 'in_progress'}
											<TronBadge variant="warning">In Progress</TronBadge>
										{:else}
											<TronBadge variant="neutral">{session.status}</TronBadge>
										{/if}
									</td>
									<td>{session.operatorName}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</TronCard>
		{/if}

		{#if data.signatures.length > 0}
			<TronCard>
				<h3 class="tron-text-primary mb-4 text-lg font-medium">Electronic Signatures</h3>
				<div class="overflow-x-auto">
					<table class="tron-table">
						<thead>
							<tr>
								<th>Type</th>
								<th>Meaning</th>
								<th>Signed By</th>
								<th>Signed At</th>
							</tr>
						</thead>
						<tbody>
							{#each data.signatures as sig (sig.id)}
								<tr>
									<td>{sig.entityType}</td>
									<td class="italic">"{sig.meaning}"</td>
									<td>{sig.userName}</td>
									<td>{formatDate(sig.signedAt)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</TronCard>
		{/if}

		<!-- Record History (Audit Trail) -->
		<TronCard>
			<button type="button" class="flex w-full items-center justify-between" onclick={() => (showRecordHistory = !showRecordHistory)}>
				<h3 class="tron-text-primary text-lg font-medium">
					Record History
					{#if data.auditTrail.length > 0}
						<span class="ml-2 inline-block rounded-full px-2 py-0.5 text-xs font-normal" style="background: var(--color-tron-cyan); color: var(--color-tron-bg);">{data.auditTrail.length}</span>
					{/if}
				</h3>
				<svg class="h-5 w-5 transition-transform {showRecordHistory ? 'rotate-180' : ''}" fill="currentColor" viewBox="0 0 20 20" style="color: var(--color-tron-cyan);">
					<path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
				</svg>
			</button>
			{#if showRecordHistory}
				<div class="mt-4 space-y-0">
					{#if data.auditTrail.length === 0}
						<p class="tron-text-muted py-4 text-center text-sm">No history recorded yet.</p>
					{:else}
						{#each data.auditTrail as entry, i (entry.id)}
							<div class="flex items-start gap-3 border-l-2 py-3 pl-4" style="border-color: var(--color-tron-cyan); background: {i % 2 === 0 ? 'transparent' : 'color-mix(in srgb, var(--color-tron-surface) 30%, transparent)'};">
								<div class="-ml-[21px] mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full" style="background: var(--color-tron-bg); border: 2px solid var(--color-tron-cyan);">
									{#if entry.action === 'INSERT'}
										<span class="text-[8px]" style="color: var(--color-tron-cyan);">+</span>
									{:else if entry.action === 'DELETE'}
										<span class="text-[8px]" style="color: var(--color-tron-error);">−</span>
									{:else}
										<span class="text-[8px]" style="color: var(--color-tron-cyan);">✎</span>
									{/if}
								</div>
								<div class="min-w-0 flex-1">
									<div class="flex flex-wrap items-center gap-2">
										<TronBadge variant={entry.action === 'INSERT' ? 'success' : entry.action === 'DELETE' ? 'error' : 'info'}>{entry.action}</TronBadge>
										<span class="tron-text-primary text-sm font-medium">{entry.changedBy}</span>
									</div>
									<p class="tron-text-muted mt-1 text-xs">{describeAuditEntry(entry)}</p>
									<p class="mt-1 text-xs" style="color: var(--color-tron-cyan); opacity: 0.6;">{formatDate(entry.changedAt)}</p>
								</div>
							</div>
						{/each}
					{/if}
				</div>
			{/if}
		</TronCard>
	{/if}
</div>

<!-- Servicing quick window -->
{#if showServicing}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
		<div class="w-full max-w-lg">
			<TronCard>
				<div class="mb-4 flex items-center justify-between">
					<div>
						<h3 class="tron-text-primary text-xl font-bold">🔧 Servicing</h3>
						<p class="tron-text-muted font-mono text-sm">{data.spu.udi}</p>
					</div>
					<button type="button" class="tron-text-muted hover:tron-text-primary" onclick={() => (showServicing = false)} aria-label="Close">
						<svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
					</button>
				</div>

				{#if !openService}
					<!-- Phase A: send to service -->
					<form
						method="POST"
						action="?/openService"
						use:enhance={() => { submittingService = true; return async ({ update }) => { submittingService = false; await update(); }; }}
						class="space-y-4"
					>
						<p class="tron-text-muted text-sm">
							Send this unit for service. It will move to <span style="color: var(--color-tron-orange);">servicing</span>.
						</p>
						<div>
							<label for="svc-issue" class="tron-label">Issue</label>
							<textarea id="svc-issue" name="issue" rows="3" class="tron-input w-full" placeholder="What is wrong with the device?" required disabled={submittingService}></textarea>
						</div>
						<div>
							<label for="svc-plan" class="tron-label">Initial plan to test</label>
							<textarea id="svc-plan" name="initialTestPlan" rows="3" class="tron-input w-full" placeholder="How will it be diagnosed / tested?" disabled={submittingService}></textarea>
						</div>
						{#if form?.error}
							<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3"><p class="text-sm text-[var(--color-tron-red)]">{form.error}</p></div>
						{/if}
						<div class="flex gap-3 pt-1">
							<TronButton type="button" class="flex-1" onclick={() => (showServicing = false)} disabled={submittingService}>Cancel</TronButton>
							<TronButton type="submit" variant="primary" class="flex-1" disabled={submittingService}>{submittingService ? 'Saving...' : 'Send to Servicing'}</TronButton>
						</div>
					</form>
				{:else}
					<!-- Phase B: device returned -->
					<div class="mb-4 rounded-lg border p-3" style="border-color: var(--color-tron-orange); background: rgba(249,115,22,0.06);">
						<div class="tron-text-primary text-sm font-bold">Service #{openService.cycle} — out for service</div>
						<dl class="mt-1 space-y-1 text-xs">
							<div><dt class="tron-text-muted inline">Issue:</dt> <dd class="tron-text-primary inline">{openService.issue}</dd></div>
							{#if openService.initialTestPlan}<div><dt class="tron-text-muted inline">Initial plan:</dt> <dd class="tron-text-primary inline">{openService.initialTestPlan}</dd></div>{/if}
							<div class="tron-text-muted">Opened {formatDate(openService.openedAt)}{#if openService.openedByName} by {openService.openedByName}{/if}</div>
						</dl>
					</div>
					<form
						method="POST"
						action="?/returnService"
						use:enhance={() => { submittingService = true; return async ({ update }) => { submittingService = false; await update(); }; }}
						class="space-y-4"
					>
						<div>
							<label for="svc-fix" class="tron-label">What was the fix?</label>
							<textarea id="svc-fix" name="fix" rows="3" class="tron-input w-full" placeholder="Describe the repair / change made..." required disabled={submittingService}></textarea>
						</div>
						<p class="text-xs" style="color: var(--color-tron-orange);">
							On return, the unit goes to <strong>validating</strong> and the validation counter resets to 0/3. Prior validation records are kept and tagged with their service cycle.
						</p>
						{#if form?.error}
							<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3"><p class="text-sm text-[var(--color-tron-red)]">{form.error}</p></div>
						{/if}
						<div class="flex gap-3 pt-1">
							<TronButton type="button" class="flex-1" onclick={() => (showServicing = false)} disabled={submittingService}>Cancel</TronButton>
							<TronButton type="submit" variant="primary" class="flex-1" disabled={submittingService}>{submittingService ? 'Saving...' : 'Mark Returned & Require Re-validation'}</TronButton>
						</div>
					</form>
				{/if}
			</TronCard>
		</div>
	</div>
{/if}
