<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	const NOTIFICATION_META: Record<string, { label: string; description: string }> = {
		temperatureAlerts: {
			label: 'Temperature Alerts',
			description: 'Mocreo probe readings out of range, or sensor lost connection.'
		},
		lowWaxBatch: {
			label: 'Low Wax Batch',
			description: 'A 15ml wax batch drops below the configured μL threshold.'
		},
		lowInventory: {
			label: 'Low Inventory',
			description: 'A part drops below the configured percent of its reorder quantity.'
		},
		runComplete: {
			label: 'Run Complete',
			description: 'A wax or reagent manufacturing run finishes successfully.'
		},
		runAborted: {
			label: 'Run Aborted',
			description: 'A wax or reagent manufacturing run is cancelled or aborted.'
		},
		equipmentOffline: {
			label: 'Equipment Offline',
			description: 'A fridge/oven sensor stops reporting (lost_connection alert).'
		},
		dailyDigest: {
			label: 'Daily Digest',
			description: 'Once-per-day roll-up of all alerts and events (sent at 8am UTC).'
		},
		adminEvents: {
			label: 'Admin Events',
			description: 'New user invites, permission changes, failed login attempts.'
		}
	};

	const NOTIFICATION_TYPES = Object.keys(NOTIFICATION_META);

	// Track current selections as Sets per type for easy toggling
	let selections = $state<Record<string, Set<string>>>(
		Object.fromEntries(
			NOTIFICATION_TYPES.map(t => [t, new Set<string>(data.settings[t as keyof typeof data.settings] as string[])])
		) as Record<string, Set<string>>
	);
	let enabledMap = $state<Record<string, boolean>>({ ...data.settings.enabled });
	let lowWaxUl = $state(data.settings.lowWaxBatchThresholdUl);
	let lowInvPct = $state(data.settings.lowInventoryPercentThreshold);
	let testEmail = $state('');
	let saving = $state(false);
	let testing = $state(false);

	function toggleUser(type: string, userId: string) {
		const current = selections[type];
		const next = new Set(current);
		if (next.has(userId)) next.delete(userId);
		else next.add(userId);
		selections = { ...selections, [type]: next };
	}
</script>

