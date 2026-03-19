<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let showAddForm = $state(false);
	let editingId = $state<string | null>(null);

	let newName = $state('');
	let newSide = $state('');
	let newIp = $state('');
	let newSerial = $state('');
	let newModel = $state('OT-2');
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Opentrons Robots</h2>
		<button
			type="button"
			onclick={() => { showAddForm = !showAddForm; }}
			class="min-h-[44px] rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/30"
		>
			{showAddForm ? 'Cancel' : '+ Add Robot'}
		</button>
	</div>

	{#if form?.error}
		<div class="rounded border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">{form.error}</div>
	{/if}

	{#if showAddForm}
		<form
			method="POST"
			action="?/addRobot"
			use:enhance={() => { return async ({ update }) => { showAddForm = false; newName = ''; newSide = ''; newIp = ''; newSerial = ''; newModel = 'OT-2'; await update(); }; }}
			class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-surface)] p-4 space-y-3"
		>
			<h3 class="text-sm font-semibold text-[var(--color-tron-cyan)]">New Robot</h3>
			<div class="grid gap-3 sm:grid-cols-2">
				<div>
					<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Name *</label>
					<input name="name" type="text" class="tron-input w-full" style="min-height: 44px" bind:value={newName} required placeholder="e.g., Robot 4" />
				</div>
				<div>
					<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Side / Position</label>
					<input name="robotSide" type="text" class="tron-input w-full" style="min-height: 44px" bind:value={newSide} placeholder="e.g., Left, Right" />
				</div>
				<div>
					<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">IP Address</label>
					<input name="ipAddress" type="text" class="tron-input w-full" style="min-height: 44px" bind:value={newIp} placeholder="e.g., 192.168.1.100" />
				</div>
				<div>
					<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Serial Number</label>
					<input name="serialNumber" type="text" class="tron-input w-full" style="min-height: 44px" bind:value={newSerial} placeholder="Serial #" />
				</div>
				<div>
					<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Model</label>
					<select name="model" class="tron-input w-full" style="min-height: 44px" bind:value={newModel}>
						<option value="OT-2">OT-2</option>
						<option value="Flex">Flex</option>
					</select>
				</div>
			</div>
			<button type="submit" class="min-h-[44px] rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-2 text-sm font-semibold text-[var(--color-tron-cyan)]">
				Add Robot
			</button>
		</form>
	{/if}

	{#if data.robots.length === 0}
		<p class="text-sm text-[var(--color-tron-text-secondary)]">No robots configured. Add one above.</p>
	{:else}
		<div class="space-y-3">
			{#each data.robots as robot (robot.id)}
				<div class="rounded-lg border {robot.isActive ? 'border-[var(--color-tron-border)]' : 'border-red-500/30 opacity-60'} bg-[var(--color-tron-surface)] p-4">
					{#if editingId === robot.id}
						<form
							method="POST"
							action="?/updateRobot"
							use:enhance={() => { return async ({ update }) => { editingId = null; await update(); }; }}
							class="space-y-3"
						>
							<input type="hidden" name="robotId" value={robot.id} />
							<div class="grid gap-3 sm:grid-cols-2">
								<div>
									<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Name *</label>
									<input name="name" type="text" class="tron-input w-full" style="min-height: 44px" value={robot.name} required />
								</div>
								<div>
									<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Side / Position</label>
									<input name="robotSide" type="text" class="tron-input w-full" style="min-height: 44px" value={robot.robotSide} />
								</div>
								<div>
									<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">IP Address</label>
									<input name="ipAddress" type="text" class="tron-input w-full" style="min-height: 44px" value={robot.ipAddress} />
								</div>
								<div>
									<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Serial Number</label>
									<input name="serialNumber" type="text" class="tron-input w-full" style="min-height: 44px" value={robot.serialNumber} />
								</div>
								<div>
									<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Model</label>
									<input name="model" type="text" class="tron-input w-full" style="min-height: 44px" value={robot.model} />
								</div>
							</div>
							<div class="flex gap-2">
								<button type="submit" class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)]">Save</button>
								<button type="button" onclick={() => { editingId = null; }} class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]">Cancel</button>
							</div>
						</form>
					{:else}
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-4">
								<div>
									<h3 class="text-base font-semibold text-[var(--color-tron-text)]">{robot.name}</h3>
									<div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--color-tron-text-secondary)]">
										{#if robot.model}
											<span class="rounded bg-[var(--color-tron-cyan)]/10 px-2 py-0.5 text-[var(--color-tron-cyan)]">{robot.model}</span>
										{/if}
										{#if robot.robotSide}
											<span>Side: {robot.robotSide}</span>
										{/if}
										{#if robot.ipAddress}
											<span class="font-mono">{robot.ipAddress}</span>
										{/if}
										{#if robot.serialNumber}
											<span>SN: {robot.serialNumber}</span>
										{/if}
										<span class="rounded px-1.5 py-0.5 {robot.isActive ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}">
											{robot.isActive ? 'Active' : 'Inactive'}
										</span>
									</div>
								</div>
							</div>
							<div class="flex items-center gap-2">
								<button
									type="button"
									onclick={() => { editingId = robot.id; }}
									class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
								>
									Edit
								</button>
								<form method="POST" action="?/toggleActive" use:enhance>
									<input type="hidden" name="robotId" value={robot.id} />
									<button
										type="submit"
										class="min-h-[44px] rounded border px-3 py-2 text-xs transition-colors {robot.isActive
											? 'border-amber-500/40 text-amber-400 hover:bg-amber-900/20'
											: 'border-green-500/40 text-green-400 hover:bg-green-900/20'}"
									>
										{robot.isActive ? 'Deactivate' : 'Activate'}
									</button>
								</form>
								<form method="POST" action="?/deleteRobot" use:enhance={() => { return async ({ update }) => { if (confirm('Delete this robot permanently?')) await update(); }; }}>
									<input type="hidden" name="robotId" value={robot.id} />
									<button
										type="submit"
										class="min-h-[44px] rounded border border-red-500/40 px-3 py-2 text-xs text-red-400 transition-colors hover:bg-red-900/20"
									>
										Delete
									</button>
								</form>
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
