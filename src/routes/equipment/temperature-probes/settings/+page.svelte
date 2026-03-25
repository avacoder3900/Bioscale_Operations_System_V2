<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let sensors = $state(data.sensors.map((s: any) => ({ ...s, emailRecipientsStr: (s.emailRecipients ?? []).join(', ') })));
	let globalEmails = $state(data.globalEmailRecipients.join(', '));
	let saving = $state(false);
	let savingEmails = $state(false);
	let importing = $state(false);
	let message = $state('');
</script>

<svelte:head>
	<title>Temperature Probe Settings | Bioscale</title>
</svelte:head>

<div class="space-y-8">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<div class="flex items-center gap-3">
				<a
					href="/equipment/temperature-probes"
					class="text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)] transition-colors"
				>
					← Back to Probes
				</a>
			</div>
			<h1 class="mt-2 text-2xl font-bold text-[var(--color-tron-text)]">Temperature Alert Settings</h1>
			<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
				Configure thresholds, alerts, and email notifications for all sensors
			</p>
		</div>
		<form method="POST" action="?/importThresholds" use:enhance={() => {
			importing = true;
			return async ({ result, update }) => {
				importing = false;
				if (result.type === 'success') {
					message = `Imported thresholds for ${(result as any).data?.imported ?? 0} sensors`;
					await update();
					sensors = data.sensors.map((s: any) => ({ ...s }));
				}
			};
		}}>
			<button
				type="submit"
				disabled={importing}
				class="rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-4 py-2 text-sm font-medium text-[var(--color-tron-text)] hover:border-[var(--color-tron-cyan)] transition-colors disabled:opacity-50"
			>
				{importing ? 'Importing…' : 'Import Thresholds from Mocreo'}
			</button>
		</form>
	</div>

	{#if message}
		<div class="rounded-md border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/10 px-4 py-3 text-sm text-[var(--color-tron-cyan)]">
			{message}
		</div>
	{/if}

	{#if form?.success}
		<div class="rounded-md border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-400">
			Settings saved successfully.
		</div>
	{/if}

	{#if form?.error}
		<div class="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
			{form.error}
		</div>
	{/if}

	<!-- Email Notification Settings -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6">
		<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Email Notification Settings</h2>
		<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
			These email addresses receive alerts when any sensor goes out of range or loses connection.
		</p>
		<form method="POST" action="?/saveEmails" class="mt-4 flex gap-3" use:enhance={() => {
			savingEmails = true;
			return async ({ update }) => {
				savingEmails = false;
				await update();
			};
		}}>
			<input
				type="text"
				name="emailRecipients"
				bind:value={globalEmails}
				placeholder="email1@example.com, email2@example.com"
				class="flex-1 rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder-[var(--color-tron-text-secondary)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
			/>
			<button
				type="submit"
				disabled={savingEmails}
				class="rounded-md bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-black hover:bg-[var(--color-tron-cyan)]/80 transition-colors disabled:opacity-50"
			>
				{savingEmails ? 'Saving…' : 'Save Emails'}
			</button>
		</form>
	</div>

	<!-- Per-Sensor Settings Table -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] overflow-hidden">
		<div class="flex items-center justify-between border-b border-[var(--color-tron-border)] px-6 py-4">
			<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Per-Sensor Configuration</h2>
			<span class="text-sm text-[var(--color-tron-text-secondary)]">{sensors.length} sensors</span>
		</div>

		<div class="overflow-x-auto">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-[var(--color-tron-border)] text-left text-[var(--color-tron-text-secondary)]">
						<th class="px-4 py-3 font-medium">Sensor Name</th>
						<th class="px-4 py-3 font-medium">Current °C</th>
						<th class="px-4 py-3 font-medium">Battery</th>
						<th class="px-4 py-3 font-medium">Mapped Equipment</th>
						<th class="px-4 py-3 font-medium">Min °C</th>
						<th class="px-4 py-3 font-medium">Max °C</th>
						<th class="px-4 py-3 font-medium">Mocreo Thresholds</th>
						<th class="px-4 py-3 font-medium text-center">Alerts</th>
						<th class="px-4 py-3 font-medium">Per-Sensor Emails</th>
					</tr>
				</thead>
				<tbody>
					{#each sensors as sensor, i}
						<tr class="border-b border-[var(--color-tron-border)]/50 hover:bg-[var(--color-tron-bg)]/50">
							<td class="px-4 py-3">
								<div class="font-medium text-[var(--color-tron-text)]">{sensor.sensorName}</div>
								<div class="text-xs text-[var(--color-tron-text-secondary)]">{sensor.model}</div>
							</td>
							<td class="px-4 py-3 text-center">
								{#if sensor.currentTemp != null}
									<span class="font-mono text-sm font-bold {
										sensor.temperatureMinC != null && sensor.currentTemp < sensor.temperatureMinC ? 'text-blue-400' :
										sensor.temperatureMaxC != null && sensor.currentTemp > sensor.temperatureMaxC ? 'text-red-400' :
										'text-emerald-400'
									}">{sensor.currentTemp.toFixed(1)}°</span>
								{:else}
									<span class="text-xs text-[var(--color-tron-text-secondary)]">—</span>
								{/if}
							</td>
							<td class="px-4 py-3 text-center text-xs">
								{#if sensor.batteryLevel != null}
									<span class="{sensor.batteryLevel > 50 ? 'text-emerald-400' : sensor.batteryLevel > 20 ? 'text-amber-400' : 'text-red-400'}">{sensor.batteryLevel}%</span>
								{:else}
									<span class="text-[var(--color-tron-text-secondary)]">—</span>
								{/if}
							</td>
							<td class="px-4 py-3">
								<select
									bind:value={sensors[i].mappedEquipmentId}
									class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1.5 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
								>
									<option value={null}>-- None --</option>
									{#each data.equipment as eq}
										<option value={eq.id}>{eq.name} ({eq.equipmentType})</option>
									{/each}
								</select>
							</td>
							<td class="px-4 py-3">
								<input
									type="number"
									step="0.1"
									bind:value={sensors[i].temperatureMinC}
									placeholder="—"
									class="w-20 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1.5 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
								/>
							</td>
							<td class="px-4 py-3">
								<input
									type="number"
									step="0.1"
									bind:value={sensors[i].temperatureMaxC}
									placeholder="—"
									class="w-20 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1.5 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
								/>
							</td>
							<td class="px-4 py-3 text-xs text-[var(--color-tron-text-secondary)]">
								{#if sensor.mocreoThresholds?.min != null || sensor.mocreoThresholds?.max != null}
									{sensor.mocreoThresholds.min ?? '—'} / {sensor.mocreoThresholds.max ?? '—'}
								{:else}
									<span class="opacity-50">Not set</span>
								{/if}
							</td>
							<td class="px-4 py-3 text-center">
								<input
									type="checkbox"
									bind:checked={sensors[i].alertsEnabled}
									class="h-4 w-4 rounded border-[var(--color-tron-border)] accent-[var(--color-tron-cyan)]"
								/>
							</td>
							<td class="px-4 py-3">
								<input
									type="text"
									bind:value={sensors[i].emailRecipientsStr}
									placeholder="Override global"
									class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1.5 text-xs text-[var(--color-tron-text)] placeholder-[var(--color-tron-text-secondary)]/50 focus:border-[var(--color-tron-cyan)] focus:outline-none"
								/>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<div class="flex items-center justify-end border-t border-[var(--color-tron-border)] px-6 py-4">
			<form method="POST" action="?/saveAll" use:enhance={() => {
				saving = true;
				// Prepare sensors data with email arrays
				const prepared = sensors.map((s: any) => ({
					...s,
					emailRecipients: s.emailRecipientsStr
						? s.emailRecipientsStr.split(',').map((e: string) => e.trim()).filter(Boolean)
						: s.emailRecipients ?? []
				}));
				const input = document.querySelector('input[name="sensors"]') as HTMLInputElement;
				if (input) input.value = JSON.stringify(prepared);
				return async ({ update }) => {
					saving = false;
					await update();
				};
			}}>
				<input type="hidden" name="sensors" value="" />
				<button
					type="submit"
					disabled={saving}
					class="rounded-md bg-[var(--color-tron-cyan)] px-6 py-2.5 text-sm font-semibold text-black hover:bg-[var(--color-tron-cyan)]/80 transition-colors disabled:opacity-50"
				>
					{saving ? 'Saving…' : 'Save All Sensor Settings'}
				</button>
			</form>
		</div>
	</div>
</div>
