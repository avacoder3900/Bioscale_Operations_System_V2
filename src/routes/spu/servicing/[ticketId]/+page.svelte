<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let activeSection = $state<'parts' | 'firmware' | 'other' | 'notes'>('parts');

	const statusColors: Record<string, string> = {
		open: 'var(--color-tron-cyan)',
		in_progress: 'var(--color-tron-blue)',
		pending_parts: 'var(--color-tron-orange)',
		resolved: 'var(--color-tron-green)',
		closed: 'var(--color-tron-text-secondary)'
	};

	const categories = ['calibration', 'cleaning', 'repair', 'configuration', 'inspection', 'other'];
</script>

<svelte:head>
	<title>Service Ticket — {data.ticket.spuUdi}</title>
</svelte:head>

<div class="space-y-6 p-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<div class="flex items-center gap-3">
				<h1 class="text-2xl font-bold text-[var(--color-tron-text)]">Service Ticket</h1>
				<span
					class="inline-block rounded px-2 py-0.5 text-xs font-medium"
					style="color: {statusColors[data.ticket.status] ?? 'var(--color-tron-text)'}; border: 1px solid {statusColors[data.ticket.status] ?? 'var(--color-tron-border)'};"
				>
					{data.ticket.status.replace('_', ' ')}
				</span>
			</div>
			<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
				SPU: <a href="/spu/{data.ticket.spuId}" class="font-mono text-[var(--color-tron-cyan)] hover:underline">{data.ticket.spuUdi}</a>
				&middot; Opened by {data.ticket.openedBy} on {new Date(data.ticket.openedAt).toLocaleDateString()}
			</p>
		</div>
		<div class="flex items-center gap-2">
			<a href="/spu/servicing" class="tron-btn tron-btn-ghost text-sm">Back</a>
			{#if data.ticket.status !== 'resolved' && data.ticket.status !== 'closed'}
				<a href="/spu/servicing/{data.ticket.id}/resolve" class="tron-btn tron-btn-primary text-sm">
					Resolve Ticket
				</a>
			{/if}
		</div>
	</div>

	<!-- Ticket Status + Reason -->
	{#if data.ticket.status !== 'resolved' && data.ticket.status !== 'closed'}
		<div class="flex gap-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<form method="POST" action="?/updateStatus" use:enhance class="flex items-center gap-2">
				<label for="ticket-status" class="text-sm text-[var(--color-tron-text-secondary)]">Status:</label>
				<select id="ticket-status" name="status" class="tron-select text-sm" value={data.ticket.status}>
					<option value="open">Open</option>
					<option value="in_progress">In Progress</option>
					<option value="pending_parts">Pending Parts</option>
				</select>
				<button type="submit" class="tron-btn tron-btn-ghost text-xs">Update</button>
			</form>
			<form method="POST" action="?/updateReason" use:enhance class="flex flex-1 items-center gap-2">
				<label for="ticket-reason" class="text-sm text-[var(--color-tron-text-secondary)]">Reason:</label>
				<input id="ticket-reason" name="reason" type="text" class="tron-input flex-1 text-sm" value={data.ticket.reason} placeholder="Why is this SPU being serviced?" />
				<button type="submit" class="tron-btn tron-btn-ghost text-xs">Save</button>
			</form>
		</div>
	{/if}

	{#if form?.error}
		<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
	{/if}

	<!-- Section Tabs -->
	<div class="flex gap-1 border-b border-[var(--color-tron-border)]">
		{#each [
			{ key: 'parts', label: 'Parts Replaced', count: data.ticket.partsReplaced.length },
			{ key: 'firmware', label: 'Firmware Changes', count: data.ticket.firmwareChanges.length },
			{ key: 'other', label: 'Other Changes', count: data.ticket.otherChanges.length },
			{ key: 'notes', label: 'Notes', count: data.ticket.notes.length }
		] as tab}
			<button
				class="px-4 py-2 text-sm transition-colors {activeSection === tab.key ? 'border-b-2 border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]' : 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]'}"
				onclick={() => activeSection = tab.key as typeof activeSection}
			>
				{tab.label} ({tab.count})
			</button>
		{/each}
	</div>

	<!-- Parts Replaced Section -->
	{#if activeSection === 'parts'}
		<div class="space-y-4">
			{#if data.ticket.partsReplaced.length > 0}
				<div class="overflow-x-auto">
					<table class="tron-table w-full">
						<thead>
							<tr>
								<th class="tron-th">Part</th>
								<th class="tron-th">Old Lot</th>
								<th class="tron-th">New Lot</th>
								<th class="tron-th">Reason</th>
								<th class="tron-th">By</th>
								<th class="tron-th">Date</th>
							</tr>
						</thead>
						<tbody>
							{#each data.ticket.partsReplaced as part}
								<tr class="tron-tr">
									<td class="tron-td">{part.partNumber} — {part.partName}</td>
									<td class="tron-td font-mono text-[var(--color-tron-red)]">{part.oldLotNumber}</td>
									<td class="tron-td font-mono text-[var(--color-tron-green)]">{part.newLotNumber}</td>
									<td class="tron-td text-sm">{part.reason}</td>
									<td class="tron-td text-sm">{part.replacedBy}</td>
									<td class="tron-td text-sm text-[var(--color-tron-text-secondary)]">{new Date(part.replacedAt).toLocaleDateString()}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}

			{#if data.ticket.status !== 'resolved' && data.ticket.status !== 'closed'}
				<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
					<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Replace Part</h3>
					<form method="POST" action="?/replacePart" use:enhance class="grid grid-cols-2 gap-3">
						<div>
							<label for="spuPartId" class="tron-label">Part to Replace</label>
							<select id="spuPartId" name="spuPartId" class="tron-select" required>
								<option value="">Select part...</option>
								{#each data.spu.parts as part}
									<option value={part.id}>{part.partNumber} — {part.partName} (Lot: {part.lotNumber})</option>
								{/each}
							</select>
						</div>
						<div>
							<label for="newLotNumber" class="tron-label">New Lot Number</label>
							<input id="newLotNumber" name="newLotNumber" type="text" class="tron-input" required placeholder="Scan or enter new lot..." />
						</div>
						<div>
							<label for="newSerialNumber" class="tron-label">New Serial Number (optional)</label>
							<input id="newSerialNumber" name="newSerialNumber" type="text" class="tron-input" placeholder="Serial number..." />
						</div>
						<div>
							<label for="partReason" class="tron-label">Reason</label>
							<input id="partReason" name="reason" type="text" class="tron-input" required placeholder="Why is this part being replaced?" />
						</div>
						<div class="col-span-2">
							<button type="submit" class="tron-btn tron-btn-primary text-sm">Record Part Replacement</button>
						</div>
					</form>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Firmware Changes Section -->
	{#if activeSection === 'firmware'}
		<div class="space-y-4">
			{#if data.ticket.firmwareChanges.length > 0}
				<div class="overflow-x-auto">
					<table class="tron-table w-full">
						<thead>
							<tr>
								<th class="tron-th">Device Type</th>
								<th class="tron-th">Previous Version</th>
								<th class="tron-th">New Version</th>
								<th class="tron-th">Reason</th>
								<th class="tron-th">By</th>
								<th class="tron-th">Date</th>
							</tr>
						</thead>
						<tbody>
							{#each data.ticket.firmwareChanges as fw}
								<tr class="tron-tr">
									<td class="tron-td capitalize">{fw.deviceType}</td>
									<td class="tron-td font-mono text-[var(--color-tron-text-secondary)]">{fw.previousVersion || '—'}</td>
									<td class="tron-td font-mono text-[var(--color-tron-green)]">{fw.newVersion}</td>
									<td class="tron-td text-sm">{fw.reason}</td>
									<td class="tron-td text-sm">{fw.performedBy}</td>
									<td class="tron-td text-sm text-[var(--color-tron-text-secondary)]">{new Date(fw.performedAt).toLocaleDateString()}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}

			{#if data.ticket.status !== 'resolved' && data.ticket.status !== 'closed'}
				<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
					<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Record Firmware Change</h3>
					<form method="POST" action="?/recordFirmwareChange" use:enhance class="grid grid-cols-2 gap-3">
						<div>
							<label for="deviceType" class="tron-label">Device Type</label>
							<select id="deviceType" name="deviceType" class="tron-select" required>
								<option value="">Select type...</option>
								<option value="particle">Particle</option>
								<option value="cartridge">Cartridge</option>
								<option value="sensor">Sensor</option>
								<option value="other">Other</option>
							</select>
						</div>
						<div>
							<label for="previousVersion" class="tron-label">Previous Version (optional)</label>
							<input id="previousVersion" name="previousVersion" type="text" class="tron-input" placeholder="e.g., 1.2.3" />
						</div>
						<div>
							<label for="newVersion" class="tron-label">New Version</label>
							<input id="newVersion" name="newVersion" type="text" class="tron-input" required placeholder="e.g., 1.3.0" />
						</div>
						<div>
							<label for="fwReason" class="tron-label">Reason</label>
							<input id="fwReason" name="reason" type="text" class="tron-input" required placeholder="Why is firmware being updated?" />
						</div>
						<div class="col-span-2">
							<button type="submit" class="tron-btn tron-btn-primary text-sm">Record Firmware Change</button>
						</div>
					</form>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Other Changes Section -->
	{#if activeSection === 'other'}
		<div class="space-y-4">
			{#if data.ticket.otherChanges.length > 0}
				<div class="overflow-x-auto">
					<table class="tron-table w-full">
						<thead>
							<tr>
								<th class="tron-th">Category</th>
								<th class="tron-th">Description</th>
								<th class="tron-th">By</th>
								<th class="tron-th">Date</th>
							</tr>
						</thead>
						<tbody>
							{#each data.ticket.otherChanges as change}
								<tr class="tron-tr">
									<td class="tron-td capitalize">{change.category}</td>
									<td class="tron-td text-sm">{change.description}</td>
									<td class="tron-td text-sm">{change.performedBy}</td>
									<td class="tron-td text-sm text-[var(--color-tron-text-secondary)]">{new Date(change.performedAt).toLocaleDateString()}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}

			{#if data.ticket.status !== 'resolved' && data.ticket.status !== 'closed'}
				<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
					<h3 class="mb-3 text-sm font-semibold text-[var(--color-tron-text)]">Record Other Change</h3>
					<form method="POST" action="?/recordOtherChange" use:enhance class="grid grid-cols-2 gap-3">
						<div>
							<label for="category" class="tron-label">Category</label>
							<select id="category" name="category" class="tron-select" required>
								<option value="">Select category...</option>
								{#each categories as cat}
									<option value={cat}>{cat.charAt(0).toUpperCase() + cat.slice(1)}</option>
								{/each}
							</select>
						</div>
						<div>
							<label for="description" class="tron-label">Description</label>
							<textarea id="description" name="description" class="tron-input" rows="2" required placeholder="Describe the change..."></textarea>
						</div>
						<div class="col-span-2">
							<button type="submit" class="tron-btn tron-btn-primary text-sm">Record Change</button>
						</div>
					</form>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Notes Section -->
	{#if activeSection === 'notes'}
		<div class="space-y-4">
			{#if data.ticket.notes.length > 0}
				<div class="space-y-2">
					{#each data.ticket.notes as note}
						<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-3">
							<p class="text-sm text-[var(--color-tron-text)]">{note.text}</p>
							<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
								{note.addedBy} &middot; {new Date(note.addedAt).toLocaleString()}
							</p>
						</div>
					{/each}
				</div>
			{/if}

			<form method="POST" action="?/addNote" use:enhance class="flex gap-2">
				<textarea name="text" class="tron-input flex-1" rows="2" required placeholder="Add a note..."></textarea>
				<button type="submit" class="tron-btn tron-btn-primary self-end text-sm">Add Note</button>
			</form>
		</div>
	{/if}
</div>