<div class="space-y-6">
	<div>
		<h1 class="text-xl font-semibold text-[var(--color-tron-text)]">Notification Settings</h1>
		<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
			Configure which team members receive each type of email notification. Recipients must have an email on their user account.
		</p>
	</div>

	{#if form?.success}
		<div class="rounded-lg border border-green-500/40 bg-green-900/20 p-3 text-sm text-green-300">{form.message}</div>
	{/if}
	{#if form?.testSuccess}
		<div class="rounded-lg border border-green-500/40 bg-green-900/20 p-3 text-sm text-green-300">{form.testSuccess}</div>
	{/if}
	{#if form?.testError}
		<div class="rounded-lg border border-red-500/40 bg-red-900/20 p-3 text-sm text-red-300">{form.testError}</div>
	{/if}
	{#if form?.previewSuccess}
		<div class="rounded-lg border border-green-500/40 bg-green-900/20 p-3 text-sm text-green-300">{form.previewSuccess}</div>
	{/if}
	{#if form?.previewError}
		<div class="rounded-lg border border-red-500/40 bg-red-900/20 p-3 text-sm text-red-300">{form.previewError}</div>
	{/if}

	<!-- Test email -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
		<h2 class="text-base font-semibold text-[var(--color-tron-text)]">Send test email</h2>
		<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">Verify the Resend integration is working.</p>
		<form
			method="POST"
			action="?/sendTest"
			use:enhance={() => {
				testing = true;
				return async ({ update }) => {
					await update();
					testing = false;
				};
			}}
			class="mt-3 flex gap-2"
		>
			<input
				type="email"
				name="email"
				bind:value={testEmail}
				placeholder="you@example.com"
				required
				class="tron-input flex-1"
			/>
			<button
				type="submit"
				disabled={testing}
				class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)] disabled:opacity-50"
			>
				{testing ? 'Sending…' : 'Send test'}
			</button>
		</form>
	</div>

	<!-- Preview alerts — see what each email looks like -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
		<h2 class="text-base font-semibold text-[var(--color-tron-text)]">Preview alert templates</h2>
		<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
			Send a dummy version of each alert email to yourself so you can see what operators will receive.
			Uses the email you entered above.
		</p>
		<div class="mt-3 grid gap-2 sm:grid-cols-2 md:grid-cols-3">
			{#each [
				{ type: 'temperatureAlert_high', label: 'High temp alert' },
				{ type: 'temperatureAlert_low', label: 'Low temp alert' },
				{ type: 'temperatureAlert_lost', label: 'Lost connection alert' },
				{ type: 'lowWaxBatch', label: 'Low wax batch' },
				{ type: 'lowInventory', label: 'Low inventory' },
				{ type: 'runComplete', label: 'Run completed' },
				{ type: 'runAborted', label: 'Run aborted' },
				{ type: 'adminEvent', label: 'Admin event' }
			] as preview (preview.type)}
				<form method="POST" action="?/previewAlert" use:enhance>
					<input type="hidden" name="alertType" value={preview.type} />
					<input type="hidden" name="email" value={testEmail} />
					<button
						type="submit"
						disabled={!testEmail}
						class="w-full min-h-[44px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-3 py-2 text-xs text-[var(--color-tron-text)] transition-colors hover:border-[var(--color-tron-cyan)]/40 hover:text-[var(--color-tron-cyan)] disabled:opacity-40"
					>
						{preview.label}
					</button>
				</form>
			{/each}
		</div>
		{#if !testEmail}
			<p class="mt-2 text-xs text-[var(--color-tron-yellow)]">Enter an email above to enable preview buttons.</p>
		{/if}
	</div>

	<!-- Main settings form -->
	<form
		method="POST"
		action="?/save"
		use:enhance={() => {
			saving = true;
			return async ({ update }) => {
				await update();
				saving = false;
			};
		}}
		class="space-y-4"
	>
		<!-- Thresholds -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
			<h2 class="text-base font-semibold text-[var(--color-tron-text)]">Thresholds</h2>
			<div class="mt-3 grid gap-4 md:grid-cols-2">
				<div>
					<label for="lowWax" class="tron-label">Low wax batch threshold (μL)</label>
					<input id="lowWax" type="number" name="lowWaxBatchThresholdUl" bind:value={lowWaxUl} min="0" class="tron-input" />
					<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">Warn when a WaxBatch drops below this remaining volume. Default 1600 (2 fills).</p>
				</div>
				<div>
					<label for="lowInv" class="tron-label">Low inventory threshold (%)</label>
					<input id="lowInv" type="number" name="lowInventoryPercentThreshold" bind:value={lowInvPct} min="0" class="tron-input" />
					<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">Warn when a part's inventory drops below this percent of its minimum order quantity. Default 20%.</p>
				</div>
			</div>
		</div>

		<!-- Per-type recipient selection -->
		{#each NOTIFICATION_TYPES as type (type)}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
				<div class="flex items-start justify-between gap-4">
					<div>
						<h2 class="text-base font-semibold text-[var(--color-tron-text)]">{NOTIFICATION_META[type].label}</h2>
						<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">{NOTIFICATION_META[type].description}</p>
					</div>
					<label class="flex items-center gap-2 text-xs text-[var(--color-tron-text-secondary)]">
						<input
							type="checkbox"
							name="enabled_{type}"
							checked={enabledMap[type]}
							onchange={(e) => (enabledMap = { ...enabledMap, [type]: (e.currentTarget as HTMLInputElement).checked })}
						/>
						Enabled
					</label>
				</div>

				{#if data.users.length === 0}
					<p class="mt-3 rounded border border-[var(--color-tron-yellow)]/30 bg-[var(--color-tron-yellow)]/5 p-3 text-xs text-[var(--color-tron-yellow)]">
						No active users with email addresses. Add team members in <a href="/admin/users" class="underline">User Management</a> first.
					</p>
				{:else}
					<div class="mt-3 grid gap-2 sm:grid-cols-2 md:grid-cols-3">
						{#each data.users as user (user.id)}
							<label class="flex cursor-pointer items-center gap-2 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-3 py-2 text-sm text-[var(--color-tron-text)] transition-colors hover:border-[var(--color-tron-cyan)]/40">
								<input
									type="checkbox"
									checked={selections[type].has(user.id)}
									onchange={() => toggleUser(type, user.id)}
								/>
								<div>
									<div class="font-medium">{user.displayName}</div>
									<div class="font-mono text-xs text-[var(--color-tron-text-secondary)]">{user.email}</div>
								</div>
							</label>
						{/each}
					</div>
				{/if}

				<!-- Hidden input stores the serialized user-id list for this type -->
				<input type="hidden" name={type} value={[...selections[type]].join(',')} />
			</div>
		{/each}

		<div class="flex justify-end">
			<button
				type="submit"
				disabled={saving}
				class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-3 text-sm font-semibold text-[var(--color-tron-cyan)] disabled:opacity-50"
			>
				{saving ? 'Saving…' : 'Save Notification Settings'}
			</button>
		</div>
	</form>
</div>
