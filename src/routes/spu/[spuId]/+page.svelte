<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard, TronBadge, TronButton } from '$lib/components/ui';
	import SpuStatusBadge from '$lib/components/spu/SpuStatusBadge.svelte';

	let { data, form } = $props();

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

	// Assignment removed — release status (released-rnd/manufacturing/field) replaces it

	let showRecordHistory = $state(false);
	let transitionReason = $state('');

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
		// If there's a reason field, use it directly (e.g. validation results)
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
		}
	});
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h2 class="tron-text-primary font-mono text-2xl font-bold">{data.spu.udi}</h2>
			<p class="tron-text-muted">Device History Record</p>
		</div>
		<div class="flex gap-2">
			<SpuStatusBadge status={data.spu.status} />
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

	<div class="grid grid-cols-1 gap-6 md:grid-cols-2">
		<!-- Device Information -->
		<TronCard>
			<h3 class="tron-text-primary mb-4 text-lg font-medium">Device Information</h3>
			<dl class="space-y-3">
				<div class="flex justify-between">
					<dt class="tron-text-muted">Device ID</dt>
					<dd class="tron-text-primary font-mono text-sm break-all">{data.particleLink?.particleDeviceId ?? data.spu.id}</dd>
				</div>
				<div class="flex justify-between items-start">
					<dt class="tron-text-muted">UDI</dt>
					<dd class="tron-text-primary font-mono">{data.spu.udi}</dd>
				</div>
				<div class="flex justify-between items-start">
					<dt class="tron-text-muted">Barcode</dt>
					<dd class="tron-text-primary font-mono">{data.spu.barcode ?? '—'}</dd>
				</div>
				<div>
					{#if !editingIdentifiers}
						<TronButton variant="ghost" onclick={() => { editingIdentifiers = true; editUdi = data.spu.udi; editBarcode = data.spu.barcode ?? ''; }} style="font-size: 0.75rem; padding: 4px 8px;">
							✏️ Edit UDI / Barcode
						</TronButton>
					{:else}
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
							class="space-y-3 mt-2 rounded border border-[var(--color-tron-cyan)] bg-[rgba(0,255,255,0.03)] p-3"
						>
							<div>
								<label for="edit-udi" class="tron-label text-xs">UDI</label>
								<input id="edit-udi" name="udi" type="text" class="tron-input text-sm" bind:value={editUdi} required style="min-height: 38px;" />
							</div>
							<div>
								<label for="edit-barcode" class="tron-label text-xs">Barcode</label>
								<input id="edit-barcode" name="barcode" type="text" class="tron-input text-sm" bind:value={editBarcode} placeholder="Scan or enter barcode" style="min-height: 38px;" />
							</div>
							<div class="flex gap-2">
								<TronButton variant="primary" type="submit" disabled={savingIdentifiers} style="font-size: 0.75rem; padding: 4px 12px;">
									{savingIdentifiers ? 'Saving...' : 'Save'}
								</TronButton>
								<TronButton variant="ghost" onclick={() => { editingIdentifiers = false; }} style="font-size: 0.75rem; padding: 4px 12px;">
									Cancel
								</TronButton>
							</div>
						</form>
					{/if}
				</div>
				<div class="flex justify-between">
					<dt class="tron-text-muted">Batch</dt>
					<dd>
						{#if data.batch}
							<a href="/spu/batches/{data.batch.id}" class="font-mono underline" style="color: var(--color-tron-cyan);">{data.batch.batchNumber}</a>
						{:else}
							<span class="text-sm" style="color: var(--color-tron-orange);">Not associated with a production batch</span>
						{/if}
					</dd>
				</div>
				<div class="flex justify-between">
					<dt class="tron-text-muted">Created</dt>
					<dd class="tron-text-primary">{formatDate(data.spu.createdAt)}</dd>
				</div>
				<div class="flex justify-between">
					<dt class="tron-text-muted">Created By</dt>
					<dd class="tron-text-primary">{data.createdByName ?? '—'}</dd>
				</div>

				<!-- Assignment removed — release status replaces it -->

				{#if data.spu.owner}
					<div class="flex justify-between">
						<dt class="tron-text-muted">Owner</dt>
						<dd class="tron-text-primary">{data.spu.owner}</dd>
					</div>
				{/if}
				{#if data.spu.ownerNotes}
					<div class="flex justify-between">
						<dt class="tron-text-muted">Owner Notes</dt>
						<dd class="tron-text-primary">{data.spu.ownerNotes}</dd>
					</div>
				{/if}
			</dl>
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

	<!-- Validation Tests -->
	<TronCard>
		<h3 class="tron-text-primary mb-4 text-lg font-medium">Validation Tests</h3>
		<div class="grid grid-cols-2 gap-3 md:grid-cols-4">
			{#each [
				{ name: 'Magnetometer', key: 'magnetometer', icon: '🧲' },
				{ name: 'Thermocouple', key: 'thermocouple', icon: '🌡️' },
				{ name: 'Lux', key: 'lux', icon: '💡' },
				{ name: 'Spectrophotometer', key: 'spectrophotometer', icon: '🔬' }
			] as test (test.key)}
				{@const result = data.spu.validation?.[test.key]}
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
</div>
