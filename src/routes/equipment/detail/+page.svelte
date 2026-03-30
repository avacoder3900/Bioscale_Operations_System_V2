<script lang="ts">
	import { enhance } from '$app/forms';

	interface Equipment {
		id: string;
		name: string;
		equipmentType: string;
		status: string;
		location: string | null;
		notes: string | null;
		createdAt: string;
		updatedAt: string;
	}

	interface Event {
		id: string;
		equipmentId: string;
		equipmentType: string;
		eventType: string;
		relatedItemId: string | null;
		notes: string | null;
		operatorId: string | null;
		createdAt: string;
	}

	interface Props {
		data: { equipment: Equipment; events: Event[] };
		form: { success?: boolean; error?: string } | null;
	}

	let { data, form }: Props = $props();

	let showLogEvent = $state(false);
	let eventType = $state('');
	let eventNotes = $state('');
	let newStatus = $state(data.equipment.status);

	function statusBadge(status: string): string {
		switch (status) {
			case 'Active': case 'Online': return 'tron-badge tron-badge-success';
			case 'Maintenance': return 'tron-badge tron-badge-warning';
			case 'Offline': case 'Retired': return 'tron-badge tron-badge-error';
			default: return 'tron-badge tron-badge-neutral';
		}
	}
</script>

<div class="space-y-6">
	<a href="/equipment/activity" class="inline-flex items-center gap-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)] transition-colors">← Equipment Overview</a>
	<div class="flex items-center gap-3">
		<a href="/equipment/activity" class="text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">&larr; Back</a>
		<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">{data.equipment.name}</h1>
		<span class={statusBadge(data.equipment.status)}>{data.equipment.status}</span>
	</div>

	{#if form?.success}
		<div class="rounded border border-green-500/30 bg-green-900/20 px-4 py-3 text-sm text-green-300">Action completed.</div>
	{/if}
	{#if form?.error}
		<div class="rounded border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">{form.error}</div>
	{/if}

	<!-- Equipment info -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
		<div class="grid gap-4 sm:grid-cols-2">
			<div>
				<p class="text-xs text-[var(--color-tron-text-secondary)]">Type</p>
				<p class="text-sm text-[var(--color-tron-text)]">{data.equipment.equipmentType}</p>
			</div>
			{#if data.equipment.notes}
				<div>
					<p class="text-xs text-[var(--color-tron-text-secondary)]">Notes</p>
					<p class="text-sm text-[var(--color-tron-text)]">{data.equipment.notes}</p>
				</div>
			{/if}
			{#if data.equipment.location}
				<div>
					<p class="text-xs text-[var(--color-tron-text-secondary)]">Location</p>
					<p class="text-sm text-[var(--color-tron-text)]">{data.equipment.location}</p>
				</div>
			{/if}
			<div>
				<p class="text-xs text-[var(--color-tron-text-secondary)]">Registered</p>
				<p class="text-sm text-[var(--color-tron-text)]">{new Date(data.equipment.createdAt).toLocaleDateString()}</p>
			</div>
		</div>

		<!-- Status update -->
		<form method="POST" action="?/updateStatus" use:enhance class="mt-4 flex items-end gap-2 border-t border-[var(--color-tron-border)]/30 pt-4">
			<input type="hidden" name="id" value={data.equipment.id} />
			<label class="block flex-1">
				<span class="text-xs text-[var(--color-tron-text-secondary)]">Status</span>
				<select name="status" bind:value={newStatus} class="tron-select text-sm">
					<option value="Active">Active</option>
					<option value="Online">Online</option>
					<option value="Maintenance">Maintenance</option>
					<option value="Offline">Offline</option>
					<option value="Retired">Retired</option>
				</select>
			</label>
			<button type="submit" class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-2 text-sm text-[var(--color-tron-cyan)]">Update</button>
		</form>
	</div>

	<!-- Log event -->
	<div class="flex items-center justify-between">
		<h2 class="text-lg font-medium text-[var(--color-tron-cyan)]">Event Log</h2>
		<button
			type="button"
			onclick={() => { showLogEvent = !showLogEvent; }}
			class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 px-4 py-2 text-sm text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10"
		>
			{showLogEvent ? 'Cancel' : '+ Log Event'}
		</button>
	</div>

	{#if showLogEvent}
		<form method="POST" action="?/logEvent" use:enhance={() => { return async ({ update }) => { showLogEvent = false; eventType = ''; eventNotes = ''; await update(); }; }} class="flex gap-2 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<input type="hidden" name="equipmentId" value={data.equipment.id} />
			<input type="hidden" name="equipmentType" value={data.equipment.equipmentType} />
			<input type="text" name="eventType" bind:value={eventType} required class="tron-input" placeholder="Event type (e.g. Calibration)" style="width:200px" />
			<input type="text" name="notes" bind:value={eventNotes} class="tron-input flex-1" placeholder="Notes (optional)" />
			<button type="submit" class="tron-btn-primary">Log</button>
		</form>
	{/if}

	<!-- Events table -->
	{#if data.events.length > 0}
		<div class="space-y-2">
			{#each data.events as event (event.id)}
				<div class="flex items-center justify-between rounded border border-[var(--color-tron-border)]/50 bg-[var(--color-tron-surface)] px-4 py-2 text-sm">
					<div>
						<span class="font-medium text-[var(--color-tron-text)]">{event.eventType}</span>
						{#if event.relatedItemId}
							<span class="ml-2 text-xs text-[var(--color-tron-text-secondary)]">({event.relatedItemId})</span>
						{/if}
						{#if event.notes}
							<p class="mt-0.5 text-xs text-[var(--color-tron-text-secondary)]">
								{event.notes}
							</p>
						{/if}
					</div>
					<span class="text-xs text-[var(--color-tron-text-secondary)]">{new Date(event.createdAt).toLocaleString()}</span>
				</div>
			{/each}
		</div>
	{:else}
		<p class="text-sm text-[var(--color-tron-text-secondary)]">No events logged.</p>
	{/if}
</div>
