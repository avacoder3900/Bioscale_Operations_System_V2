<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';

	interface RejectionReason {
		id: string;
		code: string;
		label: string;
		sortOrder: number;
	}

	interface Props {
		data: {
			settings: {
				minOvenTimeMin: number;
				runDurationMin: number;
				removeDeckWarningMin: number;
				coolingWarningMin: number;
				deckLockoutMin: number;
				incubatorTempC: number;
				heaterTempC: number;
				waxPerDeckUl: number;
				tubeCapacityUl: number;
				waxPerCartridgeUl: number;
				cartridgesPerColumn: number;
			};
			rejectionReasons: RejectionReason[];
		};
		form: { success?: boolean; error?: string; errors?: Record<string, string> } | null;
	}

	let { data, form }: Props = $props();

	let saving = $state(false);
	let editingReasonId = $state<string | null>(null);
	let editLabel = $state('');
	let editSortOrder = $state(0);
	let showAddReason = $state(false);
	let newCode = $state('');
	let newLabel = $state('');
	let newSortOrder = $state(0);

	type SettingsKey = keyof Props['data']['settings'];

	interface FieldDef {
		key: SettingsKey;
		label: string;
		unit: string;
		min: number;
		max: number;
	}

	interface FieldGroup {
		group: string;
		items: FieldDef[];
	}

	const fields: FieldGroup[] = [
		{
			group: 'Time Parameters',
			items: [
				{ key: 'minOvenTimeMin', label: 'Min Oven Time', unit: 'min', min: 1, max: 1440 },
				{ key: 'runDurationMin', label: 'Run Duration', unit: 'min', min: 1, max: 120 },
				{ key: 'removeDeckWarningMin', label: 'Remove Deck Warning', unit: 'min', min: 1, max: 60 },
				{ key: 'coolingWarningMin', label: 'Cooling Warning', unit: 'min', min: 1, max: 120 },
				{ key: 'deckLockoutMin', label: 'Deck Lockout', unit: 'min', min: 1, max: 120 }
			]
		},
		{
			group: 'Temperature Parameters',
			items: [
				{ key: 'incubatorTempC', label: 'Incubator Temperature', unit: '°C', min: 20, max: 200 },
				{ key: 'heaterTempC', label: 'Heater Temperature', unit: '°C', min: 20, max: 200 }
			]
		},
		{
			group: 'Wax Parameters',
			items: [
				{ key: 'waxPerDeckUl', label: 'Wax Per Deck', unit: 'µL', min: 1, max: 10000 },
				{ key: 'tubeCapacityUl', label: 'Tube Capacity', unit: 'µL', min: 1, max: 50000 }
			]
		},
		{
			group: 'Incubator Tube Parameters',
			items: [
				{ key: 'waxPerCartridgeUl', label: 'Wax Per Cartridge', unit: 'µL', min: 1, max: 1000 },
				{ key: 'cartridgesPerColumn', label: 'Cartridges Per Column', unit: '', min: 1, max: 24 }
			]
		}
	];

	function startEditReason(reason: RejectionReason) {
		editingReasonId = reason.id;
		editLabel = reason.label;
		editSortOrder = reason.sortOrder;
	}

	function cancelEditReason() {
		editingReasonId = null;
	}
</script>

