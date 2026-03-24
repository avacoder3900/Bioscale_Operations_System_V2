<script lang="ts">
	import { enhance } from '$app/forms';

	let { data } = $props();

	let showDeleteModal = $state(false);
	let deleteReason = $state('');
	let editing = $state(false);

	const c = $derived(data.cartridge);

	function getStatusColor(status: string) {
		const colors: Record<string, string> = {
			available: 'var(--color-tron-green, #39ff14)',
			in_use: 'var(--color-tron-cyan, #00ffff)',
			depleted: '#6b7280',
			expired: '#ef4444',
			quarantine: '#f97316',
			disposed: '#6b7280'
		};
		return colors[status] ?? '#6b7280';
	}

	function getExpiryColor(date: Date | string | null) {
		if (!date) return '#6b7280';
		const d = new Date(date);
		const now = new Date();
		const daysUntil = Math.ceil((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
		if (daysUntil < 0) return '#ef4444';
		if (daysUntil < 30) return '#ef4444';
		if (daysUntil < 90) return '#fbbf24';
		return 'var(--color-tron-green, #39ff14)';
	}

	function getExpiryLabel(date: Date | string | null) {
		if (!date) return '';
		const d = new Date(date);
		const now = new Date();
		const daysUntil = Math.ceil((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
		if (daysUntil < 0) return `Expired ${Math.abs(daysUntil)}d ago`;
		if (daysUntil === 0) return 'Expires today';
		return `${daysUntil}d remaining`;
	}

	let expandedEvent = $state<string | null>(null);

	function getFirmwareStatusColor(status: string | null) {
		const colors: Record<string, string> = {
			unused: 'var(--color-tron-cyan, #00ffff)',
			validated: 'var(--color-tron-green, #39ff14)',
			used: '#6b7280',
			expired: '#ef4444',
			invalid: '#ef4444',
			cancelled: '#6b7280'
		};
		return colors[status ?? ''] ?? '#6b7280';
	}

	function getEventColor(eventType: string) {
		const colors: Record<string, string> = {
			validate: 'var(--color-tron-cyan, #00ffff)',
			load_assay: '#3b82f6',
			upload: 'var(--color-tron-green, #39ff14)',
			reset: '#f97316',
			error: '#ef4444'
		};
		return colors[eventType] ?? '#6b7280';
	}
</script>

<div class="mx-auto max-w-5xl space-y-6 p-4">
	<div class="flex items-center justify-between">
		<div>
			<a
				href="/cartridges"
				class="text-sm"
				style="color: var(--color-tron-text-secondary, #9ca3af)"
			>
				&larr; Back to Cartridges
			</a>
			<h1 class="mt-1 font-mono text-2xl font-bold" style="color: var(--color-tron-cyan, #00ffff)">
				{c.barcode}
			</h1>
		</div>
		<div class="flex gap-2">
			{#if data.canWrite}
				<button class="tron-button" style="min-height: 44px" onclick={() => (editing = !editing)}>
					{editing ? 'Cancel Edit' : 'Edit'}
				</button>
			{/if}
			<a
				href="/cartridges/export?format=usage_log&cartridgeId={c.id}"
				class="tron-button"
				style="min-height: 44px; background: var(--color-tron-green, #39ff14); color: #000"
			>
				Export Log
			</a>
			{#if data.canDelete}
				<button
					class="tron-button"
					style="min-height: 44px; background: #ef4444; color: #fff"
					onclick={() => (showDeleteModal = true)}
				>
					Delete
				</button>
			{/if}
		</div>
	</div>

	<div class="grid gap-6 md:grid-cols-2">
		<!-- Info Card -->
		<div class="tron-card space-y-4 p-6">
			<h2 class="text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">Details</h2>

			{#if editing}
				<form method="POST" action="?/update" use:enhance class="space-y-3">
					<div>
						<span class="text-xs" style="color: var(--color-tron-text-secondary)">Lot Number</span>
						<input
							name="lotNumber"
							class="tron-input w-full"
							style="min-height: 44px"
							value={c.lotNumber}
						/>
					</div>
					<div>
						<span class="text-xs" style="color: var(--color-tron-text-secondary)"
							>Serial Number</span
						>
						<input
							name="serialNumber"
							class="tron-input w-full"
							style="min-height: 44px"
							value={c.serialNumber ?? ''}
						/>
					</div>
					<div>
						<span class="text-xs" style="color: var(--color-tron-text-secondary)">Manufacturer</span
						>
						<input
							name="manufacturer"
							class="tron-input w-full"
							style="min-height: 44px"
							value={c.manufacturer ?? ''}
						/>
					</div>
					<div>
						<span class="text-xs" style="color: var(--color-tron-text-secondary)"
							>Storage Location</span
						>
						<input
							name="storageLocation"
							class="tron-input w-full"
							style="min-height: 44px"
							value={c.storageLocation ?? ''}
						/>
					</div>
					<div>
						<span class="text-xs" style="color: var(--color-tron-text-secondary)"
							>Storage Conditions</span
						>
						<input
							name="storageConditions"
							class="tron-input w-full"
							style="min-height: 44px"
							value={c.storageConditions ?? ''}
						/>
					</div>
					<div>
						<span class="text-xs" style="color: var(--color-tron-text-secondary)"
							>Uses Remaining</span
						>
						<input
							name="usesRemaining"
							type="number"
							class="tron-input w-full"
							style="min-height: 44px"
							value={c.usesRemaining ?? ''}
						/>
					</div>
					<div>
						<span class="text-xs" style="color: var(--color-tron-text-secondary)">Notes</span>
						<textarea name="notes" class="tron-input w-full" style="min-height: 66px"
							>{c.notes ?? ''}</textarea
						>
					</div>
					<button
						type="submit"
						class="tron-button"
						style="min-height: 44px; background: var(--color-tron-cyan, #00ffff); color: #000"
					>
						Save Changes
					</button>
				</form>
			{:else}
				<div class="space-y-2 text-sm">
					<div class="flex justify-between">
						<span style="color: var(--color-tron-text-secondary)">Serial Number</span>
						<span>{c.serialNumber ?? '—'}</span>
					</div>
					<div class="flex justify-between">
						<span style="color: var(--color-tron-text-secondary)">Lot Number</span>
						<span>{c.lotNumber}</span>
					</div>
					<div class="flex justify-between">
						<span style="color: var(--color-tron-text-secondary)">Type</span>
						<span class="capitalize">{c.cartridgeType}</span>
					</div>
					<div class="flex justify-between">
						<span style="color: var(--color-tron-text-secondary)">Status</span>
						<span
							class="inline-block rounded px-2 py-0.5 text-xs font-semibold"
							style="color: {getStatusColor(c.status)}; border: 1px solid {getStatusColor(
								c.status
							)}"
						>
							{c.status}
						</span>
					</div>
					<div class="flex justify-between">
						<span style="color: var(--color-tron-text-secondary)">Group</span>
						{#if c.group}
							<span
								class="inline-block rounded px-2 py-0.5 text-xs"
								style="color: {c.group.color ?? '#6b7280'}; border: 1px solid {c.group.color ??
									'#6b7280'}"
							>
								{c.group.name}
							</span>
						{:else}
							<span style="color: var(--color-tron-text-secondary)">—</span>
						{/if}
					</div>
					<div class="flex justify-between">
						<span style="color: var(--color-tron-text-secondary)">Manufacturer</span>
						<span>{c.manufacturer ?? '—'}</span>
					</div>
					<div class="flex justify-between">
						<span style="color: var(--color-tron-text-secondary)">Storage</span>
						<span
							>{c.storageLocation ?? '—'}
							{c.storageConditions ? `(${c.storageConditions})` : ''}</span
						>
					</div>
					<div class="flex justify-between">
						<span style="color: var(--color-tron-text-secondary)">Uses</span>
						<span>{c.usesRemaining ?? '—'}{c.totalUses ? `/${c.totalUses}` : ''}</span>
					</div>
				</div>
			{/if}
		</div>

		<!-- Expiry + Actions -->
		<div class="space-y-4">
			{#if c.expirationDate}
				<div class="tron-card p-6">
					<h2 class="mb-2 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
						Expiration
					</h2>
					<div class="text-2xl font-bold" style="color: {getExpiryColor(c.expirationDate)}">
						{new Date(c.expirationDate).toLocaleDateString()}
					</div>
					<div class="mt-1 text-sm" style="color: {getExpiryColor(c.expirationDate)}">
						{getExpiryLabel(c.expirationDate)}
					</div>
				</div>
			{/if}

			{#if data.canWrite}
				<!-- Status Change -->
				<div class="tron-card p-6">
					<h2 class="mb-3 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
						Change Status
					</h2>
					<form method="POST" action="?/changeStatus" use:enhance class="flex gap-2">
						<select name="status" class="tron-input flex-1" style="min-height: 44px">
							{#each ['available', 'in_use', 'depleted', 'expired', 'quarantine', 'disposed'] as s}
								<option value={s} selected={s === c.status}>{s}</option>
							{/each}
						</select>
						<button type="submit" class="tron-button" style="min-height: 44px">Update</button>
					</form>
				</div>

				<!-- Group Change -->
				<div class="tron-card p-6">
					<h2 class="mb-3 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
						Change Group
					</h2>
					<form method="POST" action="?/changeGroup" use:enhance class="flex gap-2">
						<select name="groupId" class="tron-input flex-1" style="min-height: 44px">
							<option value="">No Group</option>
							{#each data.groups as g (g.id)}
								<option value={g.id} selected={g.id === c.groupId}>{g.name}</option>
							{/each}
						</select>
						<button type="submit" class="tron-button" style="min-height: 44px">Update</button>
					</form>
				</div>
			{/if}

			<!-- Firmware Status (ASSAY-007) -->
			<div class="tron-card p-6">
				<h2 class="mb-3 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
					Firmware Status
				</h2>
				{#if data.firmwareStatus.exists}
					<div class="space-y-2 text-sm">
						<div class="flex justify-between">
							<span style="color: var(--color-tron-text-secondary)">Device Status</span>
							<span
								class="rounded px-2 py-0.5 text-xs font-semibold"
								style="color: {getFirmwareStatusColor(
									data.firmwareStatus.status
								)}; border: 1px solid {getFirmwareStatusColor(data.firmwareStatus.status)}"
							>
								{data.firmwareStatus.status}
							</span>
						</div>
						<div class="flex justify-between">
							<span style="color: var(--color-tron-text-secondary)">Assigned Assay</span>
							{#if data.firmwareStatus.assayId}
								<a
									href="/assays/{data.firmwareStatus.assayId}"
									style="color: var(--color-tron-cyan, #00ffff)"
								>
									{data.firmwareStatus.assayName ?? data.firmwareStatus.assayId}
								</a>
							{:else}
								<span style="color: var(--color-tron-text-secondary)">None</span>
							{/if}
						</div>
						<div class="flex justify-between">
							<span style="color: var(--color-tron-text-secondary)">Validations</span>
							<span>{data.firmwareStatus.validationCount}</span>
						</div>
						{#if data.firmwareStatus.lastValidatedAt}
							<div class="flex justify-between">
								<span style="color: var(--color-tron-text-secondary)">Last Validated</span>
								<span class="text-xs"
									>{new Date(data.firmwareStatus.lastValidatedAt).toLocaleString()}</span
								>
							</div>
						{/if}
						{#if data.firmwareStatus.testResultId}
							<div class="flex justify-between">
								<span style="color: var(--color-tron-text-secondary)">Test Result</span>
								<a
									href="/test-results/{data.firmwareStatus.testResultId}"
									style="color: var(--color-tron-cyan, #00ffff)"
								>
									#{data.firmwareStatus.testResultId}
								</a>
							</div>
						{/if}
					</div>
				{:else}
					<p class="text-sm" style="color: var(--color-tron-text-secondary)">
						No firmware record. Assign an assay to create one.
					</p>
				{/if}
			</div>

			<!-- Assign Assay -->
			{#if data.canAssignAssay}
				<div class="tron-card p-6">
					<h2 class="mb-3 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
						Assign Assay
					</h2>
					<form method="POST" action="?/assignAssay" use:enhance class="flex gap-2">
						<select name="assayId" class="tron-input flex-1" style="min-height: 44px" required>
							<option value="">Select Assay...</option>
							{#each data.activeAssays as a (a.assayId)}
								<option value={a.assayId} selected={a.assayId === data.firmwareStatus.assayId}>
									{a.name} ({a.assayId})
								</option>
							{/each}
						</select>
						<button type="submit" class="tron-button" style="min-height: 44px">Assign</button>
					</form>
				</div>
			{/if}
		</div>
	</div>

	<!-- Device Events (ASSAY-007) -->
	{#if data.firmwareEvents.length > 0}
		<div class="tron-card p-6">
			<h2 class="mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
				Device Events ({data.firmwareEvents.length})
			</h2>
			<div class="max-h-72 space-y-2 overflow-y-auto">
				{#each data.firmwareEvents as event (event.id)}
					<button
						type="button"
						class="w-full rounded border border-[var(--color-tron-border)] p-2 text-left transition-colors hover:border-[var(--color-tron-cyan)]"
						style="min-height: 36px; background: var(--color-tron-bg-secondary)"
						onclick={() => (expandedEvent = expandedEvent === event.id ? null : event.id)}
					>
						<div class="flex items-center gap-2 text-xs">
							<span
								class="inline-block min-w-[80px] rounded px-1.5 py-0.5 text-center font-semibold"
								style="color: {getEventColor(event.eventType)}; background: {getEventColor(
									event.eventType
								)}15"
							>
								{event.eventType}
							</span>
							{#if event.success === true}
								<span style="color: var(--color-tron-green, #39ff14)">OK</span>
							{:else if event.success === false}
								<span style="color: #ef4444">FAIL</span>
							{/if}
							{#if event.errorMessage}
								<span style="color: #ef4444">{event.errorMessage}</span>
							{/if}
							<span class="ml-auto" style="color: var(--color-tron-text-secondary)">
								{new Date(event.createdAt).toLocaleString()}
							</span>
						</div>
						{#if expandedEvent === event.id && event.eventData}
							<pre
								class="mt-2 overflow-x-auto rounded p-2 font-mono text-xs"
								style="background: var(--color-tron-bg-tertiary, #1e1e2e); color: var(--color-tron-text-secondary)">{JSON.stringify(
									event.eventData,
									null,
									2
								)}</pre>
						{/if}
					</button>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Usage Log -->
	<div class="tron-card p-6">
		<h2 class="mb-4 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
			Usage Log ({data.usageLog.length} entries)
		</h2>
		{#if data.usageLog.length === 0}
			<p style="color: var(--color-tron-text-secondary)">No usage history.</p>
		{:else}
			<div class="max-h-96 overflow-y-auto">
				<table class="tron-table w-full">
					<thead>
						<tr>
							<th>Timestamp</th>
							<th>User</th>
							<th>Action</th>
							<th>Change</th>
							<th>Notes</th>
						</tr>
					</thead>
					<tbody>
						{#each data.usageLog as log (log.id)}
							<tr>
								<td class="text-xs">
									{new Date(log.performedAt).toLocaleString()}
								</td>
								<td>{log.username}</td>
								<td>
									<span class="rounded bg-white/10 px-1.5 py-0.5 text-xs">{log.action}</span>
								</td>
								<td class="text-xs">
									{#if log.previousValue || log.newValue}
										{log.previousValue ?? ''} &rarr; {log.newValue ?? ''}
									{:else}
										—
									{/if}
								</td>
								<td class="text-xs">{log.notes ?? ''}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>

<!-- Delete Modal -->
{#if showDeleteModal}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
		role="dialog"
		onclick={() => (showDeleteModal = false)}
		onkeydown={(e) => e.key === 'Escape' && (showDeleteModal = false)}
	>
		<div class="tron-card w-full max-w-md p-6" onclick={(e) => e.stopPropagation()} role="document">
			<h2 class="mb-4 text-lg font-bold" style="color: #ef4444">Delete Cartridge</h2>
			<p class="mb-4 text-sm" style="color: var(--color-tron-text-secondary)">
				This will deactivate <strong style="color: var(--color-tron-cyan)">{c.barcode}</strong>. A
				reason is required for compliance.
			</p>
			<form method="POST" action="?/delete" use:enhance>
				<textarea
					name="reason"
					class="tron-input mb-4 w-full"
					style="min-height: 88px"
					placeholder="Reason for deletion (required)..."
					bind:value={deleteReason}
					required
				></textarea>
				<div class="flex justify-end gap-2">
					<button
						type="button"
						class="tron-button"
						style="min-height: 44px"
						onclick={() => (showDeleteModal = false)}
					>
						Cancel
					</button>
					<button
						type="submit"
						class="tron-button"
						style="min-height: 44px; background: #ef4444; color: #fff"
						disabled={!deleteReason.trim()}
					>
						Confirm Delete
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
