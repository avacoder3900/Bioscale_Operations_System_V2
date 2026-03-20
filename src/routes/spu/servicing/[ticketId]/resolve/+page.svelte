<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	const totalWorkItems = $derived(
		data.ticket.partsReplaced.length +
		data.ticket.firmwareChanges.length +
		data.ticket.otherChanges.length
	);
</script>

<svelte:head>
	<title>Resolve Ticket — {data.ticket.spuUdi}</title>
</svelte:head>

<div class="mx-auto max-w-3xl space-y-6 p-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-[var(--color-tron-text)]">Resolve Service Ticket</h1>
		<a href="/spu/servicing/{data.ticket.id}" class="tron-btn tron-btn-ghost text-sm">Back to Ticket</a>
	</div>

	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
		<p class="text-sm text-[var(--color-tron-text-secondary)]">
			SPU: <span class="font-mono text-[var(--color-tron-cyan)]">{data.ticket.spuUdi}</span>
			&middot; Opened by {data.ticket.openedBy} on {new Date(data.ticket.openedAt).toLocaleDateString()}
		</p>
		{#if data.ticket.reason}
			<p class="mt-1 text-sm text-[var(--color-tron-text)]">Reason: {data.ticket.reason}</p>
		{/if}
	</div>

	<!-- Work Summary -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
		<h2 class="mb-3 text-lg font-semibold text-[var(--color-tron-text)]">Work Performed ({totalWorkItems} items)</h2>

		{#if data.ticket.partsReplaced.length > 0}
			<div class="mb-3">
				<h3 class="text-sm font-medium text-[var(--color-tron-text-secondary)]">Parts Replaced ({data.ticket.partsReplaced.length})</h3>
				<ul class="mt-1 space-y-1">
					{#each data.ticket.partsReplaced as part}
						<li class="text-sm text-[var(--color-tron-text)]">
							{part.partNumber} — {part.partName}: <span class="text-[var(--color-tron-red)]">{part.oldLotNumber}</span> → <span class="text-[var(--color-tron-green)]">{part.newLotNumber}</span>
							<span class="text-[var(--color-tron-text-secondary)]">({part.reason})</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if data.ticket.firmwareChanges.length > 0}
			<div class="mb-3">
				<h3 class="text-sm font-medium text-[var(--color-tron-text-secondary)]">Firmware Changes ({data.ticket.firmwareChanges.length})</h3>
				<ul class="mt-1 space-y-1">
					{#each data.ticket.firmwareChanges as fw}
						<li class="text-sm text-[var(--color-tron-text)]">
							<span class="capitalize">{fw.deviceType}</span>: {fw.previousVersion || '—'} → <span class="text-[var(--color-tron-green)]">{fw.newVersion}</span>
							<span class="text-[var(--color-tron-text-secondary)]">({fw.reason})</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if data.ticket.otherChanges.length > 0}
			<div class="mb-3">
				<h3 class="text-sm font-medium text-[var(--color-tron-text-secondary)]">Other Changes ({data.ticket.otherChanges.length})</h3>
				<ul class="mt-1 space-y-1">
					{#each data.ticket.otherChanges as change}
						<li class="text-sm text-[var(--color-tron-text)]">
							<span class="capitalize">{change.category}</span>: {change.description}
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if totalWorkItems === 0}
			<p class="text-sm text-[var(--color-tron-text-secondary)]">No work items recorded. Add a note explaining why if resolving without work.</p>
		{/if}
	</div>

	<!-- Resolution Form -->
	<form method="POST" action="?/resolve" use:enhance class="space-y-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
		<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Resolution</h2>

		{#if form?.error}
			<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
		{/if}

		<div>
			<label for="summary" class="tron-label">Resolution Summary</label>
			<textarea
				id="summary"
				name="summary"
				class="tron-input w-full"
				rows="3"
				required
				placeholder="Describe the resolution and outcome..."
			></textarea>
		</div>

		<div>
			<label for="returnStatus" class="tron-label">Return SPU to Status</label>
			<select id="returnStatus" name="returnStatus" class="tron-select" required>
				{#each data.returnStatuses as status}
					<option value={status} selected={status === data.ticket.previousSpuStatus}>
						{status}{status === data.ticket.previousSpuStatus ? ' (previous)' : ''}
					</option>
				{/each}
			</select>
			<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
				SPU was "{data.ticket.previousSpuStatus}" before entering servicing.
			</p>
		</div>

		<button type="submit" class="tron-btn tron-btn-primary">
			Resolve & Close Ticket
		</button>
	</form>
</div>