<div class="space-y-6">
	<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Wax Filling Settings</h1>

	{#if form?.success}
		<div
			class="rounded border border-green-500/30 bg-green-900/20 px-4 py-3 text-sm text-green-300"
		>
			Settings saved successfully.
		</div>
	{/if}

	{#if form?.error}
		<div class="rounded border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">
			{form.error}
		</div>
	{/if}

	<form
		method="POST"
		action="?/update"
		use:enhance={() => {
			saving = true;
			return async ({ update }) => {
				await update();
				saving = false;
			};
		}}
		class="space-y-8"
	>
		{#each fields as { group, items } (group)}
			<section
				class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5"
			>
				<h2 class="mb-4 text-lg font-medium text-[var(--color-tron-cyan)]">{group}</h2>
				<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{#each items as field (field.key)}
						{@const fieldError = form?.errors?.[field.key]}
						<label class="block">
							<span class="mb-1 block text-sm font-medium text-[var(--color-tron-text-secondary)]">
								{field.label}
								{#if field.unit}
									<span class="text-xs text-[var(--color-tron-text-secondary)]/60"
										>({field.unit})</span
									>
								{/if}
							</span>
							<input
								type="number"
								name={field.key}
								value={data.settings[field.key]}
								min={field.min}
								max={field.max}
								required
								class="min-h-[44px] w-full rounded border px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder-[var(--color-tron-text-secondary)] focus:outline-none {fieldError
									? 'border-red-500 bg-red-900/10 focus:border-red-400'
									: 'border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] focus:border-[var(--color-tron-cyan)]'}"
							/>
							{#if fieldError}
								<span class="mt-1 block text-xs text-red-400">{fieldError}</span>
							{/if}
						</label>
					{/each}
				</div>
			</section>
		{/each}

		<div class="flex items-center justify-end gap-3">
			<!-- eslint-disable svelte/no-navigation-without-resolve -->
			<a
				href={resolve('/manufacturing/wax-filling')}
				class="inline-flex min-h-[44px] items-center rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-text)]"
			>
				Cancel
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
			<button
				type="submit"
				disabled={saving}
				class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-6 py-2 text-sm font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)]/20 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{saving ? 'Saving...' : 'Save Settings'}
			</button>
		</div>
	</form>

	<!-- Wax Rejection Reasons -->
	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
		<h2 class="mb-4 text-lg font-medium text-[var(--color-tron-cyan)]">Wax Rejection Reasons</h2>

		<div class="overflow-x-auto">
			<table class="tron-table w-full text-sm">
				<thead>
					<tr>
						<th class="px-3 py-2 text-left text-[var(--color-tron-text-secondary)]">Code</th>
						<th class="px-3 py-2 text-left text-[var(--color-tron-text-secondary)]">Label</th>
						<th class="px-3 py-2 text-left text-[var(--color-tron-text-secondary)]">Sort Order</th>
						<th class="px-3 py-2 text-right text-[var(--color-tron-text-secondary)]">Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each data.rejectionReasons as reason (reason.id)}
						{#if editingReasonId === reason.id}
							<tr>
								<td colspan="4" class="px-3 py-2">
									<form method="POST" action="?/updateReason" use:enhance={() => { return async ({ update }) => { editingReasonId = null; await update(); }; }} class="flex items-end gap-3">
										<input type="hidden" name="codeId" value={reason.id} />
										<span class="font-mono text-[var(--color-tron-text)]">{reason.code}</span>
										<input type="text" name="label" bind:value={editLabel} class="tron-input flex-1 text-sm" />
										<input type="number" name="sortOrder" bind:value={editSortOrder} class="tron-input text-sm" style="width:80px" />
										<button type="submit" class="rounded border border-green-500/50 px-2 py-1 text-xs text-green-400 hover:bg-green-900/20">Save</button>
										<button type="button" onclick={cancelEditReason} class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">Cancel</button>
									</form>
								</td>
							</tr>
						{:else}
							<tr>
								<td class="px-3 py-2 font-mono text-[var(--color-tron-text)]">{reason.code}</td>
								<td class="px-3 py-2 text-[var(--color-tron-text)]">{reason.label}</td>
								<td class="px-3 py-2 text-[var(--color-tron-text)]">{reason.sortOrder}</td>
								<td class="px-3 py-2 text-right">
									<div class="flex justify-end gap-2">
										<button type="button" onclick={() => startEditReason(reason)} class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10">Edit</button>
										<form method="POST" action="?/deleteReason" use:enhance onsubmit={(e) => { if (!confirm('Delete this reason?')) e.preventDefault(); }}>
											<input type="hidden" name="codeId" value={reason.id} />
											<button type="submit" class="rounded border border-red-500/50 px-2 py-1 text-xs text-red-400 hover:bg-red-900/20">Delete</button>
										</form>
									</div>
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>

		{#if showAddReason}
			<form method="POST" action="?/createReason" use:enhance={() => { return async ({ update }) => { showAddReason = false; newCode = ''; newLabel = ''; newSortOrder = 0; await update(); }; }} class="mt-4 flex items-end gap-3 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-3">
				<label class="block">
					<span class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Code</span>
					<input type="text" name="code" bind:value={newCode} class="tron-input text-sm" placeholder="REJ-XX" required />
				</label>
				<label class="block flex-1">
					<span class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Label</span>
					<input type="text" name="label" bind:value={newLabel} class="tron-input text-sm" placeholder="Reason description" required />
				</label>
				<label class="block">
					<span class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Sort Order</span>
					<input type="number" name="sortOrder" bind:value={newSortOrder} class="tron-input text-sm" style="width:80px" />
				</label>
				<button type="submit" class="min-h-[44px] rounded border border-green-500/50 px-4 py-2 text-sm text-green-400 hover:bg-green-900/20">Add</button>
				<button type="button" onclick={() => { showAddReason = false; }} class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]">Cancel</button>
			</form>
		{:else}
			<button
				type="button"
				onclick={() => { showAddReason = true; }}
				class="mt-4 rounded border border-[var(--color-tron-cyan)]/50 px-4 py-2 text-sm text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10"
			>
				+ Add Reason
			</button>
		{/if}
	</section>
</div>
